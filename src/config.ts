/**
 * Env-var configuration for the Groq media extraction feature.
 *
 * Reads all PI_FINANCE_GROQ_* and PI_FINANCE_MEDIA_* variables at runtime.
 * Returns `null` when PI_FINANCE_MEDIA_ENABLED === "0"; otherwise returns
 * a MediaConfig object (even if GROQ_API_KEY is missing — the not-configured
 * state is reported per-call, not at boot).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { MediaConfig } from "./types.js";

function envStr(name: string, fallback: string): string {
	return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number, min = 1): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function defaultTempDir(): string {
	return join(homedir(), ".pi", "agent", "finance-tracker", "tmp");
}

export function getMediaConfig(): MediaConfig | null {
	const enabled = process.env.PI_FINANCE_MEDIA_ENABLED;
	if (enabled === "0" || enabled?.toLowerCase() === "false") {
		return null;
	}

	const apiKey = process.env.GROQ_API_KEY?.trim() || process.env.PI_FINANCE_GROQ_API_KEY?.trim() || "";
	const baseUrl = envStr("PI_FINANCE_GROQ_BASE_URL", "https://api.groq.com/openai/v1");
	const modelAudio = envStr("PI_FINANCE_GROQ_MODEL_AUDIO", "whisper-large-v3");
	const modelImage = envStr("PI_FINANCE_GROQ_MODEL_IMAGE", "meta-llama/llama-4-scout-17b-16e-instruct");
	const modelPdfStructure = envStr("PI_FINANCE_GROQ_MODEL_PDF_STRUCTURE", "llama-3.3-70b-versatile");
	const maxBytes = envInt("PI_FINANCE_MEDIA_MAX_BYTES", 26214400); // 25 MB
	const tempDir = envStr("PI_FINANCE_MEDIA_TEMP_DIR", defaultTempDir());
	const ttlMinutes = envInt("PI_FINANCE_MEDIA_TTL_MINUTES", 30);
	const maxPdfPages = envInt("PI_FINANCE_MEDIA_MAX_PDF_PAGES", 50);

	return {
		apiKey,
		baseUrl,
		modelAudio,
		modelImage,
		modelPdfStructure,
		maxBytes,
		tempDir,
		ttlMs: ttlMinutes * 60 * 1000,
		enabled: true,
		maxPdfPages,
	};
}
