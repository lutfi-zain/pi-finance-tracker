# Changelog

All notable changes to **pi-finance-tracker** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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
