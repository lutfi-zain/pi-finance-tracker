/**
 * Tiny HTTP server for the finance tracker web UI.
 *
 * - Serves the static SPA from `src/ui/`
 * - Exposes a small REST API for CRUD on wallets, categories, tags, transactions
 * - PR 2 adds 7 new media routes (ingest, transcribe, extract-image, extract-pdf,
 *   GET/DELETE media, and bulk transactions)
 * - Same-process server, no external deps. Uses Node's built-in `http` module.
 * - `unref()`s the socket so it never blocks pi shutdown on its own.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FinanceDB, Wallet, TxType } from "./db.js";
import type { GroqClient } from "./groq.js";
import type { MediaConfig } from "./types.js";
import { writeTemp, readTemp, deleteTemp } from "./media/ingest.ts";
import { sniffMime } from "./media/mime.ts";

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
	multipart?: boolean; // true for routes that read multipart/form-data
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

/** Read raw body bytes, respecting a maximum size limit. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;

		// Register data handler first so the stream is always consumed.
		// The Content-Length check (below) may reject early but the stream
		// still needs to be drained to avoid ECONNRESET on the client.
		req.on("data", (c: Buffer) => {
			total += c.length;
			if (total > maxBytes) {
				// Pause the stream and reject — do NOT destroy the request
				// so the response can still be sent.
				req.pause();
				reject(Object.assign(new Error("file_too_large"), { code: "file_too_large" }));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);

		// Pre-check Content-Length header; reject early before buffering
		const cl = req.headers["content-length"];
		if (cl) {
			const n = Number(cl);
			if (Number.isFinite(n) && n > maxBytes) {
				reject(Object.assign(new Error("file_too_large"), { code: "file_too_large" }));
			}
		}
	});
}

/**
 * Simple multipart/form-data parser.
 * No external deps — parses by splitting on the boundary string.
 */
function parseMultipart(body: Buffer, contentType: string): Map<string, { filename?: string; contentType?: string; data: Buffer }> {
	const parts = new Map<string, { filename?: string; contentType?: string; data: Buffer }>();

	// Extract boundary
	const bdMatch = contentType.match(/boundary=([^;\s]+)/);
	if (!bdMatch) throw Object.assign(new Error("upload_failed: no boundary in Content-Type"), { code: "upload_failed" });
	const boundary = bdMatch[1];

	const delimiter = Buffer.from(`--${boundary}`);
	const endDelimiter = Buffer.from(`--${boundary}--`);
	let pos = 0;

	while (pos < body.length) {
		// Find next delimiter
		const delimIdx = body.indexOf(delimiter, pos);
		if (delimIdx === -1) break;
		const partStart = delimIdx + delimiter.length;

		// Skip \r\n after boundary
		let contentStart = partStart;
		while (contentStart < body.length && (body[contentStart] === 0x0d || body[contentStart] === 0x0a)) {
			contentStart++;
		}

		// Check for closing boundary
		if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break; // --

		// Find next boundary
		const nextDelim = body.indexOf(delimiter, contentStart);
		if (nextDelim === -1) break;

		// The part data from contentStart to nextDelim (trim trailing \r\n)
		let partDataEnd = nextDelim;
		while (partDataEnd > contentStart && (body[partDataEnd - 1] === 0x0d || body[partDataEnd - 1] === 0x0a)) {
			partDataEnd--;
		}
		const partData = body.slice(contentStart, partDataEnd);

		// Find blank line separating headers from body
		const headerEnd = findBuffer(partData, Buffer.from("\r\n\r\n"));
		if (headerEnd === -1) {
			pos = nextDelim;
			continue;
		}

		const headerStr = partData.slice(0, headerEnd).toString("utf8");
		const content = partData.slice(headerEnd + 4); // skip \r\n\r\n

		// Parse Content-Disposition
		const nameMatch = headerStr.match(/name="([^"]+)"/);
		const filenameMatch = headerStr.match(/filename="([^"]+)"/);
		const ctMatch = headerStr.match(/Content-Type:\s*(\S+)/i);

		const name = nameMatch ? nameMatch[1] : "";
		if (name) {
			parts.set(name, {
				filename: filenameMatch ? filenameMatch[1] : undefined,
				contentType: ctMatch ? ctMatch[1] : undefined,
				data: content,
			});
		}

		pos = nextDelim;
	}

	return parts;
}

/** Find a sub-buffer within a buffer (like indexOf for Buffer). */
function findBuffer(haystack: Buffer, needle: Buffer): number {
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) { match = false; break; }
		}
		if (match) return i;
	}
	return -1;
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

/** Send a typed MediaResult error as an HTTP response. */
function sendMediaError(res: ServerResponse, status: number, code: string, message: string): void {
	send(res, status, { ok: false, error: { code, message } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route builder
// ─────────────────────────────────────────────────────────────────────────────

function buildRoutes(
	db: FinanceDB,
	groqClient: GroqClient | null,
	mediaConfig: MediaConfig | null,
): Route[] {
	const R = (method: string, path: string, handler: Handler, opts?: { multipart?: boolean }): Route => {
		const paramNames: string[] = [];
		const re = new RegExp(
			"^" +
				path.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, (m) => {
					paramNames.push(m.slice(1));
					return "([^/]+)";
				}) +
				"/?$",
		);
		return { method, pattern: re, paramNames, handler, multipart: opts?.multipart };
	};

	// Assert that media features are configured
	const mediaOk = (): boolean => !!(groqClient && mediaConfig && mediaConfig.apiKey);

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
	// media_id format: 32-char lowercase hex (per writeTemp's randomBytes(16).toString("hex")).
	// Reject path-traversal characters and arbitrary strings. Use this in BOTH POST body params
	// and URL path params that get passed to readTemp()/deleteTemp().
	const MEDIA_ID_RE = /^[0-9a-f]{32}$/;
	const sanitizeMediaId = (obj: Record<string, unknown>, key: string): string => {
		const v = obj[key];
		if (typeof v !== "string" || !MEDIA_ID_RE.test(v)) {
			throw new Error(`invalid_${key}: must be 32 lowercase hex chars`);
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

	const routes: Route[] = [
		// health & summary ──────────────────────────────────────────────────
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
			const patch: Partial<Wallet> = {};
			if (b.name !== undefined) patch.name = requireString(b, "name", 80);
			if (b.kind !== undefined) patch.kind = requireCategoryKind(b);
			if (b.icon !== undefined) patch.icon = optionalString(b, "icon", 8) ?? "•";
			if (b.color !== undefined) patch.color = optionalString(b, "color", 16) ?? "#10b981";
			const c = db.updateCategory(id, patch) as any;
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
			const patch: Partial<Wallet> = {};
			if (b.name !== undefined) patch.name = requireString(b, "name", 60);
			if (b.color !== undefined) patch.color = optionalString(b, "color", 16) ?? "#f59e0b";
			const t = db.updateTag(id, patch) as any;
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

		// ── Media endpoints ─────────────────────────────────────────────

		// POST /api/media/ingest — multipart file upload
		R("POST", "/api/media/ingest", async (req, res, _p, rawBody) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			try {
				const body = rawBody as Buffer;
				const ct = req.headers["content-type"] || "";
				const parts = parseMultipart(body, ct);
				const filePart = parts.get("file");
				if (!filePart || filePart.data.length === 0) {
					return sendMediaError(res, 400, "upload_failed", "No file field in upload");
				}

				// MIME sniff from first 4 KB
				let sniffed;
				try {
					sniffed = sniffMime(filePart.data.subarray(0, 4096));
				} catch (e: any) {
					return sendMediaError(res, 415, "unsupported_format", e?.message ?? "Unsupported format");
				}

				// Size check
				const maxBytes = mediaConfig!.maxBytes;
				if (filePart.data.length > maxBytes) {
					return sendMediaError(res, 413, "file_too_large",
						`File too large (${filePart.data.length} bytes, max ${maxBytes})`);
				}

				// Write temp file with sidecar metadata
				const result = writeTemp(filePart.data, sniffed.kind, sniffed.mime, {
					tempDir: mediaConfig!.tempDir,
					ttlMs: mediaConfig!.ttlMs,
					originalName: filePart.filename,
				});

				send(res, 200, {
					ok: true,
					data: {
						media_id: result.mediaId,
						kind: sniffed.kind,
						size_bytes: filePart.data.length,
						expires_at: result.expiresAt.toISOString(),
						detected_mime: sniffed.mime,
					},
				});
			} catch (e: any) {
				const code = e?.code || "upload_failed";
				const status = code === "file_too_large" ? 413 : 400;
				sendMediaError(res, status, code, e?.message ?? "Upload failed");
			}
		}, { multipart: true }),

		// POST /api/media/transcribe
		R("POST", "/api/media/transcribe", async (_req, res, _p, body) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			const b = body as Record<string, unknown>;
			const mediaId = sanitizeMediaId(b, "media_id");
			const language = optionalString(b, "language", 10);

			const read = readTemp(mediaId, mediaConfig!.tempDir, mediaConfig!.ttlMs);
			if (!read) {
				return sendMediaError(res, 404, "media_not_found", "Media not found or expired");
			}
			if (read.kind !== "audio") {
				return sendMediaError(res, 422, "unsupported_format", "Not an audio file");
			}

			const result = await groqClient!.transcribe({ file: read.buffer, mime: read.mime, language });
			if (!result.ok) {
				const status = result.error.code === "groq_rate_limited" ? 429
					: result.error.code === "groq_unavailable" ? 502
					: result.error.code === "groq_invalid_response" ? 502
					: 502;
				return sendMediaError(res, status, result.error.code, result.error.message);
			}
			send(res, 200, { ok: true, data: result.data });
		}),

		// POST /api/media/extract-image
		R("POST", "/api/media/extract-image", async (_req, res, _p, body) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			const b = body as Record<string, unknown>;
			const mediaId = sanitizeMediaId(b, "media_id");
			const prompt = optionalString(b, "prompt", 1000);

			const read = readTemp(mediaId, mediaConfig!.tempDir, mediaConfig!.ttlMs);
			if (!read) {
				return sendMediaError(res, 404, "media_not_found", "Media not found or expired");
			}
			if (read.kind !== "image") {
				return sendMediaError(res, 422, "unsupported_format", "Not an image file");
			}

			const result = await groqClient!.extractImage({ file: read.buffer, mime: read.mime, prompt });
			if (!result.ok) {
				const status = result.error.code === "groq_rate_limited" ? 429 : 502;
				return sendMediaError(res, status, result.error.code, result.error.message);
			}
			send(res, 200, { ok: true, data: result.data });
		}),

		// POST /api/media/extract-pdf
		R("POST", "/api/media/extract-pdf", async (_req, res, _p, body) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			const b = body as Record<string, unknown>;
			const mediaId = sanitizeMediaId(b, "media_id");
			const parseAs = (b.parse_as as string) || "text";

			const read = readTemp(mediaId, mediaConfig!.tempDir, mediaConfig!.ttlMs);
			if (!read) {
				return sendMediaError(res, 404, "media_not_found", "Media not found or expired");
			}
			if (read.kind !== "pdf") {
				return sendMediaError(res, 422, "unsupported_format", "Not a PDF file");
			}

			if (parseAs === "text") {
				// Use pdf-parse locally to extract raw text
				try {
					const pdfParse = (await import("pdf-parse")).default;
					const pdfData = await pdfParse(read.buffer);
					send(res, 200, {
						ok: true,
						data: {
							text: pdfData.text,
							page_count: pdfData.numpages ?? 0,
							transactions: undefined,
						},
					});
				} catch (e: any) {
					sendMediaError(res, 502, "parse_failed", `PDF parse error: ${e?.message ?? "unknown"}`);
				}
			} else if (parseAs === "transactions") {
				try {
					const pdfParse = (await import("pdf-parse")).default;
					const pdfData = await pdfParse(read.buffer);
					const pdfText = pdfData.text?.trim();
					if (!pdfText) {
						return sendMediaError(res, 422, "ocr_unavailable_for_scanned_pdf",
							"PDF appears scanned (no extractable text). OCR not available for scanned PDFs.");
					}
					const result = await groqClient!.extractPdfStructure({ text: pdfText, schema: {} });
					if (!result.ok) {
						const status = result.error.code === "groq_rate_limited" ? 429 : 502;
						return sendMediaError(res, status, result.error.code, result.error.message);
					}
					const structured = result.data.structured as any;
					const transactions = Array.isArray(structured?.transactions) ? structured.transactions : [];
					send(res, 200, {
						ok: true,
						data: {
							text: pdfText,
							page_count: pdfData.numpages ?? 0,
							transactions,
						},
					});
				} catch (e: any) {
					sendMediaError(res, 502, "parse_failed", `PDF parse error: ${e?.message ?? "unknown"}`);
				}
			} else {
				sendMediaError(res, 400, "invalid_parse_as", "parse_as must be 'text' or 'transactions'");
			}
		}),

		// GET /api/media/:media_id — binary stream
		R("GET", "/api/media/:media_id", (_req, res, p) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			// Sanitize media_id to prevent path traversal — must be 32 lowercase hex chars
			if (typeof p.media_id !== "string" || !MEDIA_ID_RE.test(p.media_id)) {
				return sendMediaError(res, 404, "media_not_found", "Invalid media ID format");
			}
			const mediaId = p.media_id;
			const read = readTemp(mediaId, mediaConfig!.tempDir, mediaConfig!.ttlMs);
			if (!read) {
				return sendMediaError(res, 404, "media_not_found", "Media not found or expired");
			}
			res.writeHead(200, {
				"content-type": read.mime,
				"content-length": read.buffer.length,
				"cache-control": "no-store",
			});
			res.end(read.buffer);
		}),

		// DELETE /api/media/:media_id
		R("DELETE", "/api/media/:media_id", (_req, res, p) => {
			if (!mediaOk()) {
				return sendMediaError(res, 503, "not_configured", "GROQ_API_KEY is not set");
			}
			if (typeof p.media_id !== "string" || !MEDIA_ID_RE.test(p.media_id)) {
				return sendMediaError(res, 404, "media_not_found", "Invalid media ID format");
			}
			const mediaId = p.media_id;
			const deleted = deleteTemp(mediaId, mediaConfig!.tempDir);
			if (!deleted) {
				return sendMediaError(res, 404, "media_not_found", "Media not found");
			}
			send(res, 200, { ok: true });
		}),

		// POST /api/transactions/bulk
		R("POST", "/api/transactions/bulk", async (_req, res, _p, body) => {
			const b = body as Record<string, unknown>;
			const walletId = requireInt(b, "wallet_id", 1);
			const defaultCurrency = requireString(b, "default_currency", 8).toUpperCase();
			// Optional provenance (per provenance-and-traceability spec):
			//   - source_filename: original PDF filename as uploaded by the user
			//   - source_sha256_hex: 64-char lowercase hex SHA-256 of the source PDF bytes
			// When provided, we prepend `from pdf: <filename> (sha256:<hex>)` to the transaction
			// note so the user can search/filter bulk-imported transactions.
			const sourceFilename = optionalString(b, "source_filename", 200);
			const sourceSha256Hex = optionalString(b, "source_sha256_hex", 64);
			if (sourceSha256Hex && !/^[0-9a-f]{64}$/.test(sourceSha256Hex)) {
				return sendError(res, 400, "source_sha256_hex must be 64 lowercase hex chars", "invalid_source_sha256_hex");
			}
			const provenanceLine = (() => {
				if (!sourceFilename && !sourceSha256Hex) return "";
				const parts: string[] = [];
				if (sourceFilename) parts.push(sourceFilename);
				if (sourceSha256Hex) parts.push(`(sha256:${sourceSha256Hex})`);
				return `from pdf: ${parts.join(" ")}`;
			})();
			const candidates = b.transactions;
			if (!Array.isArray(candidates)) {
				return sendError(res, 400, "transactions must be an array", "invalid_transactions");
			}

			const created: any[] = [];
			const skipped: Array<{ candidate: any; reason: string; existing_transaction_id?: number }> = [];

			for (const cand of candidates) {
				// Validation
				const amount_minor = cand.amount_minor;
				if (typeof amount_minor !== "number" || !Number.isInteger(amount_minor) || amount_minor < 1) {
					skipped.push({ candidate: cand, reason: "invalid_amount" });
					continue;
				}
				const currency = (cand.currency || defaultCurrency).toUpperCase();
				if (typeof currency !== "string" || currency.length !== 3) {
					skipped.push({ candidate: cand, reason: "invalid_currency" });
					continue;
				}
				const occurred_at = cand.occurred_at;
				if (typeof occurred_at !== "string" || isNaN(Date.parse(occurred_at))) {
					skipped.push({ candidate: cand, reason: "invalid_occurred_at" });
					continue;
				}
				const txType = cand.type || "expense";
				if (txType !== "income" && txType !== "expense") {
					skipped.push({ candidate: cand, reason: "invalid_type" });
					continue;
				}

				// Dedup heuristic: same wallet, same amount, ±2 days
				const dupes = db.listTransactions({ walletId, type: txType });
				const foundDup = dupes.find(
					(tx: any) =>
						tx.amount_minor === amount_minor &&
						tx.currency === currency &&
						Math.abs(new Date(tx.occurred_at).getTime() - new Date(occurred_at).getTime()) <= 2 * 24 * 60 * 60 * 1000,
				);
				if (foundDup) {
					skipped.push({
						candidate: cand,
						reason: "duplicate_detected",
						existing_transaction_id: foundDup.id,
					});
					continue;
				}

				// Create the transaction
				try {
					// Find or infer category — use suggested_category_id if it looks valid
					const category_id = cand.suggested_category_id && typeof cand.suggested_category_id === "number"
						? cand.suggested_category_id
						: null;
					const tx = db.createTransaction({
						wallet_id: walletId,
						category_id,
						type: txType,
						amount_minor,
						currency,
						note: provenanceLine
							? (cand.description ? `${provenanceLine}\n${cand.description}` : provenanceLine)
							: (cand.description || ""),
						occurred_at,
						media_path: cand.media_path || null,
						media_source_kind: "pdf",
					});
					created.push(tx);
				} catch (e: any) {
					skipped.push({ candidate: cand, reason: `create_failed: ${(e as Error).message.slice(0, 100)}` });
				}
			}

			send(res, 200, { created, skipped });
		}),
	];

	return routes;
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

export async function startServer(
	db: FinanceDB,
	preferredPort = 3847,
	hostname = "127.0.0.1",
	groqClient?: GroqClient | null,
	mediaConfig?: MediaConfig | null,
): Promise<ServerHandle> {
	const routes = buildRoutes(db, groqClient ?? null, mediaConfig ?? null);

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
					let body: unknown;
					if (r.multipart) {
						const maxBytes = mediaConfig?.maxBytes ?? 26214400;
						const rawBody = await readRawBody(req, maxBytes);
						body = rawBody;
					} else if (["POST", "PUT", "PATCH"].includes(req.method ?? "")) {
						body = await readJson(req);
					}
					await r.handler(req, res, params, body);
				} catch (e) {
					const msg = (e as Error).message;
					const code = (e as any).code || msg.split(":")[0];
					const status = code === "payload_too_large" ? 413 : code === "file_too_large" ? 413 : code === "invalid_json" ? 400 : 400;
					// Use MediaResult envelope for media-file-related errors
					if (code === "file_too_large" || code === "unsupported_format") {
						sendMediaError(res, status, code, msg);
					} else {
						sendError(res, status, msg, code);
					}
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
