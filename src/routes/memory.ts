/** HTTP handlers for Memory Option A (PRD §8): curated facts, user-controlled. */

import {
	createFact,
	deleteFact,
	getMemoryBlock,
	listFacts,
	type MemoryFactStatus,
	MemoryValidationError,
	updateFact,
} from "../memory";

/** Matches `/api/memory/:id`, capturing `:id` only when it is a v4 UUID. */
export const MEMORY_FACT_PATH_RE =
	/^\/api\/memory\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const MEMORY_FACT_STATUSES = ["proposed", "active", "archived"] as const;
const MEMORY_STATUS_FILTERS = [...MEMORY_FACT_STATUSES, "all"] as const;
type MemoryStatusFilter = (typeof MEMORY_STATUS_FILTERS)[number];

function isStatus(value: string): value is MemoryFactStatus {
	return (MEMORY_FACT_STATUSES as readonly string[]).includes(value);
}

function isStatusFilter(value: string): value is MemoryStatusFilter {
	return (MEMORY_STATUS_FILTERS as readonly string[]).includes(value);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}
	return payload as Record<string, unknown>;
}

/** `GET /api/memory?status=active|proposed|archived|all` (default `all`). */
export async function handleMemoryList(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const statusRaw = url.searchParams.get("status") ?? "all";
	if (!isStatusFilter(statusRaw)) {
		return Response.json(
			{ error: `status must be one of ${MEMORY_STATUS_FILTERS.join(", ")}` },
			{ status: 400 },
		);
	}

	const facts = await listFacts(env.ORLA_DB, statusRaw === "all" ? undefined : statusRaw);
	return Response.json({ facts });
}

/** `POST /api/memory` `{ text }` — always `status: "active"`, `source: "user"`. */
export async function handleMemoryCreate(request: Request, env: Env): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const { text } = payload;
	if (typeof text !== "string") {
		return Response.json({ error: "text must be a non-empty string" }, { status: 400 });
	}

	try {
		const fact = await createFact(env.ORLA_DB, { text, source: "user", status: "active" });
		return Response.json(fact, { status: 201 });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
}

/** `PATCH /api/memory/:id` `{ text?, status? }` — activate a proposal, archive, or edit text. */
export async function handleMemoryUpdate(
	request: Request,
	env: Env,
	id: string,
): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const { text, status } = payload;
	if (text !== undefined && typeof text !== "string") {
		return Response.json({ error: "text must be a string" }, { status: 400 });
	}
	if (status !== undefined && (typeof status !== "string" || !isStatus(status))) {
		return Response.json(
			{ error: `status must be one of ${MEMORY_FACT_STATUSES.join(", ")}` },
			{ status: 400 },
		);
	}

	try {
		const fact = await updateFact(env.ORLA_DB, id, { text, status });
		if (!fact) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		return Response.json(fact, { status: 200 });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
}

/** `DELETE /api/memory/:id` — hard delete; the user owns this table. */
export async function handleMemoryDelete(env: Env, id: string): Promise<Response> {
	const deleted = await deleteFact(env.ORLA_DB, id);
	if (!deleted) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	return new Response(null, { status: 204 });
}

/** `GET /api/memory/preview` — what the assistant actually sees (PRD §8 auditability). */
export async function handleMemoryPreview(env: Env): Promise<Response> {
	const block = await getMemoryBlock(env.ORLA_DB);
	return Response.json({ block, chars: block.length });
}
