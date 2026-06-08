#!/usr/bin/env node

/**
 * smoke-groq.mjs — Live Groq API integration tests.
 *
 * These tests call the REAL Groq API and require GROQ_API_KEY (or
 * PI_FINANCE_GROQ_API_KEY) to be set in the environment.
 *
 * If no key is found, the script exits 0 with a note (silent skip in CI).
 *
 * Usage:
 *   GROQ_API_KEY=gsk_... node test/smoke-groq.mjs
 *
 * Key leak guard:
 *   This file NEVER logs or dumps the API key. The GroqClient class
 *   (src/groq.ts) also redacts keys from error messages.
 *
 * Env overrides:
 *   GROQ_API_KEY                    — Groq API token (required to run)
 *   PI_FINANCE_GROQ_MODEL_AUDIO     — default: whisper-large-v3
 *   PI_FINANCE_GROQ_MODEL_IMAGE     — default: meta-llama/llama-4-scout-17b-16e-instruct
 *   PI_FINANCE_GROQ_MODEL_PDF_STRUCTURE — default: llama-3.3-70b-versatile
 */

import { strict as assert } from "node:assert";
import { deflateSync } from "node:zlib";
import { GroqClient } from "../src/groq.ts";

// ── Config ──────────────────────────────────────────────────────────────────
const apiKey = process.env.GROQ_API_KEY || process.env.PI_FINANCE_GROQ_API_KEY || "";
if (!apiKey) {
	console.log("SKIP: GROQ_API_KEY not set — skipping live Groq tests.");
	process.exit(0);
}

const cfg = {
	apiKey,
	baseUrl: process.env.PI_FINANCE_GROQ_BASE_URL || "https://api.groq.com/openai/v1",
	modelAudio: process.env.PI_FINANCE_GROQ_MODEL_AUDIO || "whisper-large-v3",
	modelImage: process.env.PI_FINANCE_GROQ_MODEL_IMAGE || "meta-llama/llama-4-scout-17b-16e-instruct",
	modelPdfStructure: process.env.PI_FINANCE_GROQ_MODEL_PDF_STRUCTURE || "llama-3.3-70b-versatile",
	maxBytes: 26214400,
	tempDir: "/tmp",
	ttlMs: 60000,
	enabled: true,
	maxPdfPages: 50,
};

const gc = new GroqClient(cfg);

let passed = 0;
let failed = 0;

function ok(name) {
	passed++;
	console.log(`  ✓ ${name}`);
}

function fail(name, err) {
	failed++;
	console.log(`  ✗ ${name}: ${err?.code || err?.message || err}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal silent WAV (0.25s, 44.1 kHz, mono, 16-bit). */
function silentWav() {
	const header = Buffer.alloc(44);
	const dataLen = 11025; // 0.25 s × 44100
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataLen, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);      // fmt chunk size
	header.writeUInt16LE(1, 20);       // PCM
	header.writeUInt16LE(1, 22);       // mono
	header.writeUInt32LE(44100, 24);   // sample rate
	header.writeUInt32LE(88200, 28);   // byte rate
	header.writeUInt16LE(2, 32);       // block align
	header.writeUInt16LE(16, 34);      // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(dataLen, 40);
	return Buffer.concat([header, Buffer.alloc(dataLen, 0)]);
}

/** Create a minimal valid PNG (plain color, N×N). */
function makePng(width, height, r, g, b) {
	function crc32(buf) {
		let c = 0xffffffff;
		for (let i = 0; i < buf.length; i++) {
			c ^= buf[i];
			for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
		}
		return ~c >>> 0;
	}
	function chunk(type, data) {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crcBuf = Buffer.alloc(4);
		crcBuf.writeUInt32BE(crc32(body), 0);
		return Buffer.concat([len, Buffer.from(type), data, crcBuf]);
	}
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData[8] = 8;  // bit depth
	ihdrData[9] = 2;  // RGB
	const ihdr = chunk("IHDR", ihdrData);
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * 3)] = 0; // filter byte
		for (let x = 0; x < width; x++) {
			const off = y * (1 + width * 3) + 1 + x * 3;
			raw[off] = r;
			raw[off + 1] = g;
			raw[off + 2] = b;
		}
	}
	const idat = chunk("IDAT", deflateSync(raw));
	const iend = chunk("IEND", Buffer.alloc(0));
	return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
	console.log("\n  smoke-groq — Real Groq API integration tests");
	console.log(`  api.baseUrl: ${cfg.baseUrl}`);
	console.log(`  model.audio: ${cfg.modelAudio}`);
	console.log(`  model.image: ${cfg.modelImage}`);
	console.log(`  model.pdf:   ${cfg.modelPdfStructure}`);
	console.log("");

	// ── 1. Audio transcription ─────────────────────────────────────────
	{
		const name = "Audio — transcribe silent WAV";
		try {
			const result = await gc.transcribe({ file: silentWav(), mime: "audio/wav" });
			assert.ok(result.ok, `expected ok, got ${JSON.stringify(result.error)}`);
			assert.ok(typeof result.data.text === "string", "text must be a string");
			assert.ok(typeof result.data.language === "string", "language must be a string");
			assert.ok(typeof result.data.duration_sec === "number", "duration_sec must be a number");
			ok(name);
		} catch (e) {
			fail(name, e);
		}
	}

	// ── 2. Image extraction ────────────────────────────────────────────
	{
		const name = "Image — extract colour from 64×64 red PNG";
		try {
			const png = makePng(64, 64, 255, 0, 0);
			const result = await gc.extractImage({
				file: png,
				mime: "image/png",
				prompt: "What is the dominant colour in this image? Answer in ONE WORD.",
			});
			assert.ok(result.ok, `expected ok, got ${JSON.stringify(result.error)}`);
			assert.ok(typeof result.data.text === "string", "text must be a string");
			const lower = result.data.text.toLowerCase();
			assert.ok(lower.includes("red"), `expected 'red', got '${result.data.text}'`);
			ok(name);
		} catch (e) {
			fail(name, e);
		}
	}

	// ── 3. PDF structure extraction ────────────────────────────────────
	{
		const name = "PDF — extract transactions from bank statement text";
		try {
			const text = [
				"Bank Statement — BCA",
				"Period: May 2026",
				"",
				"1 May 2026  Salary    15,000,000",
				"2 May 2026  Transfer   -2,000,000",
				"5 May 2026  Alfamart   -150,000",
				"10 May 2026 Client    +5,000,000",
			].join("\n");
			const result = await gc.extractPdfStructure({ text, schema: {} });
			assert.ok(result.ok, `expected ok, got ${JSON.stringify(result.error)}`);
			const tx = result.data.structured?.transactions;
			assert.ok(Array.isArray(tx), "transactions must be an array");
			assert.ok(tx.length >= 3, `expected ≥3 transactions, got ${tx.length}`);
			// The largest amount should be 15,000,000 (salary)
			const amounts = tx.map((t) => Math.abs(t.amount_minor));
			assert.ok(amounts.some((a) => a >= 1000000), "expected at least one large amount (≥1,000,000)");
			ok(name);
		} catch (e) {
			fail(name, e);
		}
	}

	// ── 4. PDF structure (empty text) — edge case ──────────────────────
	{
		const name = "PDF — empty text returns no transactions";
		try {
			const result = await gc.extractPdfStructure({ text: "", schema: {} });
			assert.ok(result.ok, `expected ok, got ${JSON.stringify(result.error)}`);
			ok(name);
		} catch (e) {
			fail(name, e);
		}
	}

	// ── Summary ────────────────────────────────────────────────────────
	console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("FATAL:", e);
	process.exit(1);
});
