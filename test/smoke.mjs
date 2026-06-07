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
	const { mediaId, path: filePath } = writeTemp(content, "image", "image/png", { tempDir: TEMP_DIR, ttlMs });
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

// ── PR 2 — Media HTTP endpoints + GroqClient mock tests ───────────────

const { GroqClient } = await import(join(SRC, "groq.ts"));

const MOCK_CFG = {
	apiKey: "gsk_test_key_12345678901234567890",
	baseUrl: "https://api.groq.com/openai/v1",
	modelAudio: "whisper-large-v3",
	modelImage: "llama-3.2-90b-vision-preview",
	modelPdfStructure: "llama-3.3-70b-versatile",
	maxBytes: 26214400,
	tempDir: join(tmpdir(), `pi-finance-tracker-smoke-media-pr2-${Date.now()}`),
	ttlMs: 60000,
	enabled: true,
	maxPdfPages: 50,
};
const { mkdirSync } = await import("node:fs");
mkdirSync(MOCK_CFG.tempDir, { recursive: true });

// Shared DB + server for HTTP media tests
const mediaDb = await FinanceDB.open(join(tmpdir(), `pi-ft-media-shared-${Date.now()}.db`));
const mediaSrv = await startServer(mediaDb, 15990, "127.0.0.1",
	new GroqClient(MOCK_CFG, {
		fetch: async () => ({ ok: true, status: 200, json: async () => ({ text: "mock", language: "id", duration: 1.0 }) }),
	}),
	MOCK_CFG,
);

const mockFetch = (responseData) =>
	async (_url, _init) => ({
		ok: true,
		status: 200,
		json: async () => responseData,
	});

await test("POST /api/media/ingest — happy path JPEG", async () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
		0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
		0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
		0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
	]);
	const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\n`),
		Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.jpg"\r\n`),
		Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
		jpeg,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);

	const r = await fetch(`${mediaSrv.url}/api/media/ingest`, {
		method: "POST",
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		body,
	});
	const json = await r.json();
	assert(r.status === 200, `status=${r.status} body=${JSON.stringify(json)}`);
	assert(json.ok === true, "ok flag");
	assert(typeof json.data.media_id === "string" && json.data.media_id.length === 32, `media_id=${json.data.media_id}`);
	assert(json.data.kind === "image", `kind=${json.data.kind}`);
	assert(json.data.size_bytes === jpeg.length, `size_bytes=${json.data.size_bytes}`);
	assert(typeof json.data.expires_at === "string", "expires_at present");
	assert(json.data.detected_mime === "image/jpeg", `mime=${json.data.detected_mime}`);
});

await test("POST /api/media/ingest — unsupported format → 415", async () => {
	const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\n`),
		Buffer.from(`Content-Disposition: form-data; name="file"; filename="test.txt"\r\n`),
		Buffer.from(`Content-Type: text/plain\r\n\r\n`),
		Buffer.from("hello world this is plain text"),
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);

	const r = await fetch(`${mediaSrv.url}/api/media/ingest`, {
		method: "POST",
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		body,
	});
	const json = await r.json();
	assert(r.status === 415, `status=${r.status}`);
	assert(json.ok === false, "ok flag false");
	assert(json.error.code === "unsupported_format", `code=${json.error.code}`);
});

// For file_too_large, start a second server with a 1 KB cap
await test("POST /api/media/ingest — file too large → 413", async () => {
	const smallCfg = { ...MOCK_CFG, maxBytes: 1024 };
	const smallDb = await FinanceDB.open(join(tmpdir(), `pi-ft-small-${Date.now()}.db`));
	const smallSrv = await startServer(smallDb, 15995, "127.0.0.1",
		new GroqClient(smallCfg, { fetch: mockFetch({}) }),
		smallCfg,
	);

	const bigJpeg = Buffer.alloc(2048, 0xff);
	bigJpeg[0] = 0xff; bigJpeg[1] = 0xd8; bigJpeg[2] = 0xff;
	const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\n`),
		Buffer.from(`Content-Disposition: form-data; name="file"; filename="big.jpg"\r\n`),
		Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
		bigJpeg,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);

	const r = await fetch(`${smallSrv.url}/api/media/ingest`, {
		method: "POST",
		headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
		body,
	});
	const json = await r.json();
	assert(r.status === 413, `status=${r.status} body=${JSON.stringify(json)}`);
	assert(json.ok === false, "ok flag false");
	assert(json.error.code === "file_too_large", `code=${json.error.code}`);

	await smallSrv.stop();
	smallDb.close();
});

await test("POST /api/transactions/bulk — one duplicate skipped", async () => {
	// Use the shared media server's DB directly
	const today = new Date().toISOString().split("T")[0];
	const bulkWallet = mediaDb.createWallet({ name: "Bulk-Wallet", currency: "IDR", opening_minor: 0 });
	const bulkCat = mediaDb.createCategory({ name: "Bulk-Cat", kind: "expense" });
	mediaDb.createTransaction({
		wallet_id: bulkWallet.id,
		category_id: bulkCat.id,
		type: "expense",
		amount_minor: 50000,
		currency: "IDR",
		note: "existing",
		occurred_at: today,
	});

	const r = await fetch(`${mediaSrv.url}/api/transactions/bulk`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			wallet_id: bulkWallet.id,
			default_currency: "IDR",
			transactions: [
				{ amount_minor: 50000, currency: "IDR", occurred_at: today, type: "expense", description: "dup" },
				{ amount_minor: 25000, currency: "IDR", occurred_at: today, type: "expense", description: "lunch" },
				{ amount_minor: 10000, currency: "IDR", occurred_at: today, type: "expense", description: "coffee" },
			],
		}),
	});
	const body = await r.json();
	assert(r.status === 200, `status=${r.status} body=${JSON.stringify(body)}`);
	assert(Array.isArray(body.created), "created is array");
	assert(Array.isArray(body.skipped), "skipped is array");
	assert(body.created.length === 2, `created.length=${body.created.length}`);
	assert(body.skipped.length === 1, `skipped.length=${body.skipped.length}`);
	assert(body.skipped[0].reason === "duplicate_detected", `reason=${body.skipped[0].reason}`);
	for (const tx of body.created) {
		assert(tx.media_source_kind === "pdf", `media_source_kind=${tx.media_source_kind}`);
	}
});

await test("GroqClient.transcribe — mock fetch returns transcript", async () => {
	const gc = new GroqClient(
		{
			apiKey: "gsk_test_key_12345678901234567890",
			baseUrl: "https://api.groq.com/openai/v1",
			modelAudio: "whisper-large-v3",
			modelImage: "llama-3.2-90b-vision-preview",
			modelPdfStructure: "llama-3.3-70b-versatile",
			maxBytes: 26214400,
			tempDir: "/tmp",
			ttlMs: 60000,
			enabled: true,
			maxPdfPages: 50,
		},
		{
			fetch: async (_url, init) => {
				// Verify the Authorization header is set
				const auth = (init.headers || {})["Authorization"];
				assert(auth === "Bearer gsk_test_key_12345678901234567890", "auth header set");
				return {
					ok: true,
					status: 200,
					json: async () => ({
						text: "beli makan siang 50 ribu",
						language: "id",
						duration: 12.5,
					}),
				};
			},
		},
	);

	const result = await gc.transcribe({
		file: Buffer.alloc(256), // small fake audio
		mime: "audio/wav",
	});
	assert(result.ok === true, `ok=${result.ok}`);
	if (result.ok) {
		assert(result.data.text === "beli makan siang 50 ribu", `text=${result.data.text}`);
		assert(result.data.language === "id", `language=${result.data.language}`);
		assert(result.data.duration_sec === 12.5, `duration=${result.data.duration_sec}`);
	}
});

await test("GroqClient.extractImage — mock fetch with JSON prompt", async () => {
	const gc = new GroqClient(
		{
			apiKey: "gsk_test_key_12345678901234567890",
			baseUrl: "https://api.groq.com/openai/v1",
			modelAudio: "whisper-large-v3",
			modelImage: "llama-3.2-90b-vision-preview",
			modelPdfStructure: "llama-3.3-70b-versatile",
			maxBytes: 26214400,
			tempDir: "/tmp",
			ttlMs: 60000,
			enabled: true,
			maxPdfPages: 50,
		},
		{
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					choices: [
						{
							message: {
								content: JSON.stringify({
									text: "Receipt from Tokopedia",
									structured: { merchant: "Tokopedia", amount: 50000 },
								}),
							},
						},
					],
				}),
			}),
		},
	);

	const result = await gc.extractImage({
		file: Buffer.alloc(256),
		mime: "image/jpeg",
		prompt: "Extract receipt info as JSON: {merchant, amount}",
	});
	assert(result.ok === true, `ok=${result.ok}`);
	if (result.ok) {
		assert(result.data.text === "Receipt from Tokopedia", `text=${result.data.text}`);
		assert(result.data.structured?.merchant === "Tokopedia", `merchant=${result.data.structured?.merchant}`);
		assert(result.data.structured?.amount === 50000, `amount=${result.data.structured?.amount}`);
	}
});

// ── PR 2 — Reviewer fixes F1 (path traversal) and F2 (provenance string) ──

await test("Path traversal — POST /api/media/transcribe rejects bad media_id", async () => {
	const r = await fetch("http://127.0.0.1:15990/api/media/transcribe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ media_id: "../../etc/passwd" }),
	});
	assert(r.status === 400, `status=${r.status}`);
	const body = await r.json();
	// Validation errors are caught in the route try/catch and sent as
	// `{ error: <full message>, code: <message-prefix> }`.
	assert(body.code === "invalid_media_id", `code=${body.code}, body=${JSON.stringify(body)}`);
});

await test("Path traversal — POST /api/media/extract-pdf rejects non-hex media_id", async () => {
	const r = await fetch("http://127.0.0.1:15990/api/media/extract-pdf", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ media_id: "not-a-valid-hex-id-12345678" }),
	});
	assert(r.status === 400, `status=${r.status}`);
});

await test("Path traversal — GET /api/media/:id rejects bad id (regression)", async () => {
	const r = await fetch("http://127.0.0.1:15990/api/media/" + encodeURIComponent("../../etc/passwd"), {
		method: "GET",
	});
	assert(r.status === 404, `status=${r.status}`);
});

// ── PR 3a — Reviewer fix tests (F3, F4, F5) ──────────────────────────

await test("F4 — Content-Length pre-check rejects oversized body early", async () => {
	// Use Node.js http directly (not fetch) because fetch has issues with
	// Content-Length mismatch when the server rejects early.
	const http = await import("node:http");
	const boundary = "----TestBoundary" + Math.random().toString(36).slice(2);
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\n`),
		Buffer.from(`Content-Disposition: form-data; name="file"; filename="small.jpg"\r\n`),
		Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
		Buffer.from([0xff, 0xd8, 0xff]), // tiny JPEG header
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	const { status, data } = await new Promise((resolve, reject) => {
		const req = http.request({
			hostname: "127.0.0.1",
			port: 15990,
			path: "/api/media/ingest",
			method: "POST",
			headers: {
				"content-type": `multipart/form-data; boundary=${boundary}`,
				"content-length": "99999999",
			},
		}, (res) => {
			let data = "";
			res.on("data", (c) => data += c);
			res.on("end", () => resolve({ status: res.statusCode, data }));
		});
		req.on("error", (e) => reject(e));
		req.write(body);
		req.end();
	});
	assert(status === 413, `expected 413, got ${status}`);
	const json = JSON.parse(data);
	assert(json.ok === false, "ok flag false");
	assert(json.error.code === "file_too_large", `code=${json.error.code}`);
});

await test("F5 — GroqClient 4xx → groq_invalid_response", async () => {
	const gc = new GroqClient(MOCK_CFG, {
		fetch: async () => ({
			ok: false,
			status: 400,
			text: async () => "bad request",
		}),
	});
	const result = await gc.transcribe({ file: Buffer.alloc(10), mime: "audio/wav" });
	assert(result.ok === false, "should fail");
	if (!result.ok) {
		assert(result.error.code === "groq_invalid_response",
			`expected groq_invalid_response for 4xx, got ${result.error.code}`);
	}
});

await test("F5 — GroqClient 5xx → groq_unavailable", async () => {
	const gc = new GroqClient(MOCK_CFG, {
		fetch: async () => ({
			ok: false,
			status: 502,
			text: async () => "bad gateway",
		}),
	});
	const result = await gc.extractImage({ file: Buffer.alloc(10), mime: "image/jpeg" });
	assert(result.ok === false, "should fail");
	if (!result.ok) {
		assert(result.error.code === "groq_unavailable",
			`expected groq_unavailable for 5xx, got ${result.error.code}`);
	}
});

await test("F5 — GroqClient PDF structure 4xx → groq_invalid_response", async () => {
	const gc = new GroqClient(MOCK_CFG, {
		fetch: async () => ({
			ok: false,
			status: 422,
			text: async () => "unprocessable",
		}),
	});
	const result = await gc.extractPdfStructure({ text: "some pdf text", schema: {} });
	assert(result.ok === false, "should fail");
	if (!result.ok) {
		assert(result.error.code === "groq_invalid_response",
			`expected groq_invalid_response for 4xx, got ${result.error.code}`);
	}
});

// Bulk endpoint provenance tests — need a fresh DB + server because the harness
// `db` is closed by the persistence test that ran earlier. We bring up a dedicated
// server for these three tests, then tear it down.
const provDbPath = join(tmpdir(), `pi-ft-provenance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const provDb = await FinanceDB.open(provDbPath);
const provSrv = await startServer(provDb, 15991, "127.0.0.1");
const provWallet = provDb.createWallet({ name: "Prov-wallet", currency: "IDR", opening_minor: 0 });
const provSha = "a".repeat(64);

await test("Bulk — provenance string prepended to note when source_filename + sha256 provided", async () => {
	const r = await fetch("http://127.0.0.1:15991/api/transactions/bulk", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			wallet_id: provWallet.id,
			default_currency: "IDR",
			source_filename: "rekening-koran-bca-2026-05.pdf",
			source_sha256_hex: provSha,
			transactions: [
				{
					amount_minor: 75000,
					currency: "IDR",
					type: "expense",
					occurred_at: "2026-05-15T10:00:00Z",
					description: "Pembelian di Tokopedia",
				},
			],
		}),
	});
	assert(r.status === 200, `status=${r.status}`);
	const body = await r.json();
	assert(body.created.length === 1, `created.length=${body.created.length}`);
	const note = body.created[0].note;
	assert(note.startsWith("from pdf: rekening-koran-bca-2026-05.pdf (sha256:"),
		`note should start with provenance, got: ${note.slice(0, 80)}`);
	assert(note.includes("Pembelian di Tokopedia"), `note should include original description, got: ${note}`);
	assert(body.created[0].media_source_kind === "pdf", `media_source_kind=${body.created[0].media_source_kind}`);
});

await test("Bulk — no provenance string when source_filename and sha256 omitted", async () => {
	const r = await fetch("http://127.0.0.1:15991/api/transactions/bulk", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			wallet_id: provWallet.id,
			default_currency: "IDR",
			transactions: [
				{
					amount_minor: 25000,
					currency: "IDR",
					type: "expense",
					occurred_at: "2026-05-20T10:00:00Z",
					description: "Kopi",
				},
			],
		}),
	});
	assert(r.status === 200, `status=${r.status}`);
	const body = await r.json();
	assert(body.created.length === 1, `created.length=${body.created.length}`);
	assert(!body.created[0].note.includes("from pdf:"),
		`note should not contain provenance, got: ${body.created[0].note}`);
	assert(body.created[0].note === "Kopi", `note=${body.created[0].note}`);
});

await test("Bulk — invalid source_sha256_hex returns 400", async () => {
	const r = await fetch("http://127.0.0.1:15991/api/transactions/bulk", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			wallet_id: provWallet.id,
			default_currency: "IDR",
			source_sha256_hex: "not-64-chars",
			transactions: [
				{ amount_minor: 1000, currency: "IDR", type: "expense", occurred_at: "2026-05-25T10:00:00Z" },
			],
		}),
	});
	assert(r.status === 400, `status=${r.status}`);
});

// Tear down the provenance-test server
await provSrv.stop();
provDb.close();
rmSync(provDbPath, { force: true });

// Clean up temp dir
try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* */ }
try { if (typeof mediaSrv !== 'undefined') await mediaSrv.stop(); } catch { /* */ }
try { if (typeof mediaDb !== 'undefined') mediaDb.close(); } catch { /* */ }
try { if (MOCK_CFG?.tempDir) rmSync(MOCK_CFG.tempDir, { recursive: true, force: true }); } catch { /* */ }

} finally {
	try { await server.stop(); } catch { /* */ }
	try { db.close(); } catch { /* */ }
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { force: true });
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
