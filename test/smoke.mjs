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
} finally {
	try { await server.stop(); } catch { /* */ }
	try { db.close(); } catch { /* */ }
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { force: true });
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
