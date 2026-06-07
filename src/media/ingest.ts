/**
 * Temporary file ingest helpers for uploaded media.
 *
 * Files are written to a temp dir with restricted permissions (0o600),
 * tracked by a ULID-like media ID, and automatically expired by a sweeper.
 *
 * Temp dir layout: `<tempDir>/<mediaId>` (single file per ID).
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, chmodSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a compact unique media ID (32 hex chars from 16 random bytes).
 */
function generateMediaId(): string {
	return randomBytes(16).toString("hex");
}

const isWindows = platform() === "win32";

/**
 * Ensure the temp directory exists with 0o700 permissions.
 */
function ensureTempDir(tempDir: string): void {
	mkdirSync(tempDir, { recursive: true, mode: 0o700 });
}

/**
 * Set file permissions to 0o600. No-op on Windows with a log warning.
 */
function setFilePerms(path: string): void {
	if (isWindows) {
		// chmod is mostly a no-op on Windows; log and continue
		console.warn(`[media/ingest] chmod ignored on Windows for ${path}`);
		return;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// If the filesystem doesn't support permissions, continue silently
	}
}

// ── Public API ───────────────────────────────────────────────────────────

export interface WriteTempResult {
	mediaId: string;
	path: string;
	expiresAt: Date;
}

/**
 * Write a buffer to the temp directory with 0o600 permissions.
 *
 * @param bytes - The file content.
 * @param kind  - Media kind ("audio", "image", "pdf").
 * @param opts  - tempDir base path and ttlMs for expiration.
 * @returns The media ID, full path, and expiry timestamp.
 */
export function writeTemp(
	bytes: Buffer,
	kind: "audio" | "image" | "pdf",
	opts: { tempDir: string; ttlMs: number },
): WriteTempResult {
	ensureTempDir(opts.tempDir);
	const mediaId = generateMediaId();
	const filePath = join(opts.tempDir, mediaId);
	writeFileSync(filePath, bytes, { mode: 0o600 });
	setFilePerms(filePath);
	return {
		mediaId,
		path: filePath,
		expiresAt: new Date(Date.now() + opts.ttlMs),
	};
}

/**
 * Read a temp file back. Returns null if the file doesn't exist or is expired.
 */
export function readTemp(
	mediaId: string,
	tempDir: string,
	ttlMs: number,
): { buffer: Buffer; mime: string; kind: string } | null {
	const filePath = join(tempDir, mediaId);
	if (!existsSync(filePath)) return null;

	// Check expiry
	const stat = statSync(filePath);
	const age = Date.now() - stat.mtimeMs;
	if (age > ttlMs) {
		// File is expired; caller should map to media_expired
		return null;
	}

	const buffer = readFileSync(filePath);
	// We don't store MIME on disk; caller re-sniffs or knows from context
	return { buffer, mime: "application/octet-stream", kind: "unknown" };
}

/**
 * Delete a temp file by media ID.
 *
 * @returns true if the file was deleted, false if it didn't exist.
 */
export function deleteTemp(mediaId: string, tempDir: string): boolean {
	const filePath = join(tempDir, mediaId);
	if (!existsSync(filePath)) return false;
	unlinkSync(filePath);
	return true;
}

/**
 * Sweep expired temp files. Returns the count deleted.
 */
export function sweepExpired(tempDir: string, ttlMs: number): number {
	if (!existsSync(tempDir)) return 0;
	const now = Date.now();
	let deleted = 0;
	for (const entry of readdirSync(tempDir)) {
		const filePath = join(tempDir, entry);
		try {
			const st = statSync(filePath);
			if (!st.isFile()) continue;
			if (now - st.mtimeMs > ttlMs) {
				unlinkSync(filePath);
				deleted++;
			}
		} catch {
			// Stale entry, skip
		}
	}
	return deleted;
}

/**
 * Start a periodic sweeper that cleans expired temp files.
 *
 * @returns An object with a `stop()` method to cancel the interval.
 */
export function startSweeper(
	tempDir: string,
	ttlMs: number,
	intervalMs: number,
): { stop: () => void } {
	const handle = setInterval(() => {
		try {
			sweepExpired(tempDir, ttlMs);
		} catch {
			// Sweeper errors are non-fatal
		}
	}, intervalMs);
	handle.unref();
	return {
		stop: () => clearInterval(handle),
	};
}
