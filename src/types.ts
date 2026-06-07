/**
 * Shared types for the Groq media extraction feature.
 *
 * All monetary amounts are in integer minor units (cents/rupiah).
 * All interfaces follow the shapes defined in design.md §5.
 */

// ── Error codes ──────────────────────────────────────────────────────────

export type MediaErrorCode =
  | "unsupported_format"
  | "file_too_large"
  | "upload_failed"
  | "media_not_found"
  | "media_expired"
  | "not_configured"
  | "groq_unavailable"
  | "groq_rate_limited"
  | "groq_invalid_response"
  | "parse_failed"
  | "ocr_unavailable_for_scanned_pdf"
  | "duplicate_detected"
  | "not_implemented"; // stub code — replaced in PR 2

// ── Result envelope ──────────────────────────────────────────────────────

export type MediaResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: MediaErrorCode; message: string } };

// ── Config ───────────────────────────────────────────────────────────────

export interface MediaConfig {
  apiKey: string;
  baseUrl: string;
  modelAudio: string;
  modelImage: string;
  modelPdfStructure: string;
  maxBytes: number;
  tempDir: string;
  ttlMs: number;
  enabled: boolean;
  maxPdfPages: number;
}

// ── Domain shapes ────────────────────────────────────────────────────────

export interface AudioTranscript {
  text: string;
  language?: string;
  duration_sec?: number;
}

export interface ImageExtract {
  text: string;
  structured?: Record<string, unknown>;
}

export interface PdfExtract {
  text: string;
  page_count: number;
  transactions?: CandidateTransaction[];
}

export interface CandidateTransaction {
  occurred_at: string;
  amount_minor: number;
  currency: string;
  type: "income" | "expense";
  description: string;
  suggested_wallet_id?: number;
  suggested_category_id?: number;
  confidence: number;
  raw_line: string;
}

export interface MediaIngestResponse {
  media_id: string;
  kind: "audio" | "image" | "pdf";
  size_bytes: number;
  expires_at: string;
  detected_mime: string;
}

export interface BulkCreateRequest {
  wallet_id: number;
  default_currency: string;
  default_type?: "income" | "expense";
  transactions: CandidateTransaction[];
}

export interface BulkCreateResponse {
  created: unknown[]; // Transaction[] — typed loosely to avoid circular dep
  skipped: Array<{ candidate: CandidateTransaction; reason: string }>;
}

// Source kind for media provenance on transactions
export type MediaSourceKind = "audio" | "image" | "pdf";
