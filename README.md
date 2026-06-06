<div align="center">

# 💰 Pi Finance Tracker

**SQLite-backed personal finance tracker, right inside your AI agent.**

A [Pi](https://pi.dev) extension that gives the agent — and you, through a
slick web UI — a complete personal finance tracker. Wallets, categories, tags,
transactions, and a live dashboard. No servers to manage, no SaaS to sign up
for; just a local SQLite file and a few lines of config.

---

[Features](#-features) •
[Quick start](#-quick-start) •
[Commands](#-slash-commands) •
[Tools](#-llm-tools) •
[Architecture](#-architecture) •
[Configuration](#-configuration)

</div>

---

## ✨ Features

| | |
|---|---|
| 🗄️  **Local SQLite** | Your data lives in `~/.pi/agent/finance-tracker/finance.db`. No cloud, no telemetry. |
| 🔌 **17 LLM tools** | `finance_*` tools with TypeBox schemas, ready for the agent to call. |
| 🌐 **Web CRUD UI** | A clean dark-themed single-page app for humans. Full create / read / update / delete. |
| 📊 **Live dashboard** | Income, expense, net, per-wallet balances, per-category totals, recent activity. |
| 🏷️  **Tags (n:m)** | Apply any number of tags to a transaction. Search, filter, group. |
| 💱 **Multi-currency** | Every transaction carries its own currency; minor units everywhere — no float drift. |
| 🧠 **First-run seed** | 5 categories, 2 tags, a Cash wallet so the UI is never empty. |
| 🛡️  **Referential integrity** | Foreign keys + `ON DELETE` rules; can't accidentally orphan transactions. |
| ⚡ **Zero build** | Pi's jiti loads TypeScript directly. No transpiler, no bundler, no step between you and shipping. |
| 🪶 **Tiny footprint** | 20 MB of `node_modules` (mostly the sql.js WASM blob), ~150 KB of source. |

## 📸 What it looks like

```
┌────────────────────────────────────────────────────────────────────┐
│  ◐ Dashboard    ▣ Wallets    ⌘ Categories    # Tags    ⇄ Transactions│
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Income              Expense              Net              Wallets │
│   +3,500.00 USD       −104.99 USD      +3,395.01 USD          1   │
│   3 transactions      2 wallet(s)      Income − expense            │
│                                                                     │
│   Wallets                          Top categories                   │
│   ┌──────────────────┐             ┌────────────────────────────┐  │
│   │ Cash        USD  │             │ Bills      [expense]  79.00│  │
│   │ current:  3,395  │             │ Food       [expense]  25.99│  │
│   └──────────────────┘             └────────────────────────────┘  │
│                                                                     │
│   Recent transactions                                               │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ 2026-06-05  [expense]   Cash   Bills    #recurring  −79.00 │ │
│   │ 2026-06-03  [expense]   Cash   Food                −25.99 │ │
│   │ 2026-06-01  [income]    Cash   Salary  #recurring +3500.00 │ │
│   └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

The UI is a single HTML file with vanilla JS and custom CSS — no framework,
no build step, no runtime to download. It talks to a tiny HTTP server
running in the same Node process as Pi.

## 🚀 Quick start

### 1. Install

Pick one:

```bash
# From npm (once published)
pi install npm:pi-finance-tracker

# From this repo
pi install git:github.com/<you>/pi-finance-tracker

# Local checkout (for development)
pi install -l /path/to/pi-finance-tracker
```

### 2. Restart Pi

The extension is auto-discovered. On the first `session_start` it will:

- Open (or create) `~/.pi/agent/finance-tracker/finance.db`
- Run the schema migrations
- Seed a Cash wallet, 5 categories, 2 tags
- Start a small web server on `http://127.0.0.1:3847`
- Notify you that it's ready

### 3. Open the UI

```bash
# From inside Pi
/finance open
```

Your default browser opens the UI. If the auto-open fails (e.g. headless
server), just paste the URL — Pi prints it on the same line.

### 4. Or just ask

```text
> buatkan wallet "BCA" dalam IDR dengan opening 5 juta
> tambah expense 75rb untuk transport kemarin
> ringkasan bulan ini
> hapus tag "one-off"
```

The agent uses the `finance_*` tools under the hood.

## 📖 Slash commands

| Command         | What it does                                                       |
| --------------- | ------------------------------------------------------------------ |
| `/finance`      | Start the web server (if needed) and print the URL                 |
| `/finance open` | Same as above, plus try to open the URL in your default browser    |
| `/finance url`  | Print the URL only — don't try to open                             |
| `/finance stop` | Stop the web server                                                |
| `/finance path` | Print the database file path                                       |
| `/finance seed` | Seed the DB with sample data (only if it's empty)                 |

`/finance` accepts argument completion — type `/finance ` and hit <kbd>Tab</kbd>.

## 🛠️ LLM tools

Every tool is registered with a TypeBox schema and shows up in the agent's
system prompt. The agent picks the right one based on what you ask.

| Domain       | Tools                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Wallets      | `finance_list_wallets` · `finance_create_wallet` · `finance_update_wallet` · `finance_delete_wallet` |
| Categories   | `finance_list_categories` · `finance_create_category` · `finance_update_category` · `finance_delete_category` |
| Tags         | `finance_list_tags` · `finance_create_tag` · `finance_update_tag` · `finance_delete_tag` |
| Transactions | `finance_list_transactions` · `finance_get_transaction` · `finance_create_transaction` · `finance_update_transaction` · `finance_delete_transaction` |
| Aggregate    | `finance_summary` — totals + per-wallet balances + per-category totals          |

> 💡 All amounts are **integer minor units** (cents for USD, raw rupiah for
> IDR, etc.). The transaction form and tool descriptions document the
> conversion in plain English so neither the agent nor the user has to guess.

## 🏗️ Architecture

```
                     ┌─────────────────────────────────────────┐
                     │              Pi runtime                  │
                     │                                          │
   user input  ───►  │  ┌─────────────────────────────────┐    │
                     │  │  pi-finance-tracker extension   │    │
                     │  │                                  │    │
                     │  │   ┌───────────┐  ┌────────────┐  │    │
                     │  │   │  tools.ts │  │  server.ts │  │    │
   LLM  ──tool──►    │  │   │ (TypeBox  │  │  (http +   │  │    │
                     │  │   │  schemas) │  │   static)  │  │    │
                     │  │   └─────┬─────┘  └─────┬──────┘  │    │
                     │  │         │              │          │    │
                     │  │         ▼              ▼          │    │
                     │  │       ┌──────────────────┐        │    │
                     │  │       │     db.ts        │        │    │
                     │  │       │  FinanceDB class │        │    │
                     │  │       │  (sql.js WASM)   │        │    │
                     │  │       └────────┬─────────┘        │    │
                     │  └────────────────┼──────────────────┘    │
                     └───────────────────┼───────────────────────┘
                                         │  read / write
                                         ▼
                          ~/.pi/agent/finance-tracker/finance.db
                          ┌──────────────────────────────┐
                          │  wallets      (1 ─ n)        │
                          │  categories   (1 ─ n)        │
                          │  tags         (n ─ n)        │
                          │  transactions                │
                          │  transaction_tags (join)     │
                          └──────────────────────────────┘
```

**Stack:**

- **`sql.js`** — pure-WASM SQLite. The reason this works on Termux and other
  restricted environments is that there's no native build step.
- **Node `http`** — no Express, no Koa. The server is ~460 lines and runs in
  the same process as Pi, with `unref()` so it never blocks shutdown.
- **Vanilla JS / CSS** for the UI. No bundler, no framework, no runtime. The
  whole single-page app is a single HTML file.

## ⚙️ Configuration

All configuration is via environment variables. None are required.

| Variable                | Default                                            | Purpose                                          |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `PI_FINANCE_DB`         | `~/.pi/agent/finance-tracker/finance.db`           | Path to the SQLite file                          |
| `PI_FINANCE_PORT`       | `3847`                                             | Preferred HTTP port; auto-bumps if busy          |
| `PI_FINANCE_HOST`       | `127.0.0.1`                                        | Bind address                                     |
| `PI_FINANCE_AUTOSTART`  | `1` (set to `0` to skip)                           | Auto-start the web server on first `session_start` |
| `PI_FINANCE_BROWSER`    | `xdg-open` / `open` / `start` (per platform)       | Override the browser opener used by `/finance open` |

### Security

The web UI binds to `127.0.0.1` by default — only your machine can reach it.
There is no authentication.

> ⚠️ **Don't expose this to the internet.** If you set
> `PI_FINANCE_HOST=0.0.0.0`, anyone on the network can read and edit your
> books.

## 🗃️ Schema

```sql
wallets          (id, name, currency, opening_minor, color, archived, created_at)
categories       (id, name, kind IN ('income','expense'), icon, color, created_at)
tags             (id, name, color, created_at)
transactions     (id, wallet_id → wallets, category_id → categories NULL,
                  type IN ('income','expense','transfer'),
                  amount_minor ≥ 0, currency, note, occurred_at, created_at)
transaction_tags (transaction_id → transactions, tag_id → tags,
                  PRIMARY KEY (transaction_id, tag_id))
```

- `wallets 1 ─ n transactions` (FK with `ON DELETE CASCADE`)
- `categories 1 ─ n transactions` (FK with `ON DELETE SET NULL`)
- `transactions n ─ n tags` through the `transaction_tags` join table
- **Money is stored as integer minor units** to avoid float drift. The UI and
  the tool descriptions show the major-unit equivalent.
- **Transfers** have `category_id = NULL`. The UI hides the category picker
  when you pick "Transfer".

## 🧑‍💻 Development

```bash
# Clone the repo
git clone https://github.com/<you>/pi-finance-tracker
cd pi-finance-tracker

# Install the single runtime dep (sql.js)
npm install

# Symlink it into Pi's auto-discovered extensions dir
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-finance-tracker

# Reload Pi
/finance path    # verify the extension loaded
/finance open    # see it in your browser
```

The extension is loaded by jiti directly from TypeScript — no `tsc`, no
`tsx`, no watcher. Just edit, save, `/reload`, and refresh.

### File layout

```
pi-finance-tracker/
├── package.json          # deps + pi.extensions manifest
├── README.md             # you are here
├── node_modules/         # sql.js (WASM SQLite)
└── src/
    ├── index.ts          # main extension entry, hooks, /finance command
    ├── db.ts             # SQLite schema, migrations, typed CRUD helpers
    ├── server.ts         # tiny http server (REST + static UI)
    ├── tools.ts          # TypeBox-typed LLM-callable tools
    └── ui/
        └── index.html    # single-page CRUD app
```

## 🤝 Contributing

PRs welcome. Keep it dependency-light — sql.js is the only runtime dep, and
there's a good reason for that. New features should:

1. Match the existing style (typed schemas, minor units, referential integrity).
2. Add a tool to `tools.ts` if the agent should be able to do it.
3. Update the API in `server.ts` and the UI in `src/ui/index.html` so humans
   can do the same thing.
4. Not break the `pi -e ./src/index.ts` smoke test:
   `node -e "import('./src/db.ts').then(({FinanceDB})=>FinanceDB.open('/tmp/x.db').then(d=>d.close()))"`.

## 📄 License

MIT
