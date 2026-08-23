/** HTTP handlers for F7 journal views: browse/search organized notes, action items, export. */

import type { Turn } from "../conversation";
import type { ExportConversation, ExportData, ExportTurn } from "../export-markdown";
import { renderExportMarkdown } from "../export-markdown";
import {
	ACTION_ITEM_DUE_FILTERS,
	ACTION_ITEM_STATUS_FILTERS,
	ACTION_ITEM_STATUSES,
	type ActionItemDueFilter,
	type ActionItemStatus,
	type ActionItemStatusFilter,
	type ExportPayload,
	exportAll,
	listActionItems,
	listJournalEntries,
	parseJsonArray,
	searchJournalEntries,
	updateActionItemStatus,
} from "../journal";

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 100;

function parseLimit(request: Request, max: number, def: number): number | Response {
	const url = new URL(request.url);
	const raw = url.searchParams.get("limit");
	if (raw === null) {
		return def;
	}
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > max) {
		return Response.json(
			{ error: `limit must be an integer between 1 and ${max}` },
			{ status: 400 },
		);
	}
	return n;
}

function isStatusFilter(value: string): value is ActionItemStatusFilter {
	return (ACTION_ITEM_STATUS_FILTERS as readonly string[]).includes(value);
}

function isDueFilter(value: string): value is ActionItemDueFilter {
	return (ACTION_ITEM_DUE_FILTERS as readonly string[]).includes(value);
}

function isActionItemStatus(value: string): value is ActionItemStatus {
	return (ACTION_ITEM_STATUSES as readonly string[]).includes(value);
}

/** `GET /api/journal` — filters combine with AND; `day`/`from`/`to` filter on the raw note's date. */
export async function handleJournalList(request: Request, env: Env): Promise<Response> {
	const limit = parseLimit(request, LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT);
	if (limit instanceof Response) {
		return limit;
	}

	const url = new URL(request.url);
	const entries = await listJournalEntries(env.ORLA_DB, {
		day: url.searchParams.get("day") ?? undefined,
		from: url.searchParams.get("from") ?? undefined,
		to: url.searchParams.get("to") ?? undefined,
		type: url.searchParams.get("type") ?? undefined,
		tag: url.searchParams.get("tag") ?? undefined,
		before: url.searchParams.get("before") ?? undefined,
		limit,
	});

	return Response.json({ entries });
}

/** `GET /api/journal/search` — full-text search via `organized_notes_fts`, ranked by `bm25`. */
export async function handleJournalSearch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const q = url.searchParams.get("q");
	if (q === null || q.trim().length === 0) {
		return Response.json({ error: "q must be a non-empty string" }, { status: 400 });
	}

	const limit = parseLimit(request, SEARCH_MAX_LIMIT, SEARCH_DEFAULT_LIMIT);
	if (limit instanceof Response) {
		return limit;
	}

	const entries = await searchJournalEntries(env.ORLA_DB, q, { limit });
	return Response.json({ entries });
}

/** `GET /api/action-items` — `status` and `due` filters combine with AND. */
export async function handleActionItems(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const statusRaw = url.searchParams.get("status") ?? "open";
	const dueRaw = url.searchParams.get("due") ?? "all";

	if (!isStatusFilter(statusRaw)) {
		return Response.json(
			{ error: `status must be one of ${ACTION_ITEM_STATUS_FILTERS.join(", ")}` },
			{ status: 400 },
		);
	}
	if (!isDueFilter(dueRaw)) {
		return Response.json(
			{ error: `due must be one of ${ACTION_ITEM_DUE_FILTERS.join(", ")}` },
			{ status: 400 },
		);
	}

	const items = await listActionItems(env.ORLA_DB, { status: statusRaw, due: dueRaw });
	return Response.json({ items });
}

/** `PATCH /api/action-items/:id` body `{ status }` — 404 unknown id, 400 bad/missing status. */
export async function handleActionItemUpdate(
	request: Request,
	env: Env,
	id: string,
): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}

	const { status } = payload as Record<string, unknown>;
	if (typeof status !== "string" || !isActionItemStatus(status)) {
		return Response.json(
			{ error: `status must be one of ${ACTION_ITEM_STATUSES.join(", ")}` },
			{ status: 400 },
		);
	}

	const updated = await updateActionItemStatus(env.ORLA_DB, id, status);
	if (!updated) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	return Response.json(updated, { status: 200 });
}

type ExportRawNoteRow = {
	id: string;
	body: string;
	created_at: string;
	private: number;
	processed_at: string | null;
};

type ExportOrganizedNoteRow = {
	id: string;
	raw_note_id: string;
	run_id: string;
	type: string;
	cleaned_text: string;
	summary: string;
	tags: string;
	attendees: string;
	decisions: string;
	model: string;
	created_at: string;
};

type ExportActionItemRow = {
	id: string;
	organized_note_id: string;
	text: string;
	due_date: string | null;
	status: string;
	created_at: string;
};

type ExportConversationRow = {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
};

type ExportMemoryFactRow = {
	id: string;
	text: string;
	status: string;
	source: string;
	source_note_id: string | null;
	created_at: string;
	updated_at: string;
};

/**
 * Builds the Markdown-renderer's input from `exportAll`'s JSON payload: joins organized notes to
 * their raw note's `created_at` (for day-grouping — `exportAll`'s own JSON shape stays unjoined so
 * the default JSON export's fields don't change), and fetches each conversation's turns from its
 * Durable Object (the data layer in `../journal` deliberately doesn't know about DOs).
 */
async function buildExportMarkdownData(env: Env, payload: ExportPayload): Promise<ExportData> {
	const rawNotes = payload.raw_notes as ExportRawNoteRow[];
	const organizedNotes = payload.organized_notes as ExportOrganizedNoteRow[];
	const actionItemRows = payload.action_items as ExportActionItemRow[];
	const conversationRows = payload.conversations as ExportConversationRow[];
	const memoryFactRows = payload.memory_facts as ExportMemoryFactRow[];

	const rawNoteById = new Map(rawNotes.map((row) => [row.id, row]));
	const organizedNoteById = new Map(organizedNotes.map((row) => [row.id, row]));

	const journal = organizedNotes.map((row) => {
		const rawNote = rawNoteById.get(row.raw_note_id);
		return {
			type: row.type,
			summary: row.summary,
			cleaned_text: row.cleaned_text,
			tags: parseJsonArray(row.tags),
			attendees: parseJsonArray(row.attendees),
			decisions: parseJsonArray(row.decisions),
			captured_at: rawNote?.created_at ?? row.created_at,
		};
	});

	const actionItems = actionItemRows.map((row) => ({
		text: row.text,
		due_date: row.due_date,
		status: row.status,
		summary: organizedNoteById.get(row.organized_note_id)?.summary ?? "",
	}));

	const conversations: ExportConversation[] = await Promise.all(
		conversationRows.map(async (row): Promise<ExportConversation> => {
			const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(row.id));
			// A conversation's DO can be unreachable (e.g. invalidated by a concurrent deploy) even
			// though its D1 index row exists — one bad stub shouldn't fail the whole export, so it's
			// listed with `unavailable: true` instead of its turns.
			try {
				const turns: Turn[] = await stub.listTurns();
				return {
					id: row.id,
					title: row.title,
					turns: turns.map((turn): ExportTurn => ({ role: turn.role, content: turn.content })),
				};
			} catch {
				return { id: row.id, title: row.title, turns: [], unavailable: true };
			}
		}),
	);

	return {
		memory_facts: memoryFactRows.map((row) => ({
			text: row.text,
			status: row.status as "proposed" | "active" | "archived",
		})),
		action_items: actionItems,
		journal,
		raw_notes: rawNotes.map((row) => ({
			created_at: row.created_at,
			private: row.private === 1,
			body: row.body,
		})),
		conversations,
	};
}

/**
 * `GET /api/export?format=json|markdown` — full account export (PRD §7 Portability), including
 * private raw notes. `format` defaults to `json` (unchanged behaviour); `request` is optional so
 * existing callers that only pass `env` keep working. Once `src/index.ts` is wired to forward the
 * request, `?format=markdown` returns one Markdown document instead (see `renderExportMarkdown`).
 */
export async function handleExport(env: Env, request?: Request): Promise<Response> {
	const now = new Date();
	const payload = await exportAll(env.ORLA_DB, now);
	const dateStamp = now.toISOString().slice(0, 10);

	const format = request ? new URL(request.url).searchParams.get("format") : null;

	if (format === "markdown") {
		const data = await buildExportMarkdownData(env, payload);
		const body = renderExportMarkdown(data, now.toISOString());
		const filename = `orla-export-${dateStamp}.md`;

		return new Response(body, {
			status: 200,
			headers: {
				"content-type": "text/markdown; charset=utf-8",
				"content-disposition": `attachment; filename="${filename}"`,
			},
		});
	}

	const filename = `orla-export-${dateStamp}.json`;
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"content-disposition": `attachment; filename="${filename}"`,
		},
	});
}
