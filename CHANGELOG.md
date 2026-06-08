# Changelog

All notable changes to **pi-finance-tracker** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-06-07

### Added
- **Groq media features** — 3 new `media_*` LLM tools and 7 new HTTP
  routes for uploading, transcribing, extracting, and importing media.
- **Audio transcription** — `media_transcribe_audio` tool uses
  `whisper-large-v3` (Groq) to transcribe voice memos, meeting recordings,
  or expense notes.
- **Image reading** — `media_extract_image` tool uses
  `meta-llama/llama-4-scout-17b-16e-instruct` (Groq vision) to extract
  text, amounts, and structure from receipt/invoice photos.
- **PDF extraction** — `media_extract_pdf` tool uses `pdf-parse` for text
  extraction then `llama-3.3-70b-versatile` (Groq JSON-mode) for
  structured transaction parsing.
- **Bank-statement import** — `media_import_bank_statement` tool + bulk
  `POST /api/transactions/bulk` endpoint with SHA-256 provenance and
  deduplication.
- **Capture UI** — New tab in the web UI (sidebar "Capture") supports
  drag-and-drop for audio/image/PDF files, XHR upload with progress bar,
  and a bank-statement checklist with "Create all accepted" flow.
- **Provenance tracking** — Every imported transaction records
  `media_path` (file reference) and `media_source_kind` (`'audio'`,
  `'image'`, or `'pdf'`) on the `transactions` table.
- **Configuration** — `PI_FINANCE_MEDIA_ENABLED`, `GROQ_API_KEY`,
  `PI_FINANCE_GROQ_MODEL_*`, `PI_FINANCE_MEDIA_*` env vars. All
  optional; media features are disabled by default without a key.

### Changed
- Tools grew from 17 to 21 (added 4 `media_*` tools).
- HTTP routes grew from 17 to 24 (added 7 media routes).
- Schema: `transactions` table now has two nullable columns
  (`media_path`, `media_source_kind`) with a CHECK trigger.
- Default image model changed from decommissioned
  `llama-3.2-90b-vision-preview` to `meta-llama/llama-4-scout-17b-16e-instruct`.

### Fixed
- Multipart file uploads now include a `filename` parameter in the
  `Content-Disposition` header (required by Groq API).
- `media_extract_pdf` / `media_import_bank_statement` return
  `ocr_unavailable_for_scanned_pdf` for empty/whitespace-only PDF text.
- `readRawBody` checks `Content-Length` before buffering (prevents
  oversized uploads from wasting memory).
- GroqClient error mapping split: 5xx → `groq_unavailable`,
  4xx → `groq_invalid_response`, 429 → `groq_rate_limited`.

### Media file layout

```
src/
├── config.ts         # media env var parsing
├── groq.ts           # GroqClient (thin fetch wrapper, no SDK)
├── media/
│   ├── mime.ts       # MIME type sniffer
│   └── ingest.ts     # temp file lifecycle + TTL sweeper
```

[0.2.0]: https://github.com/lutfi-zain/pi-finance-tracker/releases/tag/v0.2.0

## [0.1.0] — 2026-06-07

### Added
- Initial release.
- SQLite-backed store (sql.js, WASM) with schema migrations on open.
- Tables: `wallets`, `categories`, `tags`, `transactions`, `transaction_tags`
  (n:m join for the tag relation).
- Money stored as **integer minor units** to avoid float drift.
- 17 LLM-callable tools with TypeBox schemas:
  - Wallets: `list`, `create`, `update`, `delete`
  - Categories: `list`, `create`, `update`, `delete`
  - Tags: `list`, `create`, `update`, `delete`
  - Transactions: `list`, `get`, `create`, `update`, `delete`
  - Aggregate: `summary`
- Tiny HTTP server (Node `http`, no Express) serving:
  - REST JSON API at `/api/*`
  - Single-page CRUD UI at `/`
- Single-page CRUD UI: dashboard, wallets, categories, tags, transactions
  with search, filters, and inline modals.
- `/finance` slash command with argument completion
  (`open`, `url`, `stop`, `path`, `seed`).
- First-run seed: 1 wallet (Cash), 5 categories, 2 tags.
- Environment variable configuration
  (`PI_FINANCE_DB`, `PI_FINANCE_PORT`, `PI_FINANCE_HOST`,
  `PI_FINANCE_AUTOSTART`, `PI_FINANCE_BROWSER`).
- MIT licensed.

[0.1.0]: https://github.com/lutfi-zain/pi-finance-tracker/releases/tag/v0.1.0
