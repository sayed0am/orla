/**
 * Data layer for F7 journal views: browsing/searching organized notes and their action items
 * (PRD F7 — "Browse/search organized notes and journal by day, tag, and type. Full-text search
 * via SQLite FTS5.").
 *
 * Private-flagged raw notes never produce an `organized_notes` row (F3 skips them before ever
 * calling the LLM — see `runReorganization`), so no extra filter is needed here to keep them out
 * of journal views; they only ever surface via `GET /api/export` (PRD §7 Portability).
 */

import type { NoteType } from "./reorganize";

export type ActionItemStatus = "open" | "done" | "dismissed";

export type JournalActionItem = {
	id: string;
	text: string;
	due_date: string | null;
	status: ActionItemStatus;
};

export type JournalEntry = {
	id: string;
	raw_note_id: string;
	type: NoteType;
	cleaned_text: string;
	summary: string;
	tags: string[];
	attendees: string[];
	decisions: string[];
	created_at: string;
	captured_at: string;
	action_items: JournalActionItem[];
};

export type ActionItem = {
	id: string;
	organized_note_id: string;
	text: string;
	due_date: string | null;
	status: ActionItemStatus;
	created_at: string;
};

export type ActionItemWithContext = ActionItem & {
	summary: string;
	captured_at: string;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const WEEK_WINDOW_DAYS = 6; // "week" = today .. today + 6 (a 7-day inclusive window)

type OrganizedEntryRow = {
	id: string;
	raw_note_id: string;
	type: string;
	cleaned_text: string;
	summary: string;
	tags: string;
	attendees: string;
	decisions: string;
	created_at: string;
	captured_at: string;
};

type ActionItemRow = {
	id: string;
	organized_note_id: string;
	text: string;
	due_date: string | null;
	status: string;
	created_at: string;
};

export function parseJsonArray(raw: string): string[] {
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function toActionItem(row: ActionItemRow): ActionItem {
	return {
		id: row.id,
		organized_note_id: row.organized_note_id,
		text: row.text,
		due_date: row.due_date,
		status: row.status as ActionItemStatus,
		created_at: row.created_at,
	};
}

/** Fetches all action items for a set of organized-note ids, grouped by that id. */
async function actionItemsByOrganizedNoteId(
	db: D1Database,
	organizedNoteIds: string[],
): Promise<Map<string, JournalActionItem[]>> {
	const grouped = new Map<string, JournalActionItem[]>();
	if (organizedNoteIds.length === 0) {
		return grouped;
	}

	const placeholders = organizedNoteIds.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT id, organized_note_id, text, due_date, status, created_at FROM action_items WHERE organized_note_id IN (${placeholders}) ORDER BY created_at ASC`,
		)
		.bind(...organizedNoteIds)
		.all<ActionItemRow>();

	for (const row of result.results) {
		const list = grouped.get(row.organized_note_id) ?? [];
		list.push({
			id: row.id,
			text: row.text,
			due_date: row.due_date,
			status: row.status as ActionItemStatus,
		});
		grouped.set(row.organized_note_id, list);
	}
	return grouped;
}

function toJournalEntry(row: OrganizedEntryRow, actionItems: JournalActionItem[]): JournalEntry {
	return {
		id: row.id,
		raw_note_id: row.raw_note_id,
		type: row.type as NoteType,
		cleaned_text: row.cleaned_text,
		summary: row.summary,
		tags: parseJsonArray(row.tags),
		attendees: parseJsonArray(row.attendees),
		decisions: parseJsonArray(row.decisions),
		created_at: row.created_at,
		captured_at: row.captured_at,
		action_items: actionItems,
	};
}

export type ListJournalOptions = {
	day?: string;
	from?: string;
	to?: string;
	type?: string;
	tag?: string;
	limit?: number;
	before?: string;
};

/**
 * Lists organized notes newest-first, joined with their raw note's `created_at` as `captured_at`
 * (filtering `day`/`from`/`to` on that column, since "by day" means the day the note was written,
 * not the night it happened to be reorganized). All supplied filters combine with AND.
 */
export async function listJournalEntries(
	db: D1Database,
	opts: ListJournalOptions = {},
): Promise<JournalEntry[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.day !== undefined) {
		conditions.push("date(r.created_at) = ?");
		params.push(opts.day);
	}
	if (opts.from !== undefined) {
		conditions.push("date(r.created_at) >= ?");
		params.push(opts.from);
	}
	if (opts.to !== undefined) {
		conditions.push("date(r.created_at) <= ?");
		params.push(opts.to);
	}
	if (opts.type !== undefined) {
		conditions.push("o.type = ?");
		params.push(opts.type);
	}
	if (opts.tag !== undefined) {
		conditions.push("EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value = ?)");
		params.push(opts.tag);
	}
	if (opts.before !== undefined) {
		conditions.push("o.created_at < ?");
		params.push(opts.before);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

	const result = await db
		.prepare(
			`SELECT o.id, o.raw_note_id, o.type, o.cleaned_text, o.summary, o.tags, o.attendees, o.decisions, o.created_at, r.created_at AS captured_at
			FROM organized_notes o
			JOIN raw_notes r ON r.id = o.raw_note_id
			${whereClause}
			ORDER BY o.created_at DESC
			LIMIT ?`,
		)
		.bind(...params, limit)
		.all<OrganizedEntryRow>();

	const rows = result.results;
	const actionItems = await actionItemsByOrganizedNoteId(
		db,
		rows.map((row) => row.id),
	);

	return rows.map((row) => toJournalEntry(row, actionItems.get(row.id) ?? []));
}

/**
 * Sanitizes a free-text search query into a literal FTS5 MATCH expression: each whitespace-
 * separated token is wrapped in double quotes (escaping any internal `"` as `""`), so user input
 * can never inject FTS operators (`OR`, `NOT`, `NEAR`, column filters, `*` prefix, etc.) — every
 * token is matched as its own literal phrase.
 */
export function sanitizeFtsQuery(q: string): string {
	return q
		.trim()
		.split(/\s+/)
		.map((token) => `"${token.replace(/"/g, '""')}"`)
		.join(" ");
}

export type SearchJournalOptions = {
	limit?: number;
};

/** Full-text search over organized notes (PRD F7), ranked by FTS5 `bm25` (lower is a better match). */
export async function searchJournalEntries(
	db: D1Database,
	q: string,
	opts: SearchJournalOptions = {},
): Promise<JournalEntry[]> {
	const matchExpr = sanitizeFtsQuery(q);
	const limit = Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

	const result = await db
		.prepare(
			`SELECT o.id, o.raw_note_id, o.type, o.cleaned_text, o.summary, o.tags, o.attendees, o.decisions, o.created_at, r.created_at AS captured_at
			FROM organized_notes_fts f
			JOIN organized_notes o ON o.rowid = f.rowid
			JOIN raw_notes r ON r.id = o.raw_note_id
			WHERE f.organized_notes_fts MATCH ?
			ORDER BY bm25(f.organized_notes_fts) ASC
			LIMIT ?`,
		)
		.bind(matchExpr, limit)
		.all<OrganizedEntryRow>();

	const rows = result.results;
	const actionItems = await actionItemsByOrganizedNoteId(
		db,
		rows.map((row) => row.id),
	);

	return rows.map((row) => toJournalEntry(row, actionItems.get(row.id) ?? []));
}

export const ACTION_ITEM_STATUS_FILTERS = ["open", "done", "dismissed", "all"] as const;
export type ActionItemStatusFilter = (typeof ACTION_ITEM_STATUS_FILTERS)[number];

export const ACTION_ITEM_DUE_FILTERS = ["today", "overdue", "week", "all"] as const;
export type ActionItemDueFilter = (typeof ACTION_ITEM_DUE_FILTERS)[number];

export const ACTION_ITEM_STATUSES = ["open", "done", "dismissed"] as const;

function utcDateString(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function addUtcDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00.000Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export type ListActionItemsOptions = {
	status?: ActionItemStatusFilter;
	due?: ActionItemDueFilter;
	now?: Date;
};

type ActionItemWithContextRow = ActionItemRow & { summary: string; captured_at: string };

/**
 * Lists action items with their parent note's `summary` and `captured_at` for display context,
 * ordered by `due_date` (NULLs last, via the portable `(due_date IS NULL)` trick) then `created_at`.
 * `status` and `due` filters combine with AND; `today`/`overdue`/`week` are computed relative to
 * the UTC date of `now` (defaults to `new Date()`).
 */
export async function listActionItems(
	db: D1Database,
	opts: ListActionItemsOptions = {},
): Promise<ActionItemWithContext[]> {
	const status = opts.status ?? "open";
	const due = opts.due ?? "all";
	const now = opts.now ?? new Date();
	const today = utcDateString(now);

	const conditions: string[] = [];
	const params: unknown[] = [];

	if (status !== "all") {
		conditions.push("a.status = ?");
		params.push(status);
	}

	if (due === "today") {
		conditions.push("a.due_date = ?");
		params.push(today);
	} else if (due === "overdue") {
		conditions.push("a.due_date IS NOT NULL AND a.due_date < ?");
		params.push(today);
	} else if (due === "week") {
		conditions.push("a.due_date IS NOT NULL AND a.due_date >= ? AND a.due_date <= ?");
		params.push(today, addUtcDays(today, WEEK_WINDOW_DAYS));
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const result = await db
		.prepare(
			`SELECT a.id, a.organized_note_id, a.text, a.due_date, a.status, a.created_at, o.summary AS summary, r.created_at AS captured_at
			FROM action_items a
			JOIN organized_notes o ON o.id = a.organized_note_id
			JOIN raw_notes r ON r.id = o.raw_note_id
			${whereClause}
			ORDER BY (a.due_date IS NULL), a.due_date ASC, a.created_at ASC`,
		)
		.bind(...params)
		.all<ActionItemWithContextRow>();

	return result.results.map((row) => ({
		...toActionItem(row),
		summary: row.summary,
		captured_at: row.captured_at,
	}));
}

/**
 * Updates one action item's status, returning the updated row or `null` if `id` doesn't exist.
 */
export async function updateActionItemStatus(
	db: D1Database,
	id: string,
	status: ActionItemStatus,
): Promise<ActionItem | null> {
	const updateResult = await db
		.prepare("UPDATE action_items SET status = ? WHERE id = ?")
		.bind(status, id)
		.run();

	if (updateResult.meta.changes === 0) {
		return null;
	}

	const row = await db
		.prepare(
			"SELECT id, organized_note_id, text, due_date, status, created_at FROM action_items WHERE id = ?",
		)
		.bind(id)
		.first<ActionItemRow>();

	return row ? toActionItem(row) : null;
}

export type ExportPayload = {
	exported_at: string;
	raw_notes: unknown[];
	organized_notes: unknown[];
	action_items: unknown[];
	conversations: unknown[];
	memory_facts: unknown[];
};

/**
 * Full-account export (PRD §7 Portability): everything, including private raw notes — raw notes
 * are the canonical source of truth and portability must not silently drop them. A single
 * `db.batch` runs the five selects together (single-user scale, so a stream isn't warranted).
 */
export async function exportAll(db: D1Database, now: Date = new Date()): Promise<ExportPayload> {
	const results = await db.batch([
		db.prepare(
			"SELECT id, body, created_at, private, processed_at FROM raw_notes ORDER BY created_at ASC",
		),
		db.prepare(
			"SELECT id, raw_note_id, run_id, type, cleaned_text, summary, tags, attendees, decisions, model, created_at FROM organized_notes ORDER BY created_at ASC",
		),
		db.prepare(
			"SELECT id, organized_note_id, text, due_date, status, created_at FROM action_items ORDER BY created_at ASC",
		),
		db.prepare(
			"SELECT id, title, created_at, updated_at FROM conversations ORDER BY created_at ASC",
		),
		db.prepare(
			"SELECT id, text, status, source, source_note_id, created_at, updated_at FROM memory_facts ORDER BY created_at ASC",
		),
	]);

	const [rawNotes, organizedNotes, actionItems, conversations, memoryFacts] = results;
	if (!rawNotes || !organizedNotes || !actionItems || !conversations || !memoryFacts) {
		throw new Error("exportAll: db.batch returned fewer results than statements");
	}

	return {
		exported_at: now.toISOString(),
		raw_notes: rawNotes.results,
		organized_notes: organizedNotes.results,
		action_items: actionItems.results,
		conversations: conversations.results,
		memory_facts: memoryFacts.results,
	};
}
