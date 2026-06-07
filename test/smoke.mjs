/**
 * Smoke test for pi-finance-tracker.
 *
 * Boots the database, the server, hits every API endpoint, and asserts the
 * round-trip works. Run with: `node test/smoke.mjs` from the extension root.
 *
 * Exits 0 on success, non-zero on the first failure. No third-party deps.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../src");

const { FinanceDB } = await import(join(SRC, "db.ts"));
const { startServer } = await import(join(SRC, "server.ts"));
const { sniffMime } = await import(join(SRC, "media/mime.ts"));
const { writeTemp, readTemp, deleteTemp } = await import(join(SRC, "media/ingest.ts"));

const SCRATCH = join(tmpdir(), `pi-finance-tracker-smoke-${Date.now()}.db`);
const PORT = 3860;

let passed = 0;
let failed = 0;

function ok(name) {
	passed++;
	console.log(`  ✓ ${name}`);
}
function fail(name, err) {
	failed++;
	console.error(`  ✗ ${name}: ${err && err.stack ? err.stack : err}`);
}
async function test(name, fn) {
	try {
		await fn();
		ok(name);
	} catch (e) {
		fail(name, e);
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assertion failed");
}

const db = await FinanceDB.open(SCRATCH);
const server = await startServer(db, PORT, "127.0.0.1");
const base = server.url;

async function http(method, path, body) {
	const r = await fetch(base + path, {
		method,
		headers: body ? { "content-type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await r.text();
	let data = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = text; }
	return { status: r.status, body: data };
}

try {
	console.log("Smoke test for pi-finance-tracker");
	console.log("DB:    " + SCRATCH);
	console.log("API:   " + base);
	console.log("");

	// health
	await test("GET /api/health → 200 ok", async () => {
		const r = await http("GET", "/api/health");
		assert(r.status === 200, `status=${r.status}`);
		assert(r.body.ok === true, "ok flag");
	});

	// wallets
	let wallet, category, tag, tx;
	await test("POST /api/wallets → 201", async () => {
		const r = await http("POST", "/api/wallets", {
			name: "Smoke wallet",
			currency: "USD",
			opening_minor: 50000,
		});
		assert(r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
		wallet = r.body;
		assert(wallet.id > 0, "wallet has id");
		assert(wallet.name === "Smoke wallet", "wallet name matches");
	});

	await test("POST /api/wallets (duplicate) → 400", async () => {
		const r = await http("POST", "/api/wallets", { name: "Smoke wallet", currency: "USD" });
		assert(r.status === 400, `status=${r.status}`);
	});

	await test("GET /api/wallets → contains new wallet", async () => {
		const r = await http("GET", "/api/wallets?include_archived=true");
		assert(r.status === 200, `status=${r.status}`);
		assert(Array.isArray(r.body), "wallets is an array");
		assert(r.body.some((w) => w.id === wallet.id), "wallet present");
	});

	// categories
	await test("POST /api/categories (expense) → 201", async () => {
		const r = await http("POST", "/api/categories", {
			name: "Smoke food",
			kind: "expense",
			icon: "🍔",
		});
		assert(r.status === 201, `status=${r.status}`);
		category = r.body;
	});

	await test("POST /api/categories (income) → 201", async () => {
		const r = await http("POST", "/api/categories", {
			name: "Smoke salary",
			kind: "income",
		});
		assert(r.status === 201, `status=${r.status}`);
	});

	// tags
	await test("POST /api/tags → 201", async () => {
		const r = await http("POST", "/api/tags", { name: "smoke" });
		assert(r.status === 201, `status=${r.status}`);
		tag = r.body;
	});

	// transactions
	await test("POST /api/transactions (expense) → 201", async () => {
		const r = await http("POST", "/api/transactions", {
			wallet_id: wallet.id,
			category_id: category.id,
			type: "expense",
			amount_minor: 2599,
			currency: "USD",
			note: "lunch",
			tag_ids: [tag.id],
		});
		assert(r.status === 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
		tx = r.body;
		assert(tx.tag_ids.includes(tag.id), "tag attached");
		assert(tx.tag_names[0] === "smoke", "tag name attached");
	});

	await test("POST /api/transactions (transfer + category) → 400", async () => {
		const r = await http("POST", "/api/transactions", {
			wallet_id: wallet.id,
			category_id: category.id,
			type: "transfer",
			amount_minor: 100,
			currency: "USD",
		});
		assert(r.status === 400, `status=${r.status}`);
		assert(/transfer_cannot_have_category/.test(r.body.error || ""), "error code present");
	});

	await test("PUT /api/transactions/:id → 200", async () => {
		const r = await http("PUT", "/api/transactions/" + tx.id, {
			amount_minor: 3000,
			note: "updated",
		});
		assert(r.status === 200, `status=${r.status}`);
		assert(r.body.amount_minor === 3000, "amount updated");
		assert(r.body.note === "updated", "note updated");
	});

	await test("GET /api/transactions?type=expense → 200 array", async () => {
		const r = await http("GET", "/api/transactions?type=expense&limit=10");
		assert(r.status === 200, `status=${r.status}`);
		assert(Array.isArray(r.body), "transactions is array");
		assert(r.body.length >= 1, "at least one expense");
	});

	await test("GET /api/summary → wallet balance correct", async () => {
		const r = await http("GET", "/api/summary");
		assert(r.status === 200, `status=${r.status}`);
		const w = r.body.by_wallet.find((b) => b.wallet_id === wallet.id);
		assert(w, "wallet in summary");
		// opening 50000 - 3000 (updated amount) = 47000
		assert(w.balance_minor === 47000, `expected 47000, got ${w.balance_minor}`);
	});

	// UI
	await test("GET / → 200 HTML", async () => {
		const r = await fetch(base + "/");
		assert(r.status === 200, `status=${r.status}`);
		const text = await r.text();
		assert(text.includes("Finance"), "UI contains title");
		assert(text.length > 1000, "UI is non-trivial");
	});

	await test("GET /some/spa/route → 200 (SPA fallback)", async () => {
		const r = await fetch(base + "/some/spa/route");
		assert(r.status === 200, `status=${r.status}`);
	});

	// cleanup
	await test("DELETE /api/transactions/:id → 200", async () => {
		const r = await http("DELETE", "/api/transactions/" + tx.id);
		assert(r.status === 200, `status=${r.status}`);
	});

	await test("DELETE /api/wallets/:id (empty) → 200", async () => {
		const r = await http("DELETE", "/api/wallets/" + wallet.id);
		assert(r.status === 200, `status=${r.status}`);
	});

	// persistence: close DB, reopen, ensure data round-trips
	await test("reopen DB round-trips state", async () => {
		// Create a fresh wallet we expect to see after reopen
		const created = await http("POST", "/api/wallets", {
			name: "Persistence test",
			currency: "USD",
			opening_minor: 12345,
		});
		assert(created.status === 201, "wallet created pre-reopen");
		await server.stop();
		db.close();
		const db2 = await FinanceDB.open(SCRATCH);
		const ws = db2.listWallets();
		assert(ws.some((w) => w.name === "Persistence test"), "wallet present after reopen");
		assert(ws.find((w) => w.name === "Persistence test").opening_minor === 12345, "opening balance intact");
		db2.close();
	});
// Phase 8.1 — MIME sniff + temp file lifecycle
const TEMP_DIR = join(tmpdir(), `pi-finance-tracker-smoke-media-${Date.now()}`);

await test("MIME sniff — JPEG", async () => {
	// Minimal valid JPEG: FF D8 FF E0 ... (SOI + APP0 + ...)
	const jpeg = Buffer.from([
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
		0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
	]);
	const result = sniffMime(jpeg);
	assert(result.kind === "image", `kind=${result.kind}`);
	assert(result.mime === "image/jpeg", `mime=${result.mime}`);
});

await test("MIME sniff — PDF", async () => {
	const pdf = Buffer.from("%PDF-1.4\n%\xc3\xa4\xc3\xbc\xc3\xb6\n");
	const result = sniffMime(pdf);
	assert(result.kind === "pdf", `kind=${result.kind}`);
	assert(result.mime === "application/pdf", `mime=${result.mime}`);
});

await test("MIME sniff — unsupported", async () => {
	const txt = Buffer.from("hello world this is not a supported format");
	let threw = false;
	try {
		sniffMime(txt);
	} catch (e) {
		threw = true;
		assert(e.code === "unsupported_format" || String(e).includes("unsupported_format"),
			"expected unsupported_format, got " + e.message);
	}
	assert(threw, "sniffMime should have thrown");
});

await test("Temp file lifecycle", async () => {
	const content = Buffer.alloc(1024, 0x41); // 1 KB of 'A's
	const ttlMs = 60 * 1000; // 1 minute
	const { mediaId, path: filePath } = writeTemp(content, "image", { tempDir: TEMP_DIR, ttlMs });
	assert(mediaId.length >= 20, `mediaId=${mediaId}`);
	assert(existsSync(filePath), "file exists after write");

	const readBack = readTemp(mediaId, TEMP_DIR, ttlMs);
	assert(readBack !== null, "readTemp returned non-null");
	assert(readBack.buffer.length === 1024, `length=${readBack.buffer.length}`);
	assert(readBack.buffer[0] === 0x41, "first byte matches");

	const deleted = deleteTemp(mediaId, TEMP_DIR);
	assert(deleted === true, "deleteTemp returned true");

	const afterDelete = readTemp(mediaId, TEMP_DIR, ttlMs);
	assert(afterDelete === null, "readTemp returns null after delete");
});

// Phase 8.1 — schema migration + new transaction fields (self-contained, fresh DB)
await test("Schema migration — new columns exist on a fresh DB", async () => {
	const SCRATCH_MIG = join(tmpdir(), `pi-finance-tracker-smoke-mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const migDb = await FinanceDB.open(SCRATCH_MIG);
	const cols = migDb.columnsOf("transactions").map((c) => c.name);
	assert(cols.includes("media_path"), `media_path missing. cols=${cols.join(",")}`);
	assert(cols.includes("media_source_kind"), `media_source_kind missing. cols=${cols.join(",")}`);
	migDb.close();
	rmSync(SCRATCH_MIG, { force: true });
});

await test("Schema migration — migrate() is idempotent on an already-migrated DB", async () => {
	const SCRATCH_MIG = join(tmpdir(), `pi-finance-tracker-smoke-mig2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const migDb = await FinanceDB.open(SCRATCH_MIG);
	// Run migrate() again on an already-migrated DB — must not throw, columns must remain.
	migDb.migrate();
	const cols = migDb.columnsOf("transactions").map((c) => c.name);
	assert(cols.includes("media_path"), "media_path present after re-migrate");
	assert(cols.includes("media_source_kind"), "media_source_kind present after re-migrate");
	migDb.close();
	rmSync(SCRATCH_MIG, { force: true });
});

await test("Transaction — new media_path / media_source_kind default null + round-trip", async () => {
	const SCRATCH_TX = join(tmpdir(), `pi-finance-tracker-smoke-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const txDb = await FinanceDB.open(SCRATCH_TX);
	const wallet = txDb.createWallet({ name: "Media-defaults-wallet", currency: "IDR", opening_minor: 0 });
	const category = txDb.createCategory({ name: "Media-defaults-cat", kind: "expense" });
	const tx = txDb.createTransaction({
		wallet_id: wallet.id,
		category_id: category.id,
		type: "expense",
		amount_minor: 1000,
		currency: "IDR",
		note: "plain transaction, no media",
	});
	assert(tx.media_path === null, `media_path=${tx.media_path}`);
	assert(tx.media_source_kind === null, `media_source_kind=${tx.media_source_kind}`);

	// Update with media fields
	const updated = txDb.updateTransaction(tx.id, {
		media_path: "/tmp/abc123",
		media_source_kind: "image",
	});
	assert(updated.media_path === "/tmp/abc123", `media_path updated=${updated.media_path}`);
	assert(updated.media_source_kind === "image", `media_source_kind updated=${updated.media_source_kind}`);

	// getTransaction round-trips them
	const fetched = txDb.getTransaction(tx.id);
	assert(fetched.media_path === "/tmp/abc123", "media_path round-trip");
	assert(fetched.media_source_kind === "image", "media_source_kind round-trip");
	txDb.close();
	rmSync(SCRATCH_TX, { force: true });
});

// Clean up temp dir
try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* */ }

} finally {
	try { await server.stop(); } catch { /* */ }
	try { db.close(); } catch { /* */ }
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { force: true });
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
