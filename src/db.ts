/**
 * SQLite database wrapper for the finance tracker extension.
 *
 * Uses sql.js (pure-WASM SQLite) so it works in restricted environments like
 * Termux/Android without needing a C toolchain. The DB is persisted to disk
 * after every mutating call (atomic write to a temp file + rename).
 *
 * Schema:
 *   wallets              1 ── n transactions
 *   categories           1 ── n transactions
 *   transactions         n ── n tags  (via transaction_tags)
 *
 * All money is stored as integer minor units (e.g. cents) plus a currency
 * code, so we never accumulate float drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js") as (opts?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

interface SqlJsStatic {
	Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}
interface SqlJsDatabase {
	run(sql: string, params?: SqlBindValue): void;
	exec(sql: string): SqlJsExecResult[];
	prepare(sql: string): SqlJsStatement;
	export(): Uint8Array;
	close(): void;
}
interface SqlJsExecResult {
	columns: string[];
	values: SqlJsRow[];
}
type SqlBindValue = string | number | null | Uint8Array | boolean;
type SqlJsRow = SqlBindValue[];
interface SqlJsStatement {
	bind(params?: SqlBindValue[]): void;
	step(): boolean;
	getAsObject(): Record<string, SqlBindValue>;
	reset(): void;
	free(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

export type TxType = "income" | "expense" | "transfer";

export interface Wallet {
	id: number;
	name: string;
	currency: string; // ISO 4217, e.g. "USD", "IDR"
	/** Opening balance in minor units (e.g. cents). Defaults to 0. */
	opening_minor: number;
	color: string;
	archived: 0 | 1;
	created_at: string;
}

export interface Category {
	id: number;
	name: string;
	/** "income" or "expense". Transfers ignore category. */
	kind: "income" | "expense";
	icon: string;
	color: string;
	created_at: string;
}

export interface Tag {
	id: number;
	name: string;
	color: string;
	created_at: string;
}

export interface Transaction {
	id: number;
	wallet_id: number;
	/** Optional. Null for transfers. */
	category_id: number | null;
	type: TxType;
	/** Amount in minor units. Always positive; sign comes from `type`. */
	amount_minor: number;
	currency: string;
	note: string;
	/** ISO 8601 date or datetime. */
	occurred_at: string;
	created_at: string;
	/** Populated by list/get queries. */
	tag_ids?: number[];
	tag_names?: string[];
}

export interface Summary {
	total_income_minor: number;
	total_expense_minor: number;
	net_minor: number;
	tx_count: number;
	wallet_count: number;
	category_count: number;
	tag_count: number;
	by_wallet: Array<{ wallet_id: number; wallet_name: string; balance_minor: number; currency: string }>;
	by_category: Array<{ category_id: number; category_name: string; total_minor: number; kind: "income" | "expense" }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL DDL — keep schema in one place for easy review
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wallets (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	name            TEXT NOT NULL,
	currency        TEXT NOT NULL DEFAULT 'USD',
	opening_minor   INTEGER NOT NULL DEFAULT 0,
	color           TEXT NOT NULL DEFAULT '#6366f1',
	archived        INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
	created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_name ON wallets(lower(name));

CREATE TABLE IF NOT EXISTS categories (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	name            TEXT NOT NULL,
	kind            TEXT NOT NULL CHECK (kind IN ('income','expense')),
	icon            TEXT NOT NULL DEFAULT '•',
	color           TEXT NOT NULL DEFAULT '#10b981',
	created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(lower(name), kind);

CREATE TABLE IF NOT EXISTS tags (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	name            TEXT NOT NULL,
	color           TEXT NOT NULL DEFAULT '#f59e0b',
	created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(lower(name));

CREATE TABLE IF NOT EXISTS transactions (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	wallet_id       INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
	category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
	type            TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
	amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
	currency        TEXT NOT NULL,
	note            TEXT NOT NULL DEFAULT '',
	occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
	created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at);

CREATE TABLE IF NOT EXISTS transaction_tags (
	transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
	tag_id          INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX IF NOT EXISTS tx_tags_tag ON transaction_tags(tag_id);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Database class
// ─────────────────────────────────────────────────────────────────────────────

export class FinanceDB {
	private db: SqlJsDatabase;
	private path: string;
	private dirty = false;

	private constructor(db: SqlJsDatabase, path: string) {
		this.db = db;
		this.path = path;
	}

	/** Open or create the database at `path`. Runs schema migrations on open. */
	static async open(path: string): Promise<FinanceDB> {
		mkdirSync(dirname(path), { recursive: true });
		const wasmDir = fileURLToPath(new URL("../node_modules/sql.js/dist/", import.meta.url));
		const SQL = await initSqlJs({
			locateFile: (file) => resolve(wasmDir, file),
		});
		const initialised = existsSync(path) ? readFileSync(path) : undefined;
		const db = new SQL.Database(initialised);
		const inst = new FinanceDB(db, path);
		db.exec(SCHEMA);
		inst.flush();
		return inst;
	}

	// ── persistence ───────────────────────────────────────────────────────

	/** Mark the DB as having pending writes. Cheap; flushes in batch. */
	private touch(): void {
		this.dirty = true;
	}

	/** Atomically write the DB to disk if there are pending changes. */
	flush(): void {
		if (!this.dirty && existsSync(this.path)) return;
		const data = this.db.export();
		const tmp = `${this.path}.tmp`;
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.path);
		this.dirty = false;
	}

	close(): void {
		this.flush();
		this.db.close();
	}

	// ── internal helpers ──────────────────────────────────────────────────

	private all<T>(sql: string, params: SqlBindValue[] = []): T[] {
		const stmt = this.db.prepare(sql);
		try {
			stmt.bind(params);
			const rows: T[] = [];
			while (stmt.step()) rows.push(stmt.getAsObject() as T);
			return rows;
		} finally {
			stmt.free();
		}
	}

	private get<T>(sql: string, params: SqlBindValue[] = []): T | undefined {
		const rows = this.all<T>(sql, params);
		return rows[0];
	}

	private run(sql: string, params: SqlBindValue[] = []): { lastInsertRowid: number; changes: number } {
		const stmt = this.db.prepare(sql);
		try {
			stmt.bind(params);
			stmt.step();
			// sql.js exposes last_insert_rowid via a separate exec — we read it from changes
			const idRow = this.db.exec("SELECT last_insert_rowid() AS id, changes() AS c")[0];
			const id = (idRow?.values?.[0]?.[0] as number) ?? 0;
			const changes = (idRow?.values?.[0]?.[1] as number) ?? 0;
			return { lastInsertRowid: id, changes };
		} finally {
			stmt.free();
		}
	}

	// ── wallets ───────────────────────────────────────────────────────────

	listWallets(includeArchived = false): Wallet[] {
		const sql = includeArchived
			? "SELECT * FROM wallets ORDER BY archived ASC, name COLLATE NOCASE"
			: "SELECT * FROM wallets WHERE archived = 0 ORDER BY name COLLATE NOCASE";
		return this.all<Wallet>(sql);
	}

	getWallet(id: number): Wallet | undefined {
		return this.get<Wallet>("SELECT * FROM wallets WHERE id = ?", [id]);
	}

	createWallet(input: Omit<Wallet, "id" | "created_at" | "archived"> & { archived?: 0 | 1 }): Wallet {
		const r = this.run(
			`INSERT INTO wallets (name, currency, opening_minor, color, archived)
			 VALUES (?, ?, ?, ?, ?)`,
			[input.name, input.currency, input.opening_minor ?? 0, input.color ?? "#6366f1", input.archived ?? 0],
		);
		this.touch();
		const created = this.getWallet(r.lastInsertRowid);
		if (!created) throw new Error("wallet_insert_failed");
		return created;
	}

	updateWallet(
		id: number,
		patch: Partial<Pick<Wallet, "name" | "currency" | "opening_minor" | "color" | "archived">>,
	): Wallet | undefined {
		const fields: string[] = [];
		const values: SqlBindValue[] = [];
		for (const k of ["name", "currency", "opening_minor", "color", "archived"] as const) {
			if (patch[k] !== undefined) {
				fields.push(`${k} = ?`);
				values.push(patch[k] as SqlBindValue);
			}
		}
		if (fields.length === 0) return this.getWallet(id);
		values.push(id);
		this.run(`UPDATE wallets SET ${fields.join(", ")} WHERE id = ?`, values);
		this.touch();
		return this.getWallet(id);
	}

	deleteWallet(id: number): boolean {
		const txCount = this.get<{ c: number }>("SELECT COUNT(*) AS c FROM transactions WHERE wallet_id = ?", [id]);
		if (txCount && txCount.c > 0) {
			throw new Error(
				`wallet_in_use: wallet #${id} still has ${txCount.c} transaction(s); delete or reassign them first`,
			);
		}
		const r = this.run("DELETE FROM wallets WHERE id = ?", [id]);
		this.touch();
		return r.changes > 0;
	}

	// ── categories ────────────────────────────────────────────────────────

	listCategories(kind?: "income" | "expense"): Category[] {
		const sql = kind
			? "SELECT * FROM categories WHERE kind = ? ORDER BY name COLLATE NOCASE"
			: "SELECT * FROM categories ORDER BY kind, name COLLATE NOCASE";
		return this.all<Category>(sql, kind ? [kind] : []);
	}

	getCategory(id: number): Category | undefined {
		return this.get<Category>("SELECT * FROM categories WHERE id = ?", [id]);
	}

	createCategory(input: Omit<Category, "id" | "created_at">): Category {
		const r = this.run(
			`INSERT INTO categories (name, kind, icon, color) VALUES (?, ?, ?, ?)`,
			[input.name, input.kind, input.icon ?? "•", input.color ?? "#10b981"],
		);
		this.touch();
		const created = this.getCategory(r.lastInsertRowid);
		if (!created) throw new Error("category_insert_failed");
		return created;
	}

	updateCategory(id: number, patch: Partial<Pick<Category, "name" | "kind" | "icon" | "color">>): Category | undefined {
		const fields: string[] = [];
		const values: SqlBindValue[] = [];
		for (const k of ["name", "kind", "icon", "color"] as const) {
			if (patch[k] !== undefined) {
				fields.push(`${k} = ?`);
				values.push(patch[k] as SqlBindValue);
			}
		}
		if (fields.length === 0) return this.getCategory(id);
		values.push(id);
		this.run(`UPDATE categories SET ${fields.join(", ")} WHERE id = ?`, values);
		this.touch();
		return this.getCategory(id);
	}

	deleteCategory(id: number): boolean {
		// ON DELETE SET NULL handles transactions that referenced it
		const r = this.run("DELETE FROM categories WHERE id = ?", [id]);
		this.touch();
		return r.changes > 0;
	}

	// ── tags ──────────────────────────────────────────────────────────────

	listTags(): Tag[] {
		return this.all<Tag>("SELECT * FROM tags ORDER BY name COLLATE NOCASE");
	}

	getTag(id: number): Tag | undefined {
		return this.get<Tag>("SELECT * FROM tags WHERE id = ?", [id]);
	}

	createTag(input: Omit<Tag, "id" | "created_at">): Tag {
		const r = this.run("INSERT INTO tags (name, color) VALUES (?, ?)", [input.name, input.color ?? "#f59e0b"]);
		this.touch();
		const created = this.getTag(r.lastInsertRowid);
		if (!created) throw new Error("tag_insert_failed");
		return created;
	}

	updateTag(id: number, patch: Partial<Pick<Tag, "name" | "color">>): Tag | undefined {
		const fields: string[] = [];
		const values: SqlBindValue[] = [];
		for (const k of ["name", "color"] as const) {
			if (patch[k] !== undefined) {
				fields.push(`${k} = ?`);
				values.push(patch[k] as SqlBindValue);
			}
		}
		if (fields.length === 0) return this.getTag(id);
		values.push(id);
		this.run(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`, values);
		this.touch();
		return this.getTag(id);
	}

	deleteTag(id: number): boolean {
		const r = this.run("DELETE FROM tags WHERE id = ?", [id]);
		this.touch();
		return r.changes > 0;
	}

	// ── transactions ─────────────────────────────────────────────────────

	listTransactions(opts: {
		walletId?: number;
		categoryId?: number;
		tagId?: number;
		type?: TxType;
		from?: string;
		to?: string;
		limit?: number;
	} = {}): Transaction[] {
		const where: string[] = [];
		const params: SqlBindValue[] = [];
		if (opts.walletId !== undefined) {
			where.push("t.wallet_id = ?");
			params.push(opts.walletId);
		}
		if (opts.categoryId !== undefined) {
			where.push("t.category_id = ?");
			params.push(opts.categoryId);
		}
		if (opts.type) {
			where.push("t.type = ?");
			params.push(opts.type);
		}
		if (opts.from) {
			where.push("t.occurred_at >= ?");
			params.push(opts.from);
		}
		if (opts.to) {
			where.push("t.occurred_at <= ?");
			params.push(opts.to);
		}
		if (opts.tagId !== undefined) {
			where.push(
				"t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ?)",
			);
			params.push(opts.tagId);
		}
		const sql = `
			SELECT t.*,
			       GROUP_CONCAT(tt.tag_id)        AS tag_ids_csv,
			       GROUP_CONCAT(tg.name, '|')     AS tag_names_csv
			FROM transactions t
			LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
			LEFT JOIN tags tg             ON tg.id = tt.tag_id
			${where.length ? "WHERE " + where.join(" AND ") : ""}
			GROUP BY t.id
			ORDER BY t.occurred_at DESC, t.id DESC
			LIMIT ?`;
		params.push(opts.limit && opts.limit > 0 ? Math.min(opts.limit, 1000) : 200);
		const rows = this.all<Transaction & { tag_ids_csv: string | null; tag_names_csv: string | null }>(sql, params);
		return rows.map((r) => {
			const { tag_ids_csv, tag_names_csv, ...rest } = r;
			return {
				...rest,
				tag_ids: tag_ids_csv ? tag_ids_csv.split(",").map((s) => Number(s)) : [],
				tag_names: tag_names_csv ? tag_names_csv.split("|") : [],
			};
		});
	}

	getTransaction(id: number): Transaction | undefined {
		const all = this.all<Transaction & { tag_ids_csv: string | null; tag_names_csv: string | null }>(
			`SELECT t.*,
			        GROUP_CONCAT(tt.tag_id)    AS tag_ids_csv,
			        GROUP_CONCAT(tg.name, '|') AS tag_names_csv
			 FROM transactions t
			 LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
			 LEFT JOIN tags tg             ON tg.id = tt.tag_id
			 WHERE t.id = ?
			 GROUP BY t.id`,
			[id],
		);
		if (all.length === 0) return undefined;
		const r = all[0];
		const { tag_ids_csv, tag_names_csv, ...rest } = r;
		return {
			...rest,
			tag_ids: tag_ids_csv ? tag_ids_csv.split(",").map((s) => Number(s)) : [],
			tag_names: tag_names_csv ? tag_names_csv.split("|") : [],
		};
	}

	createTransaction(input: {
		wallet_id: number;
		category_id: number | null;
		type: TxType;
		amount_minor: number;
		currency: string;
		note?: string;
		occurred_at?: string;
		tag_ids?: number[];
	}): Transaction {
		if (input.amount_minor < 0) throw new Error("amount_negative");
		if (!Number.isInteger(input.amount_minor)) throw new Error("amount_not_integer_minor_units");
		const wallet = this.getWallet(input.wallet_id);
		if (!wallet) throw new Error(`wallet_not_found: ${input.wallet_id}`);
		if (input.type === "transfer" && input.category_id != null) {
			throw new Error("transfer_cannot_have_category");
		}
		if (input.type !== "transfer" && input.category_id != null) {
			const cat = this.getCategory(input.category_id);
			if (!cat) throw new Error(`category_not_found: ${input.category_id}`);
		}
		const r = this.run(
			`INSERT INTO transactions (wallet_id, category_id, type, amount_minor, currency, note, occurred_at)
			 VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
			[
				input.wallet_id,
				input.category_id,
				input.type,
				input.amount_minor,
				input.currency,
				input.note ?? "",
				input.occurred_at ?? null,
			],
		);
		const txId = r.lastInsertRowid;
		if (input.tag_ids && input.tag_ids.length > 0) {
			this.setTransactionTags(txId, input.tag_ids);
		}
		this.touch();
		const created = this.getTransaction(txId);
		if (!created) throw new Error("transaction_insert_failed");
		return created;
	}

	updateTransaction(
		id: number,
		patch: Partial<{
			wallet_id: number;
			category_id: number | null;
			type: TxType;
			amount_minor: number;
			currency: string;
			note: string;
			occurred_at: string;
			tag_ids: number[];
		}>,
	): Transaction | undefined {
		const existing = this.getTransaction(id);
		if (!existing) return undefined;
		const merged = { ...existing, ...patch };
		if (merged.type === "transfer" && merged.category_id != null) {
			throw new Error("transfer_cannot_have_category");
		}
		this.run(
			`UPDATE transactions
			 SET wallet_id = ?, category_id = ?, type = ?, amount_minor = ?,
			     currency = ?, note = ?, occurred_at = ?
			 WHERE id = ?`,
			[
				merged.wallet_id,
				merged.category_id,
				merged.type,
				merged.amount_minor,
				merged.currency,
				merged.note ?? "",
				merged.occurred_at,
				id,
			],
		);
		if (patch.tag_ids !== undefined) {
			this.setTransactionTags(id, patch.tag_ids);
		}
		this.touch();
		return this.getTransaction(id);
	}

	deleteTransaction(id: number): boolean {
		const r = this.run("DELETE FROM transactions WHERE id = ?", [id]);
		this.touch();
		return r.changes > 0;
	}

	private setTransactionTags(txId: number, tagIds: number[]): void {
		this.run("DELETE FROM transaction_tags WHERE transaction_id = ?", [txId]);
		const unique = Array.from(new Set(tagIds.filter((x) => Number.isInteger(x) && x > 0)));
		for (const tagId of unique) {
			this.run("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)", [txId, tagId]);
		}
	}

	// ── summary / dashboard ──────────────────────────────────────────────

	summary(): Summary {
		const totals = this.get<{ income: number; expense: number; count: number }>(
			`SELECT
			   COALESCE(SUM(CASE WHEN type = 'income'  THEN amount_minor ELSE 0 END), 0) AS income,
			   COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expense,
			   COUNT(*) AS count
			 FROM transactions`,
		) ?? { income: 0, expense: 0, count: 0 };

		const counts = this.get<{ wallets: number; categories: number; tags: number }>(
			`SELECT
			   (SELECT COUNT(*) FROM wallets)              AS wallets,
			   (SELECT COUNT(*) FROM categories)           AS categories,
			   (SELECT COUNT(*) FROM tags)                 AS tags`,
		) ?? { wallets: 0, categories: 0, tags: 0 };

		const byWallet = this.all<{
			wallet_id: number;
			wallet_name: string;
			balance_minor: number;
			currency: string;
		}>(`
			SELECT w.id AS wallet_id, w.name AS wallet_name, w.currency,
			       w.opening_minor
			       + COALESCE((SELECT SUM(CASE WHEN t.type = 'income'  THEN  t.amount_minor ELSE 0 END) FROM transactions t WHERE t.wallet_id = w.id), 0)
			       - COALESCE((SELECT SUM(CASE WHEN t.type = 'expense' THEN  t.amount_minor ELSE 0 END) FROM transactions t WHERE t.wallet_id = w.id), 0)
			       AS balance_minor
			FROM wallets w
			WHERE w.archived = 0
			ORDER BY w.name COLLATE NOCASE
		`);

		const byCategory = this.all<{
			category_id: number;
			category_name: string;
			total_minor: number;
			kind: "income" | "expense";
		}>(`
			SELECT c.id AS category_id, c.name AS category_name, c.kind,
			       COALESCE(SUM(t.amount_minor), 0) AS total_minor
			FROM categories c
			LEFT JOIN transactions t ON t.category_id = c.id
			GROUP BY c.id
			ORDER BY total_minor DESC
		`);

		return {
			total_income_minor: totals.income,
			total_expense_minor: totals.expense,
			net_minor: totals.income - totals.expense,
			tx_count: totals.count,
			wallet_count: counts.wallets,
			category_count: counts.categories,
			tag_count: counts.tags,
			by_wallet: byWallet,
			by_category: byCategory,
		};
	}
}
