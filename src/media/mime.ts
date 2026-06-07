/**
 * MIME type sniffer for uploaded media files.
 *
 * Reads the first 4 KB of a buffer and inspects magic bytes to determine
 * the real content type (server-side, not trusting client Content-Type).
 *
 * Allowlist: audio/*, image/jpeg|png|webp, application/pdf.
 * image/heic and image/gif are explicitly rejected (not in allowlist).
 */

export interface SniffResult {
	kind: "audio" | "image" | "pdf";
	mime: string;
}

/**
 * Allowed MIME types — referenced by routes for validation.
 */
export const MIME_ALLOWLIST: ReadonlyArray<{ kind: SniffResult["kind"]; mime: string }> = [
	{ kind: "audio", mime: "audio/mpeg" },
	{ kind: "audio", mime: "audio/wav" },
	{ kind: "audio", mime: "audio/mp4" },
	{ kind: "audio", mime: "audio/m4a" },
	{ kind: "audio", mime: "audio/ogg" },
	{ kind: "audio", mime: "audio/flac" },
	{ kind: "image", mime: "image/jpeg" },
	{ kind: "image", mime: "image/png" },
	{ kind: "image", mime: "image/webp" },
	{ kind: "pdf", mime: "application/pdf" },
];

/**
 * Sniff the MIME type from the first 4 KB of a file buffer.
 * Throws `unsupported_format` if the magic bytes don't match the allowlist.
 */
export function sniffMime(first4kb: Buffer): SniffResult {
	if (first4kb.length < 4) {
		throw Object.assign(new Error("unsupported_format: file too small to sniff"), { code: "unsupported_format" });
	}

	// application/pdf — starts with %PDF
	if (
		first4kb[0] === 0x25 &&
		first4kb[1] === 0x50 &&
		first4kb[2] === 0x44 &&
		first4kb[3] === 0x46
	) {
		return { kind: "pdf", mime: "application/pdf" };
	}

	// image/jpeg — starts with FF D8 FF
	if (
		first4kb[0] === 0xff &&
		first4kb[1] === 0xd8 &&
		first4kb[2] === 0xff
	) {
		return { kind: "image", mime: "image/jpeg" };
	}

	// image/png — starts with 89 50 4E 47 0D 0A 1A 0A
	if (
		first4kb[0] === 0x89 &&
		first4kb[1] === 0x50 &&
		first4kb[2] === 0x4e &&
		first4kb[3] === 0x47 &&
		first4kb[4] === 0x0d &&
		first4kb[5] === 0x0a &&
		first4kb[6] === 0x1a &&
		first4kb[7] === 0x0a
	) {
		return { kind: "image", mime: "image/png" };
	}

	// image/webp — starts with RIFF .... WEBP
	if (
		first4kb[0] === 0x52 &&
		first4kb[1] === 0x49 &&
		first4kb[2] === 0x46 &&
		first4kb[3] === 0x46 &&
		first4kb.length >= 12 &&
		first4kb[8] === 0x57 &&
		first4kb[9] === 0x45 &&
		first4kb[10] === 0x42 &&
		first4kb[11] === 0x50
	) {
		return { kind: "image", mime: "image/webp" };
	}

	// image/gif — explicitly rejected
	if (
		first4kb[0] === 0x47 &&
		first4kb[1] === 0x49 &&
		first4kb[2] === 0x46 &&
		first4kb[3] === 0x38
	) {
		throw Object.assign(new Error("unsupported_format: GIF is not supported (use JPEG/PNG/WEBP)"), { code: "unsupported_format" });
	}

	// image/heic — explicitly rejected (not in PR 1 allowlist)
	if (
		first4kb.length >= 12 &&
		first4kb[4] === 0x66 &&
		first4kb[5] === 0x74 &&
		first4kb[6] === 0x79 &&
		first4kb[7] === 0x70 &&
		first4kb[8] === 0x68 &&
		first4kb[9] === 0x65 &&
		first4kb[10] === 0x69 &&
		first4kb[11] === 0x63
	) {
		throw Object.assign(new Error("unsupported_format: HEIC is not supported in this version"), { code: "unsupported_format" });
	}

	// audio/mpeg (MP3) — ID3v2 tag starts with ID3
	if (
		first4kb[0] === 0x49 &&
		first4kb[1] === 0x44 &&
		first4kb[2] === 0x33
	) {
		return { kind: "audio", mime: "audio/mpeg" };
	}

	// audio/mpeg — raw MP3 frame sync (FF FB, FF FA, FF F3, FF F2)
	if (
		first4kb[0] === 0xff &&
		(first4kb[1] & 0xe0) === 0xe0 &&
		(first4kb[1] & 0x06) !== 0 // valid MPEG version bits
	) {
		return { kind: "audio", mime: "audio/mpeg" };
	}

	// audio/wav — RIFF .... WAV E
	if (
		first4kb[0] === 0x52 &&
		first4kb[1] === 0x49 &&
		first4kb[2] === 0x46 &&
		first4kb[3] === 0x46 &&
		first4kb.length >= 12 &&
		first4kb[8] === 0x57 &&
		first4kb[9] === 0x41 &&
		first4kb[10] === 0x56 &&
		first4kb[11] === 0x45
	) {
		return { kind: "audio", mime: "audio/wav" };
	}

	// audio/ogg — OggS
	if (
		first4kb[0] === 0x4f &&
		first4kb[1] === 0x67 &&
		first4kb[2] === 0x67 &&
		first4kb[3] === 0x53
	) {
		return { kind: "audio", mime: "audio/ogg" };
	}

	// audio/flac — fLaC
	if (
		first4kb[0] === 0x66 &&
		first4kb[1] === 0x4c &&
		first4kb[2] === 0x61 &&
		first4kb[3] === 0x43
	) {
		return { kind: "audio", mime: "audio/flac" };
	}

	// audio/mp4/m4a — .... ftypM4A (or ftypmp42, ftypisom, etc.)
	if (
		first4kb.length >= 12 &&
		first4kb[4] === 0x66 &&
		first4kb[5] === 0x74 &&
		first4kb[6] === 0x79 &&
		first4kb[7] === 0x70
	) {
		// ftyp box — check for M4A or mp42 variants
		const brand = first4kb.toString("ascii", 8, 12);
		if (brand === "M4A " || brand === "mp42" || brand === "isom" || brand === "mp41") {
			return { kind: "audio", mime: "audio/mp4" };
		}
	}

	throw Object.assign(new Error("unsupported_format: file type not recognised or not allowed"), { code: "unsupported_format" });
}
