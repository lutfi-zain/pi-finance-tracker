/**
 * LLM-callable tools for the finance tracker.
 *
 * Each tool is a thin wrapper around FinanceDB methods with TypeBox schemas.
 * Money is always expressed as integer minor units (e.g. cents). The LLM
 * is responsible for the conversion; the schema docs spell it out.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { FinanceDB, TxType } from "./db.js";
import type { GroqClient } from "./groq.js";
import type { MediaResult } from "./types.js";

const TxTypeSchema = StringEnum(["income", "expense", "transfer"] as const);
const CatKindSchema = StringEnum(["income", "expense"] as const);

// ── wallets ──────────────────────────────────────────────────────────────

const WalletCreate = Type.Object({
	name: Type.String({ description: "Wallet display name (1-80 chars, unique)" }),
	currency: Type.String({ description: 'ISO 4217 currency code, e.g. "USD", "IDR", "EUR"' }),
	opening_minor: Type.Optional(
		Type.Integer({ minimum: 0, description: "Opening balance in MINOR UNITS (cents/rupiah). 0 if omitted." }),
	),
	color: Type.Optional(Type.String({ description: "Hex color, e.g. #6366f1" })),
});

const WalletUpdate = Type.Object({
	id: Type.Integer({ description: "Wallet id" }),
	name: Type.Optional(Type.String({ description: "New name" })),
	currency: Type.Optional(Type.String({ description: "New currency code" })),
	opening_minor: Type.Optional(Type.Integer({ minimum: 0 })),
	color: Type.Optional(Type.String()),
	archived: Type.Optional(Type.Boolean({ description: "true to archive, false to unarchive" })),
});

const WalletDelete = Type.Object({ id: Type.Integer() });

// ── categories ───────────────────────────────────────────────────────────

const CategoryCreate = Type.Object({
	name: Type.String({ description: "Category name" }),
	kind: CatKindSchema,
	icon: Type.Optional(Type.String({ description: "Emoji or short symbol, e.g. 🍔, 🚗" })),
	color: Type.Optional(Type.String()),
});

const CategoryUpdate = Type.Object({
	id: Type.Integer(),
	name: Type.Optional(Type.String()),
	kind: Type.Optional(CatKindSchema),
	icon: Type.Optional(Type.String()),
	color: Type.Optional(Type.String()),
});

const CategoryDelete = Type.Object({ id: Type.Integer() });

// ── tags ─────────────────────────────────────────────────────────────────

const TagCreate = Type.Object({
	name: Type.String({ description: "Tag name (unique)" }),
	color: Type.Optional(Type.String()),
});

const TagUpdate = Type.Object({
	id: Type.Integer(),
	name: Type.Optional(Type.String()),
	color: Type.Optional(Type.String()),
});

const TagDelete = Type.Object({ id: Type.Integer() });

// ── transactions ─────────────────────────────────────────────────────────

const TxCreate = Type.Object({
	wallet_id: Type.Integer({ description: "Wallet id" }),
	category_id: Type.Optional(
		Type.Integer({ description: "Category id. Null for transfers; required for income/expense." }),
	),
	type: TxTypeSchema,
	amount_minor: Type.Integer({
		minimum: 0,
		description: "Amount in MINOR UNITS (cents). Always positive; the type determines the sign.",
	}),
	currency: Type.String({ description: "ISO 4217 currency code" }),
	note: Type.Optional(Type.String({ description: "Free-form note, max 500 chars" })),
	occurred_at: Type.Optional(
		Type.String({ description: "ISO 8601 timestamp. Defaults to now if omitted." }),
	),
	tag_ids: Type.Optional(
		Type.Array(Type.Integer(), { description: "Tag ids to attach. Empty array to clear." }),
	),
});

const TxUpdate = Type.Object({
	id: Type.Integer(),
	wallet_id: Type.Optional(Type.Integer()),
	category_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
	type: Type.Optional(TxTypeSchema),
	amount_minor: Type.Optional(Type.Integer({ minimum: 0 })),
	currency: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	occurred_at: Type.Optional(Type.String()),
	tag_ids: Type.Optional(Type.Array(Type.Integer())),
});

const TxDelete = Type.Object({ id: Type.Integer() });

const TxList = Type.Object({
	wallet_id: Type.Optional(Type.Integer()),
	category_id: Type.Optional(Type.Integer()),
	tag_id: Type.Optional(Type.Integer()),
	type: Type.Optional(TxTypeSchema),
	from: Type.Optional(Type.String({ description: "ISO date or datetime, inclusive lower bound on occurred_at" })),
	to: Type.Optional(Type.String({ description: "ISO date or datetime, inclusive upper bound" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 50 })),
});

const TxGet = Type.Object({ id: Type.Integer() });

// ── summary ──────────────────────────────────────────────────────────────

const Summary = Type.Object({});

export type WalletCreateT = Static<typeof WalletCreate>;
export type WalletUpdateT = Static<typeof WalletUpdate>;
export type CategoryCreateT = Static<typeof CategoryCreate>;
export type CategoryUpdateT = Static<typeof CategoryUpdate>;
export type TagCreateT = Static<typeof TagCreate>;
export type TagUpdateT = Static<typeof TagUpdate>;
export type TxCreateT = Static<typeof TxCreate>;
export type TxUpdateT = Static<typeof TxUpdate>;
export type TxListT = Static<typeof TxList>;

// ── Media tools (PR 2) ─────────────────────────────────────────────────

const MediaTranscribeAudio = Type.Object({
	file_path: Type.Optional(Type.String({ description: "Local path to the audio file." })),
	file_buffer_b64: Type.Optional(Type.String({ description: "Base64-encoded audio file content." })),
	language: Type.Optional(Type.String({ description: "BCP-47 language code (e.g. 'id', 'en'). Omit for auto-detect." })),
});

const MediaExtractImage = Type.Object({
	file_path: Type.Optional(Type.String({ description: "Local path to the image file." })),
	file_buffer_b64: Type.Optional(Type.String({ description: "Base64-encoded image file content." })),
	prompt: Type.Optional(Type.String({ description: "Prompt asking for a specific JSON shape (e.g. {merchant, amount, date}). Omit for freeform extraction." })),
});

const MediaExtractPdf = Type.Object({
	file_path: Type.Optional(Type.String({ description: "Local path to the PDF file." })),
	file_buffer_b64: Type.Optional(Type.String({ description: "Base64-encoded PDF file content." })),
	parse_as: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("transactions")], { description: "'text' returns raw text; 'transactions' returns a list of candidate Transaction objects (requires GROQ_API_KEY)." })),
});

const MediaImportBankStatement = Type.Object({
	file_path: Type.String({ description: "Local path to the bank-statement PDF file." }),
	wallet_id: Type.Integer({ description: "Wallet id to associate the imported transactions with." }),
	default_currency: Type.String({ description: "ISO 4217 currency code (e.g. 'IDR', 'USD') for transactions that don't specify one." }),
});

export type MediaTranscribeAudioT = Static<typeof MediaTranscribeAudio>;
export type MediaExtractImageT = Static<typeof MediaExtractImage>;
export type MediaExtractPdfT = Static<typeof MediaExtractPdf>;
export type MediaImportBankStatementT = Static<typeof MediaImportBankStatement>;

/** Pretty-print minor units as a major-unit string for LLM-friendly output. */
function fmt(amount_minor: number, currency: string): string {
	const noDecimal = ["JPY", "KRW", "IDR", "VND", "CLP", "PYG", "UGX", "XAF", "XOF"].includes(currency.toUpperCase());
	const divisor = noDecimal ? 1 : 100;
	const major = amount_minor / divisor;
	return `${major.toFixed(noDecimal ? 0 : 2)} ${currency}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(
	pi: { registerTool: (def: unknown) => void },
	db: FinanceDB,
	groqClient?: GroqClient | null,
): void {
	const mediaOk = !!(groqClient?.getConfig()?.apiKey);
	pi.registerTool({
		name: "finance_list_wallets",
		label: "List Wallets",
		description:
			"List all wallets (cash, bank accounts, e-wallets, etc.) with id, name, currency, opening balance, and current balance.",
		promptSnippet: "List all wallets in the finance tracker.",
		parameters: Type.Object({ include_archived: Type.Optional(Type.Boolean()) }),
		execute: async (_id, params: { include_archived?: boolean }) => {
			const wallets = db.listWallets(params.include_archived ?? true);
			return {
				content: [
					{
						type: "text",
						text:
							wallets.length === 0
								? "No wallets yet. Use finance_create_wallet to add one."
								: wallets
									.map(
										(w) =>
											`#${w.id} ${w.name} (${w.currency}) — opening ${fmt(w.opening_minor, w.currency)}${w.archived ? " [archived]" : ""}`,
									)
									.join("\n"),
					},
				],
				details: { wallets },
			};
		},
	});

	pi.registerTool({
		name: "finance_create_wallet",
		label: "Create Wallet",
		description:
			"Create a new wallet. Money is tracked in minor units (cents/rupiah). The opening balance is the starting amount before any transactions.",
		parameters: WalletCreate,
		execute: async (_id, p: WalletCreateT) => {
			const w = db.createWallet(p);
			return {
				content: [{ type: "text", text: `Created wallet #${w.id} "${w.name}" (${w.currency})` }],
				details: { wallet: w },
			};
		},
	});

	pi.registerTool({
		name: "finance_update_wallet",
		label: "Update Wallet",
		description: "Update fields on an existing wallet. Only the provided fields are changed.",
		parameters: WalletUpdate,
		execute: async (_id, p) => {
			const { id, archived, ...rest } = p as Static<typeof WalletUpdate>;
			const w = db.updateWallet(id, {
				...rest,
				archived: archived === undefined ? undefined : archived ? 1 : 0,
			});
			if (!w) throw new Error(`wallet ${id} not found`);
			return {
				content: [{ type: "text", text: `Updated wallet #${w.id} "${w.name}"` }],
				details: { wallet: w },
			};
		},
	});

	pi.registerTool({
		name: "finance_delete_wallet",
		label: "Delete Wallet",
		description: "Delete a wallet. Fails if the wallet still has transactions.",
		parameters: WalletDelete,
		execute: async (_id, p) => {
			const ok = db.deleteWallet(p.id);
			if (!ok) throw new Error(`wallet ${p.id} not found`);
			return { content: [{ type: "text", text: `Deleted wallet #${p.id}` }], details: { id: p.id } };
		},
	});

	// ── categories ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "finance_list_categories",
		label: "List Categories",
		description: "List all categories. Optionally filter by kind ('income' or 'expense').",
		parameters: Type.Object({ kind: Type.Optional(CatKindSchema) }),
		execute: async (_id, p: { kind?: "income" | "expense" }) => {
			const cats = db.listCategories(p.kind);
			return {
				content: [
					{
						type: "text",
						text:
							cats.length === 0
								? "No categories yet."
								: cats.map((c) => `#${c.id} ${c.icon} ${c.name} [${c.kind}]`).join("\n"),
					},
				],
				details: { categories: cats },
			};
		},
	});

	pi.registerTool({
		name: "finance_create_category",
		label: "Create Category",
		description: "Create a new income or expense category.",
		parameters: CategoryCreate,
		execute: async (_id, p: CategoryCreateT) => {
			const c = db.createCategory(p);
			return {
				content: [{ type: "text", text: `Created category #${c.id} ${c.icon} ${c.name} (${c.kind})` }],
				details: { category: c },
			};
		},
	});

	pi.registerTool({
		name: "finance_update_category",
		label: "Update Category",
		description: "Update fields on an existing category.",
		parameters: CategoryUpdate,
		execute: async (_id, p: Static<typeof CategoryUpdate>) => {
			const c = db.updateCategory(p.id, p);
			if (!c) throw new Error(`category ${p.id} not found`);
			return {
				content: [{ type: "text", text: `Updated category #${c.id} ${c.name}` }],
				details: { category: c },
			};
		},
	});

	pi.registerTool({
		name: "finance_delete_category",
		label: "Delete Category",
		description: "Delete a category. Existing transactions keep their amount but lose this category.",
		parameters: CategoryDelete,
		execute: async (_id, p) => {
			const ok = db.deleteCategory(p.id);
			if (!ok) throw new Error(`category ${p.id} not found`);
			return { content: [{ type: "text", text: `Deleted category #${p.id}` }], details: { id: p.id } };
		},
	});

	// ── tags ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "finance_list_tags",
		label: "List Tags",
		description: "List all tags. Tags can be attached to many transactions (n:m).",
		parameters: Type.Object({}),
		execute: async () => {
			const tags = db.listTags();
			return {
				content: [
					{
						type: "text",
						text:
							tags.length === 0
								? "No tags yet."
								: tags.map((t) => `#${t.id} ${t.name}`).join("\n"),
					},
				],
				details: { tags },
			};
		},
	});

	pi.registerTool({
		name: "finance_create_tag",
		label: "Create Tag",
		description: "Create a new tag.",
		parameters: TagCreate,
		execute: async (_id, p: TagCreateT) => {
			const t = db.createTag(p);
			return {
				content: [{ type: "text", text: `Created tag #${t.id} "${t.name}"` }],
				details: { tag: t },
			};
		},
	});

	pi.registerTool({
		name: "finance_update_tag",
		label: "Update Tag",
		description: "Update a tag's name or color.",
		parameters: TagUpdate,
		execute: async (_id, p: Static<typeof TagUpdate>) => {
			const t = db.updateTag(p.id, p);
			if (!t) throw new Error(`tag ${p.id} not found`);
			return {
				content: [{ type: "text", text: `Updated tag #${t.id} ${t.name}` }],
				details: { tag: t },
			};
		},
	});

	pi.registerTool({
		name: "finance_delete_tag",
		label: "Delete Tag",
		description: "Delete a tag. Detaches it from all transactions.",
		parameters: TagDelete,
		execute: async (_id, p) => {
			const ok = db.deleteTag(p.id);
			if (!ok) throw new Error(`tag ${p.id} not found`);
			return { content: [{ type: "text", text: `Deleted tag #${p.id}` }], details: { id: p.id } };
		},
	});

	// ── transactions ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "finance_list_transactions",
		label: "List Transactions",
		description:
			"List transactions with optional filters: wallet_id, category_id, tag_id, type (income/expense/transfer), from/to (ISO datetime), limit (default 50, max 1000).",
		promptSnippet: "List transactions with filters.",
		parameters: TxList,
		execute: async (_id, p: TxListT) => {
			const txs = db.listTransactions(p);
			return {
				content: [
					{
						type: "text",
						text:
							txs.length === 0
								? "No transactions matched."
								: txs
									.map(
										(t) =>
											`#${t.id} [${t.type}] ${fmt(t.amount_minor, t.currency)} wallet=${t.wallet_id}` +
											`${t.category_id ? ` cat=${t.category_id}` : ""}` +
											`${t.tag_names?.length ? ` tags=${t.tag_names.join(",")}` : ""}` +
											` @${t.occurred_at}${t.note ? ` — ${t.note}` : ""}`,
									)
									.join("\n"),
					},
				],
				details: { transactions: txs },
			};
		},
	});

	pi.registerTool({
		name: "finance_get_transaction",
		label: "Get Transaction",
		description: "Fetch a single transaction with its attached tag ids and names.",
		parameters: TxGet,
		execute: async (_id, p) => {
			const tx = db.getTransaction(p.id);
			if (!tx) throw new Error(`transaction ${p.id} not found`);
			return {
				content: [
					{
						type: "text",
						text:
							`#${tx.id} [${tx.type}] ${fmt(tx.amount_minor, tx.currency)} on wallet=${tx.wallet_id}` +
							`${tx.category_id ? ` category=${tx.category_id}` : ""}` +
							`${tx.tag_names?.length ? ` tags=${tx.tag_names.join(",")}` : ""}` +
							` @${tx.occurred_at}${tx.note ? ` — ${tx.note}` : ""}`,
					},
				],
				details: { transaction: tx },
			};
		},
	});

	pi.registerTool({
		name: "finance_create_transaction",
		label: "Create Transaction",
		description:
			"Record a new transaction. amount_minor is in MINOR UNITS (cents/rupiah), always positive. type determines the sign ('income' credits, 'expense' debits, 'transfer' moves between wallets but uses wallet_id only — use this tool twice for a real transfer). category_id must be omitted or null for transfers.",
		promptSnippet: "Record a new transaction.",
		parameters: TxCreate,
		execute: async (_id, p: TxCreateT) => {
			const tx = db.createTransaction({
				...p,
				category_id: p.category_id ?? null,
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Created transaction #${tx.id} [${tx.type}] ${fmt(tx.amount_minor, tx.currency)}` +
							(tx.tag_names?.length ? ` tags=${tx.tag_names.join(",")}` : ""),
					},
				],
				details: { transaction: tx },
			};
		},
	});

	pi.registerTool({
		name: "finance_update_transaction",
		label: "Update Transaction",
		description: "Update fields on an existing transaction. Only the provided fields are changed.",
		parameters: TxUpdate,
		execute: async (_id, p: TxUpdateT) => {
			const tx = db.updateTransaction(p.id, p);
			if (!tx) throw new Error(`transaction ${p.id} not found`);
			return {
				content: [{ type: "text", text: `Updated transaction #${tx.id}` }],
				details: { transaction: tx },
			};
		},
	});

	pi.registerTool({
		name: "finance_delete_transaction",
		label: "Delete Transaction",
		description: "Delete a transaction.",
		parameters: TxDelete,
		execute: async (_id, p) => {
			const ok = db.deleteTransaction(p.id);
			if (!ok) throw new Error(`transaction ${p.id} not found`);
			return { content: [{ type: "text", text: `Deleted transaction #${p.id}` }], details: { id: p.id } };
		},
	});

	// ── summary ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "finance_summary",
		label: "Finance Summary",
		description:
			"Get a snapshot of totals: total income/expense/net, counts of wallets/categories/tags/transactions, balance per wallet, and total per category.",
		promptSnippet: "Get a finance summary snapshot.",
		parameters: Summary,
		execute: async () => {
			const s = db.summary();
			const text =
				`Income:   ${s.total_income_minor} (minor units)\n` +
				`Expense:  ${s.total_expense_minor} (minor units)\n` +
				`Net:      ${s.net_minor} (minor units)\n` +
				`Tx: ${s.tx_count} | Wallets: ${s.wallet_count} | Categories: ${s.category_count} | Tags: ${s.tag_count}\n` +
				`\nBy wallet:\n` +
				s.by_wallet.map((w) => `  #${w.wallet_id} ${w.wallet_name} (${w.currency}) = ${w.balance_minor}`).join("\n") +
				`\nBy category:\n` +
				s.by_category
					.map((c) => `  #${c.category_id} ${c.category_name} [${c.kind}] = ${c.total_minor}`)
					.join("\n");
			return { content: [{ type: "text", text }], details: { summary: s } };
		},
	});

	// ── Media tools (registered only if GroqClient is configured) ──────
	if (!mediaOk) return;

	pi.registerTool({
		name: "media_transcribe_audio",
		label: "Transcribe Audio",
		description:
			"Convert an audio file to text using Groq's Whisper model. Accepts a local file path or a base64-encoded buffer. Returns the transcribed text, detected language, and duration.",
		promptSnippet: "Convert audio files to text.",
		promptGuidelines:
			"Use `media_transcribe_audio` when the user provides an audio file (voice memo, meeting recording) and wants the spoken content as text. Pass either a `file_path` or a base64-encoded `file_buffer_b64`. Optional `language` (BCP-47 code) to force a specific language instead of auto-detect.",
		parameters: MediaTranscribeAudio,
		execute: async (_id: string, p: MediaTranscribeAudioT) => {
			const buf = p.file_buffer_b64
				? Buffer.from(p.file_buffer_b64, "base64")
				: p.file_path
					? (await import("node:fs")).readFileSync(p.file_path)
					: null;
			if (!buf) {
				return {
					content: [{ type: "text", text: "No file provided. Pass file_path or file_buffer_b64." }],
					details: { ok: false, error: { code: "upload_failed", message: "No file provided" } },
				};
			}
			// Sniff MIME from magic bytes
			const { sniffMime } = await import("./media/mime.js");
			let mime = "audio/mpeg";
			try {
				const sniffed = sniffMime(buf.subarray(0, 4096));
				mime = sniffed.mime;
			} catch { /* use default */ }

			const result = await groqClient!.transcribe({ file: buf, mime, language: p.language });
			if (!result.ok) {
				return { content: [{ type: "text", text: `Transcription failed: ${result.error.code} — ${result.error.message}` }], details: result };
			}
			return {
				content: [{ type: "text", text: `Transcribed: ${result.data.text}` }],
				details: { ok: true, data: result.data },
			};
		},
	});

	pi.registerTool({
		name: "media_extract_image",
		label: "Extract Image",
		description:
			"Extract text and structured data from an image using Groq's vision model. Accepts a local file path or a base64-encoded buffer. Optional `prompt` to request a specific JSON shape.",
		promptSnippet: "Extract text and structure from images.",
		promptGuidelines:
			"Use `media_extract_image` when the user provides an image (photo of a receipt, transfer confirmation screenshot, handwritten note) and wants the text and structured fields. Pass `prompt` to ask for a specific JSON shape (e.g. {merchant, amount, date}); omit for freeform text extraction.",
		parameters: MediaExtractImage,
		execute: async (_id: string, p: MediaExtractImageT) => {
			const buf = p.file_buffer_b64
				? Buffer.from(p.file_buffer_b64, "base64")
				: p.file_path
					? (await import("node:fs")).readFileSync(p.file_path)
					: null;
			if (!buf) {
				return {
					content: [{ type: "text", text: "No file provided. Pass file_path or file_buffer_b64." }],
					details: { ok: false, error: { code: "upload_failed", message: "No file provided" } },
				};
			}
			const { sniffMime } = await import("./media/mime.js");
			let mime = "image/jpeg";
			try {
				const sniffed = sniffMime(buf.subarray(0, 4096));
				mime = sniffed.mime;
			} catch { /* use default */ }

			const result = await groqClient!.extractImage({ file: buf, mime, prompt: p.prompt });
			if (!result.ok) {
				return { content: [{ type: "text", text: `Image extraction failed: ${result.error.code} — ${result.error.message}` }], details: result };
			}
			return {
				content: [{ type: "text", text: result.data.text }],
				details: { ok: true, data: result.data },
			};
		},
	});

	pi.registerTool({
		name: "media_extract_pdf",
		label: "Extract PDF",
		description:
			"Extract text or structured transactions from a PDF file. For `parse_as: \"text\"`, returns the raw text. For `parse_as: \"transactions\"`, returns a list of candidate Transaction objects (requires GROQ_API_KEY).",
		promptSnippet: "Extract text or transactions from PDFs.",
		promptGuidelines:
			"Use `media_extract_pdf` when the user provides a PDF (bank statement / rekening koran, invoice, e-statement). `parse_as: \"text\"` returns the raw text. `parse_as: \"transactions\"` returns a list of candidate `Transaction` objects ready for the bank-statement import flow.",
		parameters: MediaExtractPdf,
		execute: async (_id: string, p: MediaExtractPdfT) => {
			const buf = p.file_buffer_b64
				? Buffer.from(p.file_buffer_b64, "base64")
				: p.file_path
					? (await import("node:fs")).readFileSync(p.file_path)
					: null;
			if (!buf) {
				return {
					content: [{ type: "text", text: "No file provided. Pass file_path or file_buffer_b64." }],
					details: { ok: false, error: { code: "upload_failed", message: "No file provided" } },
				};
			}

			const pdfParse = (await import("pdf-parse")).default;
			const pdfData = await pdfParse(buf);
			const text = pdfData.text || "";
			const pageCount = pdfData.numpages ?? 0;

			if (!p.parse_as || p.parse_as === "text") {
				return {
					content: [{ type: "text", text: text || "(empty PDF)" }],
					details: { ok: true, data: { text, page_count: pageCount, transactions: undefined } },
				};
			}

			// parse_as === "transactions" — use Groq for structure
			const result = await groqClient!.extractPdfStructure({ text, schema: {} });
			if (!result.ok) {
				return { content: [{ type: "text", text: `PDF extraction failed: ${result.error.code} — ${result.error.message}` }], details: result };
			}
			const structured = result.data.structured as any;
			const transactions = Array.isArray(structured?.transactions) ? structured.transactions : [];
			return {
				content: [{ type: "text", text: `Extracted ${transactions.length} candidate transaction(s) from the PDF.` }],
				details: { ok: true, data: { text, page_count: pageCount, transactions } },
			};
		},
	});

	pi.registerTool({
		name: "media_import_bank_statement",
		label: "Import Bank Statement",
		description:
			"Take a bank-statement PDF and return a list of draft transaction candidates. Uses Groq to extract structured transactions from the PDF text. Requires GROQ_API_KEY.",
		promptSnippet: "Turn a bank-statement PDF into a list of draft transactions.",
		promptGuidelines:
			"Use `media_import_bank_statement` when the user uploads a bank-statement PDF and wants a list of draft transactions to confirm before creating. After getting the candidates, present them to the user; on confirmation, call `finance_create_transaction` for each (or POST `/api/transactions/bulk` for one-shot).",
		parameters: MediaImportBankStatement,
		execute: async (_id: string, p: MediaImportBankStatementT) => {
			const buf = (await import("node:fs")).readFileSync(p.file_path);
			if (!buf || buf.length === 0) {
				return {
					content: [{ type: "text", text: "File is empty or not found." }],
					details: { ok: false, error: { code: "upload_failed", message: "Empty file" } },
				};
			}

			const pdfParse = (await import("pdf-parse")).default;
			const pdfData = await pdfParse(buf);
			const text = pdfData.text || "";

			const result = await groqClient!.extractPdfStructure({ text, schema: {} });
			if (!result.ok) {
				return { content: [{ type: "text", text: `Bank statement import failed: ${result.error.code} — ${result.error.message}` }], details: result };
			}
			const structured = result.data.structured as any;
			const candidates = Array.isArray(structured?.transactions) ? structured.transactions : [];
			return {
				content: [{ type: "text", text: `Found ${candidates.length} candidate transaction(s) from the bank statement.` }],
				details: { ok: true, data: { candidates } },
			};
		},
	});
}
