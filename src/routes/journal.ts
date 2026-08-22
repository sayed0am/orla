/** HTTP handlers for F7 journal views: browse/search organized notes, action items, export. */

import {
	ACTION_ITEM_DUE_FILTERS,
	ACTION_ITEM_STATUS_FILTERS,
	ACTION_ITEM_STATUSES,
	type ActionItemDueFilter,
	type ActionItemStatus,
	type ActionItemStatusFilter,
	exportAll,
	listActionItems,
	listJournalEntries,
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

/** `GET /api/export` — full account export (PRD §7 Portability), including private raw notes. */
export async function handleExport(env: Env): Promise<Response> {
	const now = new Date();
	const payload = await exportAll(env.ORLA_DB, now);
	const filename = `orla-export-${now.toISOString().slice(0, 10)}.json`;

	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"content-disposition": `attachment; filename="${filename}"`,
		},
	});
}
