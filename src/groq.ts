/**
 * GroqClient — thin fetch wrapper for Groq's OpenAI-compatible API.
 *
 * Uses a DI seam for testing: accepts a `fetch` function in the constructor.
 * Real implementations for transcribe, extractImage, and extractPdfStructure.
 *
 * See design.md §3 for the rationale behind the thin wrapper vs `groq-sdk`.
 */

import type { MediaConfig, MediaResult, AudioTranscript, ImageExtract } from "./types.js";

interface GroqClientDeps {
	fetch?: typeof globalThis.fetch;
	sleep?: (ms: number) => Promise<void>;
}

/** Infer a filename extension from a MIME type. */
function extFromMime(mime: string): string {
	const map: Record<string, string> = {
		"audio/mpeg": "mp3",
		"audio/wav": "wav",
		"audio/ogg": "ogg",
		"audio/flac": "flac",
		"audio/mp4": "m4a",
		"audio/webm": "webm",
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"application/pdf": "pdf",
	};
	return map[mime] ?? "bin";
}

/** Fetch wrapper that never leaks the API key in errors/logs. */
async function groqFetch(
	fetchFn: typeof globalThis.fetch,
	url: string,
	init: RequestInit & { headers: Record<string, string> },
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn(url, { ...init, signal: controller.signal });
		return res;
	} finally {
		clearTimeout(timer);
	}
}

/** Helpers to build typed error results. */
function unavailable(msg: string): MediaResult<never> {
	return { ok: false, error: { code: "groq_unavailable", message: msg } };
}
function rateLimited(retryAfter?: string): MediaResult<never> {
	const msg = retryAfter
		? `Groq rate limited. Retry after ${retryAfter} seconds.`
		: "Groq rate limited.";
	return { ok: false, error: { code: "groq_rate_limited", message: msg } };
}
function invalidResponse(msg: string): MediaResult<never> {
	return { ok: false, error: { code: "groq_invalid_response", message: msg } };
}

export class GroqClient {
	private readonly config: MediaConfig;
	private readonly deps: Required<GroqClientDeps>;
	private readonly timeoutMs: number;

	constructor(config: MediaConfig, deps?: GroqClientDeps) {
		this.config = config;
		this.timeoutMs = 30_000; // 30-second timeout for Groq API calls

		const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
		this.deps = {
			fetch: deps?.fetch ?? globalThis.fetch.bind(globalThis),
			sleep: deps?.sleep ?? defaultSleep,
		};
	}

	getConfig(): MediaConfig {
		return this.config;
	}

	/**
	 * Transcribe an audio file via Groq's /audio/transcriptions endpoint.
	 */
	async transcribe(
		args: { file: Buffer | string; mime: string; language?: string },
	): Promise<MediaResult<AudioTranscript>> {
		const { file, mime, language } = args;
		const buf = typeof file === "string" ? Buffer.from(file) : file;
		const ext = extFromMime(mime);

		// Build a multipart/form-data body manually (no external deps).
		const boundary = "----GroqClientBoundary" + Math.random().toString(36).slice(2);
		const encoder = new TextEncoder();
		const parts: Uint8Array[] = [];

		function addPart(name: string, value: string | Uint8Array, contentType?: string) {
			let header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
			if (contentType) header += `\r\nContent-Type: ${contentType}`;
			header += "\r\n\r\n";
			parts.push(encoder.encode(header));
			parts.push(typeof value === "string" ? encoder.encode(value) : value);
			parts.push(encoder.encode("\r\n"));
		}

		addPart("file", buf, mime);
		addPart("model", this.config.modelAudio);
		addPart("response_format", "verbose_json");
		if (language) addPart("language", language);

		// Closing boundary
		parts.push(encoder.encode(`--${boundary}--\r\n`));

		const body = concatUint8Arrays(parts);

		try {
			const res = await groqFetch(
				this.deps.fetch,
				`${this.config.baseUrl}/audio/transcriptions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.config.apiKey}`,
						"Content-Type": `multipart/form-data; boundary=${boundary}`,
					},
					body: body as unknown as BodyInit,
				},
				this.timeoutMs,
			);

			if (res.status === 429) {
				return rateLimited(res.headers.get("Retry-After") ?? undefined);
			}
			if (!res.ok) {
				const bodyText = await res.text().catch(() => "");
				if (res.status >= 500) return unavailable(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
				return invalidResponse(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
			}

			const json: any = await res.json();
			if (typeof json?.text !== "string") {
				return invalidResponse("transcription missing 'text' field");
			}

			return {
				ok: true,
				data: {
					text: json.text,
					language: json.language ?? language,
					duration_sec: json.duration ?? undefined,
				},
			};
		} catch (e: any) {
			if (e.name === "AbortError") return unavailable("Groq request timed out");
			return unavailable(`Groq network error: ${e?.message ?? "unknown"}`);
		}
	}

	/**
	 * Extract information from an image via Groq's /chat/completions endpoint (vision model).
	 */
	async extractImage(
		args: { file: Buffer | string; mime: string; prompt?: string },
	): Promise<MediaResult<ImageExtract>> {
		const { file, mime, prompt } = args;
		const buf = typeof file === "string" ? Buffer.from(file) : file;
		const b64 = buf.toString("base64");
		const promptText = prompt || "Extract all text and structure from this image.";

		const body = {
			model: this.config.modelImage,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: `${promptText}\n\nReturn JSON with { text: string, structured: object | null }.` },
						{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
					],
				},
			],
			response_format: { type: "json_object" },
		};

		try {
			const res = await groqFetch(
				this.deps.fetch,
				`${this.config.baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
				this.timeoutMs,
			);

			if (res.status === 429) {
				return rateLimited(res.headers.get("Retry-After") ?? undefined);
			}
			if (!res.ok) {
				const bodyText = await res.text().catch(() => "");
				if (res.status >= 500) return unavailable(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
				return invalidResponse(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
			}

			const json: any = await res.json();
			const content = json?.choices?.[0]?.message?.content;
			if (typeof content !== "string") {
				return invalidResponse("image extraction: no content in response");
			}

			let parsed: any;
			try {
				parsed = JSON.parse(content);
			} catch {
				return invalidResponse("image extraction: response is not valid JSON");
			}

			return {
				ok: true,
				data: {
					text: parsed?.text ?? content,
					structured: parsed?.structured ?? null,
				},
			};
		} catch (e: any) {
			if (e.name === "AbortError") return unavailable("Groq request timed out");
			return unavailable(`Groq network error: ${e?.message ?? "unknown"}`);
		}
	}

	/**
	 * Send PDF text to Groq for structured extraction (JSON mode).
	 */
	async extractPdfStructure(
		args: { text: string; schema: object },
	): Promise<MediaResult<{ structured: Record<string, unknown> }>> {
		const { text } = args;

		const body = {
			model: this.config.modelPdfStructure,
			messages: [
				{
					role: "system",
					content:
						"You extract transactions from bank statements. Return JSON with `transactions: [...]`. Each transaction has: occurred_at (ISO date string), amount_minor (integer), currency (3-letter code), type ('income' or 'expense'), description (string), confidence (number between 0 and 1), raw_line (string that produced this candidate).",
				},
				{
					role: "user",
					content: `PDF text:\n${text}\n\nExtract transactions as JSON.`,
				},
			],
			response_format: { type: "json_object" },
		};

		try {
			const res = await groqFetch(
				this.deps.fetch,
				`${this.config.baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
				this.timeoutMs,
			);

			if (res.status === 429) {
				return rateLimited(res.headers.get("Retry-After") ?? undefined);
			}
			if (!res.ok) {
				const bodyText = await res.text().catch(() => "");
				if (res.status >= 500) return unavailable(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
				return invalidResponse(`Groq API returned ${res.status}: ${bodyText.slice(0, 200)}`);
			}

			const json: any = await res.json();
			const content = json?.choices?.[0]?.message?.content;
			if (typeof content !== "string") {
				return invalidResponse("PDF structure: no content in response");
			}

			let parsed: any;
			try {
				parsed = JSON.parse(content);
			} catch {
				return invalidResponse("PDF structure: response is not valid JSON");
			}

			return {
				ok: true,
				data: { structured: parsed as Record<string, unknown> },
			};
		} catch (e: any) {
			if (e.name === "AbortError") return unavailable("Groq request timed out");
			return unavailable(`Groq network error: ${e?.message ?? "unknown"}`);
		}
	}
}

/** Concatenate multiple Uint8Arrays into a single Buffer. */
function concatUint8Arrays(arrays: Uint8Array[]): Buffer {
	const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
	const result = Buffer.alloc(total);
	let offset = 0;
	for (const a of arrays) {
		result.set(a, offset);
		offset += a.byteLength;
	}
	return result;
}
