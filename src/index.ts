/**
 * Finance Tracker — Pi extension entry point.
 *
 * - Opens a SQLite database (sql.js) on first session_start
 * - Starts a small HTTP server (in the same Node process) that serves the
 *   CRUD web UI and a JSON REST API
 * - Registers TypeBox-typed tools the LLM can call
 * - Registers the `/finance` slash command to print/open the UI URL
 * - Persists the DB after every mutation
 *
 * Configuration (env vars, all optional):
 *   PI_FINANCE_DB        Path to the SQLite file. Default: ~/.pi/agent/finance-tracker/finance.db
 *   PI_FINANCE_PORT      Preferred HTTP port. Default: 3847
 *   PI_FINANCE_HOST      Bind address. Default: 127.0.0.1
 *   PI_FINANCE_AUTOSTART Set to "0" to skip auto-starting the web server.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FinanceDB } from "./db.js";
import { startServer, type ServerHandle } from "./server.js";
import { registerTools } from "./tools.js";
import { getMediaConfig } from "./config.js";
import { GroqClient } from "./groq.js";
import { startSweeper } from "./media/ingest.js";

interface ExtensionState {
	db: FinanceDB;
	server: ServerHandle | null;
	dbPath: string;
	port: number;
	hostname: string;
	groqClient: GroqClient | null;
	sweeperStop: (() => void) | null;
}

const state: ExtensionState = {
	db: null as unknown as FinanceDB, // assigned in session_start
	server: null,
	dbPath: "",
	port: 0,
	hostname: "",
	groqClient: null,
	sweeperStop: null,
};

function defaultDbPath(): string {
	return join(homedir(), ".pi", "agent", "finance-tracker", "finance.db");
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	return raw !== "0" && raw.toLowerCase() !== "false";
}

async function openDatabase(dbPath: string): Promise<FinanceDB> {
	const absolute = resolvePath(dbPath);
	mkdirSync(dirname(absolute), { recursive: true });
	const existed = existsSync(absolute);
	const db = await FinanceDB.open(absolute);
	if (!existed) {
		// Seed with a few sensible defaults so the UI is not empty on first run.
		const food = db.createCategory({ name: "Food", kind: "expense", icon: "🍔", color: "#ef4444" });
		db.createCategory({ name: "Transport", kind: "expense", icon: "🚗", color: "#3b82f6" });
		db.createCategory({ name: "Bills", kind: "expense", icon: "💡", color: "#a855f7" });
		db.createCategory({ name: "Salary", kind: "income", icon: "💼", color: "#10b981" });
		db.createCategory({ name: "Gifts", kind: "income", icon: "🎁", color: "#22c55e" });
		const wallet = db.createWallet({ name: "Cash", currency: "USD", opening_minor: 0, color: "#6366f1" });
		db.createTag({ name: "recurring", color: "#f59e0b" });
		db.createTag({ name: "one-off", color: "#06b6d4" });
		void food; void wallet;
	}
	return db;
}

function fmtStatusLine(): string {
	if (!state.server) return "finance: off";
	return `finance: ${state.server.url}`;
}

async function ensureServer(ctx: Pick<ExtensionContext, "ui">): Promise<ServerHandle> {
	if (state.server) return state.server;
	const handle = await startServer(state.db, state.port, state.hostname);
	state.server = handle;
	state.port = handle.port;
	if (ctx.ui && typeof (ctx.ui as { setStatus?: (k: string, v: string) => void }).setStatus === "function") {
		try { (ctx.ui as { setStatus: (k: string, v: string) => void }).setStatus("finance", `finance: ${handle.url}`); } catch { /* not in tui mode */ }
	}
	return handle;
}

export default function (pi: ExtensionAPI) {
	// Resolve config once at load time
	state.dbPath = process.env.PI_FINANCE_DB?.trim() || defaultDbPath();
	state.port = envInt("PI_FINANCE_PORT", 3847);
	state.hostname = process.env.PI_FINANCE_HOST?.trim() || "127.0.0.1";
	const autostart = envBool("PI_FINANCE_AUTOSTART", true);

	// Register tools immediately — they need a live DB at execution time, but
	// the type registration is fine to do up front.
	let toolsRegistered = false;
	const tryRegisterTools = () => {
		if (toolsRegistered) return;
		toolsRegistered = true;
		try {
			registerTools(pi as unknown as { registerTool: (def: unknown) => void }, state.db);
		} catch (e) {
			toolsRegistered = false;
			throw e;
		}
	};

	// Open DB + start server + init media features on first session
	pi.on("session_start", async (event, ctx) => {
		try {
			if (!state.db) {
				state.db = await openDatabase(state.dbPath);
				tryRegisterTools();
			}

			// Initialise Groq media support if enabled
			if (!state.groqClient) {
				const mediaCfg = getMediaConfig();
				if (mediaCfg) {
					if (!mediaCfg.apiKey) {
						// Config exists but no key — tools/routes will return `not_configured` at call time.
						ctx.ui.notify(
							"Groq media features: not configured — set GROQ_API_KEY or PI_FINANCE_GROQ_API_KEY to enable.",
							"warn",
						);
					} else {
						state.groqClient = new GroqClient(mediaCfg);
						// Start the TTL sweeper (every 5 minutes)
						if (!state.sweeperStop) {
							const intervalMs = 5 * 60 * 1000;
							state.sweeperStop = startSweeper(
								mediaCfg.tempDir,
								mediaCfg.ttlMs,
								intervalMs,
							).stop;
						}
						ctx.ui.notify("Groq media client ready.", "info");
					}
				} else {
					ctx.ui.notify(
						"Groq media features: disabled by PI_FINANCE_MEDIA_ENABLED=0.",
						"info",
					);
				}
			}

			if (autostart && !state.server) {
				await ensureServer(ctx);
				ctx.ui.notify(
					`Finance tracker ready: ${state.server!.url}`,
					"info",
				);
			} else if (!state.server) {
				ctx.ui.notify(
					"Finance tracker DB loaded. Run /finance to start the web UI.",
					"info",
				);
			}
		} catch (e) {
			ctx.ui.notify(
				`Finance tracker failed to start: ${(e as Error).message}`,
				"error",
			);
		}
	});

	// Also expose on resources_discover so /reload works
	pi.on("resources_discover", async (_event, ctx) => {
		if (!state.db) {
			try {
				state.db = await openDatabase(state.dbPath);
				tryRegisterTools();
			} catch (e) {
				ctx.ui.notify(`Finance DB open failed: ${(e as Error).message}`, "error");
			}
		}
	});

	// /finance: print the URL, optionally start the server, optionally open browser
	pi.registerCommand("finance", {
		description: "Finance tracker: show the web UI URL (and start the server if it is off).",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "open", label: "open", description: "Open the web UI in your default browser" },
				{ value: "url", label: "url", description: "Print the UI URL only" },
				{ value: "stop", label: "stop", description: "Stop the web server" },
				{ value: "path", label: "path", description: "Print the database file path" },
				{ value: "seed", label: "seed", description: "Re-seed the database with sample data (only if empty)" },
			];
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			// Make sure the DB is open
			if (!state.db) {
				try {
					state.db = await openDatabase(state.dbPath);
					tryRegisterTools();
				} catch (e) {
					ctx.ui.notify(`DB open failed: ${(e as Error).message}`, "error");
					return;
				}
			}

			if (arg === "path") {
				ctx.ui.notify(`DB: ${state.dbPath}`, "info");
				return;
			}

			if (arg === "stop") {
				if (state.server) {
					await state.server.stop();
					state.server = null;
					ctx.ui.notify("Finance web server stopped.", "info");
				} else {
					ctx.ui.notify("Finance web server is not running.", "info");
				}
				return;
			}

			if (arg === "seed") {
				const s = state.db.summary();
				if (s.tx_count > 0 || s.wallet_count > 0) {
					ctx.ui.notify("Database is not empty; refusing to seed.", "info");
					return;
				}
				const w1 = state.db.createWallet({ name: "Main wallet", currency: "USD", opening_minor: 250000, color: "#6366f1" });
				const w2 = state.db.createWallet({ name: "Savings", currency: "USD", opening_minor: 0, color: "#10b981" });
				const food = state.db.listCategories().find((c) => c.name === "Food")!;
				const bills = state.db.listCategories().find((c) => c.name === "Bills")!;
				const salary = state.db.listCategories().find((c) => c.name === "Salary")!;
				const rec = state.db.listTags().find((t) => t.name === "recurring")!;
				state.db.createTransaction({ wallet_id: w1.id, category_id: salary.id, type: "income", amount_minor: 350000, currency: "USD", note: "Monthly salary", occurred_at: "2026-06-01", tag_ids: [rec.id] });
				state.db.createTransaction({ wallet_id: w1.id, category_id: food.id, type: "expense", amount_minor: 2599, currency: "USD", note: "Groceries", occurred_at: "2026-06-03" });
				state.db.createTransaction({ wallet_id: w1.id, category_id: bills.id, type: "expense", amount_minor: 7900, currency: "USD", note: "Internet", occurred_at: "2026-06-05", tag_ids: [rec.id] });
				void w2; void food; void bills;
				ctx.ui.notify("Seeded sample data. Open the UI to see it.", "success");
				return;
			}

			// Default / "open" / "url": ensure the server is up and print the URL
			if (!state.server) {
				try {
					await ensureServer(ctx);
				} catch (e) {
					ctx.ui.notify(`Server start failed: ${(e as Error).message}`, "error");
					return;
				}
			}

			const url = state.server!.url;
			ctx.ui.notify(`Finance UI: ${url}`, "info");

			if (arg === "open" || arg === "") {
				// Try to open in the default browser. We don't fail if it doesn't work
				// (e.g. no DISPLAY on a headless server) — the URL is still printed.
				const opener =
					process.env.PI_FINANCE_BROWSER?.trim() ||
					(process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
				try {
					if (opener === "start") {
						pi.exec("cmd", ["/c", "start", "", url], { timeout: 4000 }).catch(() => {});
					} else {
						pi.exec(opener, [url], { timeout: 4000 }).catch(() => {});
					}
				} catch { /* ignore */ }
			}
		},
	});

	// Status footer — always show the URL when the server is running
	pi.on("session_start", async (_event, ctx) => {
		if (state.server && typeof (ctx.ui as { setStatus?: (k: string, v: string) => void }).setStatus === "function") {
			try { (ctx.ui as { setStatus: (k: string, v: string) => void }).setStatus("finance", fmtStatusLine()); } catch { /* */ }
		}
	});

	// Clean shutdown
	pi.on("session_shutdown", async () => {
		try {
			if (state.sweeperStop) {
				state.sweeperStop();
				state.sweeperStop = null;
			}
		} catch { /* ignore */ }
		try {
			if (state.server) {
				await state.server.stop();
				state.server = null;
			}
		} catch { /* ignore */ }
		try {
			if (state.db) state.db.close();
		} catch { /* ignore */ }
	});
}
