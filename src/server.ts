/**
 * Tiny HTTP server for the finance tracker web UI.
 *
 * - Serves the static SPA from `src/ui/`
 * - Exposes a small REST API for CRUD on wallets, categories, tags, transactions
 * - Same-process server, no external deps. Uses Node's built-in `http` module.
 * - `unref()`s the socket so it never blocks pi shutdown on its own.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FinanceDB, Wallet, Category, Tag, Transaction, TxType } from "./db.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: unknown) => void;

interface Route {
	method: string;
	pattern: RegExp;
	paramNames: string[];
	handler: Handler;
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		const limit = 1024 * 1024; // 1 MB
		req.on("data", (c: Buffer) => {
			total += c.length;
			if (total > limit) {
				reject(new Error("payload_too_large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (e) {
				reject(new Error("invalid_json"));
			}
		});
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json),
		"cache-control": "no-store",
	});
	res.end(json);
}

function sendError(res: ServerResponse, status: number, message: string, code?: string): void {
	send(res, status, { error: message, code });
}

function buildRoutes(db: FinanceDB): Route[] {
	const R = (method: string, path: string, handler: Handler): Route => {
		const paramNames: string[] = [];
		const re = new RegExp(
			"^" +
				path.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, (m) => {
					paramNames.push(m.slice(1));
					return "([^/]+)";
				}) +
				"/?$",
		);
		return { method, pattern: re, paramNames, handler };
	};

	// Validation helpers ────────────────────────────────────────────────────
	const requireString = (obj: Record<string, unknown>, key: string, max = 200): string => {
		const v = obj[key];
		if (typeof v !== "string" || v.length === 0 || v.length > max) {
			throw new Error(`invalid_${key}: must be 1..${max} chars`);
		}
		return v;
	};
	const optionalString = (obj: Record<string, unknown>, key: string, max = 200): string | undefined => {
		const v = obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string") throw new Error(`invalid_${key}: must be string`);
		if (v.length > max) throw new Error(`invalid_${key}: max ${max} chars`);
		return v;
	};
	const requireInt = (obj: Record<string, unknown>, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
		const v = obj[key];
		if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
			throw new Error(`invalid_${key}: must be integer in [${min}, ${max}]`);
		}
		return v;
	};
	const optionalInt = (obj: Record<string, unknown>, key: string, min = 0): number | undefined => {
		const v = obj[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
			throw new Error(`invalid_${key}: must be integer >= ${min}`);
		}
		return v;
	};
	const requireTxType = (obj: Record<string, unknown>): TxType => {
		const v = obj.type;
		if (v !== "income" && v !== "expense" && v !== "transfer") {
			throw new Error("invalid_type: must be income|expense|transfer");
		}
		return v;
	};
	const requireCategoryKind = (obj: Record<string, unknown>): "income" | "expense" => {
		const v = obj.kind;
		if (v !== "income" && v !== "expense") {
			throw new Error("invalid_kind: must be income|expense");
		}
		return v;
	};

	return [
		// health & summary ───────────────────────────────────────────────────
		R("GET", "/api/health", (_req, res) => send(res, 200, { ok: true, ts: new Date().toISOString() })),
		R("GET", "/api/summary", (_req, res) => send(res, 200, db.summary())),

		// wallets ───────────────────────────────────────────────────────────
		R("GET", "/api/wallets", (_req, res) => send(res, 200, db.listWallets(true))),
		R("POST", "/api/wallets", (_req, res, _p, body) => {
			const b = body as Record<string, unknown>;
			const w = db.createWallet({
				name: requireString(b, "name", 80),
				currency: requireString(b, "currency", 8).toUpperCase(),
				opening_minor: optionalInt(b, "opening_minor", 0) ?? 0,
				color: optionalString(b, "color", 16) ?? "#6366f1",
			});
			send(res, 201, w);
		}),
		R("PUT", "/api/wallets/:id", (_req, res, p, body) => {
			const id = Number(p.id);
			const b = body as Record<string, unknown>;
			const patch: Partial<Wallet> = {};
			if (b.name !== undefined) patch.name = requireString(b, "name", 80);
			if (b.currency !== undefined) patch.currency = requireString(b, "currency", 8).toUpperCase();
			if (b.opening_minor !== undefined) patch.opening_minor = requireInt(b, "opening_minor", 0);
			if (b.color !== undefined) patch.color = optionalString(b, "color", 16) ?? "#6366f1";
			if (b.archived !== undefined) patch.archived = b.archived ? 1 : 0;
			const w = db.updateWallet(id, patch);
			if (!w) return sendError(res, 404, "wallet not found");
			send(res, 200, w);
		}),
		R("DELETE", "/api/wallets/:id", (_req, res, p) => {
			const id = Number(p.id);
			try {
				const ok = db.deleteWallet(id);
				if (!ok) return sendError(res, 404, "wallet not found");
				send(res, 200, { ok: true });
			} catch (e) {
				sendError(res, 409, (e as Error).message, (e as Error).message.split(":")[0]);
			}
		}),

		// categories ────────────────────────────────────────────────────────
		R("GET", "/api/categories", (_req, res) => send(res, 200, db.listCategories())),
		R("POST", "/api/categories", (_req, res, _p, body) => {
			const b = body as Record<string, unknown>;
			const c = db.createCategory({
				name: requireString(b, "name", 80),
				kind: requireCategoryKind(b),
				icon: optionalString(b, "icon", 8) ?? "•",
				color: optionalString(b, "color", 16) ?? "#10b981",
			});
			send(res, 201, c);
		}),
		R("PUT", "/api/categories/:id", (_req, res, p, body) => {
			const id = Number(p.id);
			const b = body as Record<string, unknown>;
			const patch: Partial<Category> = {};
			if (b.name !== undefined) patch.name = requireString(b, "name", 80);
			if (b.kind !== undefined) patch.kind = requireCategoryKind(b);
			if (b.icon !== undefined) patch.icon = optionalString(b, "icon", 8) ?? "•";
			if (b.color !== undefined) patch.color = optionalString(b, "color", 16) ?? "#10b981";
			const c = db.updateCategory(id, patch);
			if (!c) return sendError(res, 404, "category not found");
			send(res, 200, c);
		}),
		R("DELETE", "/api/categories/:id", (_req, res, p) => {
			const id = Number(p.id);
			const ok = db.deleteCategory(id);
			if (!ok) return sendError(res, 404, "category not found");
			send(res, 200, { ok: true });
		}),

		// tags ──────────────────────────────────────────────────────────────
		R("GET", "/api/tags", (_req, res) => send(res, 200, db.listTags())),
		R("POST", "/api/tags", (_req, res, _p, body) => {
			const b = body as Record<string, unknown>;
			const t = db.createTag({
				name: requireString(b, "name", 60),
				color: optionalString(b, "color", 16) ?? "#f59e0b",
			});
			send(res, 201, t);
		}),
		R("PUT", "/api/tags/:id", (_req, res, p, body) => {
			const id = Number(p.id);
			const b = body as Record<string, unknown>;
			const patch: Partial<Tag> = {};
			if (b.name !== undefined) patch.name = requireString(b, "name", 60);
			if (b.color !== undefined) patch.color = optionalString(b, "color", 16) ?? "#f59e0b";
			const t = db.updateTag(id, patch);
			if (!t) return sendError(res, 404, "tag not found");
			send(res, 200, t);
		}),
		R("DELETE", "/api/tags/:id", (_req, res, p) => {
			const id = Number(p.id);
			const ok = db.deleteTag(id);
			if (!ok) return sendError(res, 404, "tag not found");
			send(res, 200, { ok: true });
		}),

		// transactions ──────────────────────────────────────────────────────
		R("GET", "/api/transactions", (req, res) => {
			const u = new URL(req.url ?? "/", "http://localhost");
			const opts: Parameters<FinanceDB["listTransactions"]>[0] = {};
			const w = u.searchParams.get("wallet_id");
			if (w) opts.walletId = Number(w);
			const c = u.searchParams.get("category_id");
			if (c) opts.categoryId = Number(c);
			const t = u.searchParams.get("tag_id");
			if (t) opts.tagId = Number(t);
			const ty = u.searchParams.get("type");
			if (ty === "income" || ty === "expense" || ty === "transfer") opts.type = ty;
			const from = u.searchParams.get("from");
			if (from) opts.from = from;
			const to = u.searchParams.get("to");
			if (to) opts.to = to;
			const limit = u.searchParams.get("limit");
			if (limit) opts.limit = Number(limit);
			send(res, 200, db.listTransactions(opts));
		}),
		R("GET", "/api/transactions/:id", (_req, res, p) => {
			const id = Number(p.id);
			const tx = db.getTransaction(id);
			if (!tx) return sendError(res, 404, "transaction not found");
			send(res, 200, tx);
		}),
		R("POST", "/api/transactions", (_req, res, _p, body) => {
			const b = body as Record<string, unknown>;
			const tagIdsRaw = b.tag_ids;
			const tag_ids: number[] | undefined = Array.isArray(tagIdsRaw)
				? tagIdsRaw.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
				: undefined;
			try {
				const tx = db.createTransaction({
					wallet_id: requireInt(b, "wallet_id", 1),
					category_id: b.category_id === null || b.category_id === undefined ? null : requireInt(b, "category_id", 1),
					type: requireTxType(b),
					amount_minor: requireInt(b, "amount_minor", 0),
					currency: requireString(b, "currency", 8).toUpperCase(),
					note: optionalString(b, "note", 500) ?? "",
					occurred_at: optionalString(b, "occurred_at", 40),
					tag_ids,
				});
				send(res, 201, tx);
			} catch (e) {
				const msg = (e as Error).message;
				const code = msg.split(":")[0];
				sendError(res, 400, msg, code);
			}
		}),
		R("PUT", "/api/transactions/:id", (_req, res, p, body) => {
			const id = Number(p.id);
			const b = body as Record<string, unknown>;
			const patch: Parameters<FinanceDB["updateTransaction"]>[1] = {};
			if (b.wallet_id !== undefined) patch.wallet_id = requireInt(b, "wallet_id", 1);
			if (b.category_id !== undefined) {
				patch.category_id = b.category_id === null ? null : requireInt(b, "category_id", 1);
			}
			if (b.type !== undefined) patch.type = requireTxType(b);
			if (b.amount_minor !== undefined) patch.amount_minor = requireInt(b, "amount_minor", 0);
			if (b.currency !== undefined) patch.currency = requireString(b, "currency", 8).toUpperCase();
			if (b.note !== undefined) patch.note = optionalString(b, "note", 500) ?? "";
			if (b.occurred_at !== undefined) patch.occurred_at = requireString(b, "occurred_at", 40);
			if (b.tag_ids !== undefined && Array.isArray(b.tag_ids)) {
				patch.tag_ids = (b.tag_ids as unknown[]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
			}
			try {
				const tx = db.updateTransaction(id, patch);
				if (!tx) return sendError(res, 404, "transaction not found");
				send(res, 200, tx);
			} catch (e) {
				sendError(res, 400, (e as Error).message, (e as Error).message.split(":")[0]);
			}
		}),
		R("DELETE", "/api/transactions/:id", (_req, res, p) => {
			const id = Number(p.id);
			const ok = db.deleteTransaction(id);
			if (!ok) return sendError(res, 404, "transaction not found");
			send(res, 200, { ok: true });
		}),
	];
}

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────────────────────

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const url = new URL(req.url ?? "/", "http://localhost");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/") pathname = "/index.html";

	// prevent path traversal
	const root = resolve(UI_DIR);
	const target = resolve(join(root, pathname));
	if (!target.startsWith(root)) {
		sendError(res, 400, "bad path");
		return true;
	}
	if (!existsSync(target)) {
		// SPA fallback: serve index.html for unknown paths (no extension)
		if (!extname(target)) {
			const fallback = join(root, "index.html");
			if (existsSync(fallback)) {
				const body = readFileSync(fallback);
				res.writeHead(200, { "content-type": MIME[".html"], "content-length": body.length });
				res.end(req.method === "HEAD" ? undefined : body);
				return true;
			}
		}
		return false;
	}
	const st = statSync(target);
	if (!st.isFile()) return false;
	const body = readFileSync(target);
	const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, {
		"content-type": type,
		"content-length": body.length,
		"cache-control": "no-cache",
	});
	res.end(req.method === "HEAD" ? undefined : body);
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerHandle {
	url: string;
	port: number;
	hostname: string;
	stop(): Promise<void>;
}

export async function startServer(db: FinanceDB, preferredPort = 3847, hostname = "127.0.0.1"): Promise<ServerHandle> {
	const routes = buildRoutes(db);

	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// CORS preflight (loose; the UI is served from the same origin)
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
		res.setHeader("access-control-allow-headers", "content-type");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (path.startsWith("/api/")) {
			for (const r of routes) {
				const m = r.pattern.exec(path);
				if (!m || r.method !== req.method) continue;
				const params: Record<string, string> = {};
				r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
				try {
					const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readJson(req) : undefined;
					r.handler(req, res, params, body);
				} catch (e) {
					const msg = (e as Error).message;
					const code = msg.split(":")[0];
					const status = code === "payload_too_large" ? 413 : code === "invalid_json" ? 400 : 400;
					sendError(res, status, msg, code);
				}
				return;
			}
			sendError(res, 404, "no route: " + path);
			return;
		}

		if (serveStatic(req, res)) return;
		sendError(res, 404, "not found: " + path);
	};

	const server: Server = createServer((req, res) => {
		handler(req, res).catch((e) => {
			try {
				sendError(res, 500, (e as Error).message);
			} catch {
				res.end();
			}
		});
	});

	// unref so the server doesn't keep the process alive
	server.unref();

	// Try preferred port, then a few fallbacks
	const tried = new Set<number>();
	const candidates = [preferredPort, ...Array.from({ length: 20 }, (_, i) => preferredPort + i + 1)];

	for (const port of candidates) {
		if (tried.has(port)) continue;
		tried.add(port);
		const ok = await new Promise<boolean>((resolve) => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") resolve(false);
				else resolve(false);
			});
			server.listen(port, hostname, () => resolve(true));
		});
		if (ok) {
			const url = `http://${hostname}:${port}`;
			return {
				url,
				port,
				hostname,
				stop: () =>
					new Promise<void>((resolve, reject) => {
						server.close((err) => (err ? reject(err) : resolve()));
					}),
			};
		}
	}
	throw new Error("no_port_available");
}
