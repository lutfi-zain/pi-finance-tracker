/**
 * GroqClient — thin fetch wrapper for Groq's OpenAI-compatible API.
 *
 * Uses a DI seam for testing: accepts a `fetch` function in the constructor.
 * Methods are stubbed in PR 1 (return `not_implemented`) — real implementations
 * will be wired in PR 2.
 *
 * See design.md §3 for the rationale behind the thin wrapper vs `groq-sdk`.
 */

import type { MediaConfig, MediaResult, AudioTranscript, ImageExtract } from "./types.js";

interface GroqClientDeps {
	fetch?: typeof globalThis.fetch;
	sleep?: (ms: number) => Promise<void>;
}

export class GroqClient {
	private readonly config: MediaConfig;
	private readonly deps: Required<GroqClientDeps>;

	constructor(config: MediaConfig, deps?: GroqClientDeps) {
		this.config = config;

		// Default to global fetch and a simple promise-based sleep
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
	 *
	 * PR 1: Stubbed — returns not_implemented.
	 * PR 2: Replaces with a real fetch call using the OpenAI-compatible API.
	 */
	async transcribe(
		args: { file: Buffer | string; mime: string; language?: string },
	): Promise<MediaResult<AudioTranscript>> {
		void args; // Unused in stub — will be used in PR 2
		return {
			ok: false,
			error: { code: "not_implemented", message: "Audio transcription not yet implemented (planned for PR 2)." },
		};
	}

	/**
	 * Extract information from an image via Groq's /chat/completions endpoint.
	 *
	 * PR 1: Stubbed — returns not_implemented.
	 * PR 2: Replaces with a real fetch call using the vision model.
	 */
	async extractImage(
		args: { file: Buffer | string; mime: string; prompt?: string },
	): Promise<MediaResult<ImageExtract>> {
		void args; // Unused in stub
		return {
			ok: false,
			error: { code: "not_implemented", message: "Image extraction not yet implemented (planned for PR 2)." },
		};
	}

	/**
	 * Send PDF text to Groq for structured extraction (JSON mode).
	 *
	 * PR 1: Stubbed — returns not_implemented.
	 * PR 2: Replaces with a real call using the structured model.
	 */
	async extractPdfStructure(
		args: { text: string; schema: object },
	): Promise<MediaResult<{ structured: Record<string, unknown> }>> {
		void args; // Unused in stub
		return {
			ok: false,
			error: { code: "not_implemented", message: "PDF structure extraction not yet implemented (planned for PR 2)." },
		};
	}
}
