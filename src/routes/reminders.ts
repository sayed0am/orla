/** HTTP handlers for F5 reminders: manual CRUD plus the action-item "propose reminder" path. */

import {
	cancelReminder,
	listReminders,
	ReminderValidationError,
	scheduleReminder,
} from "../reminders";

const REMINDER_STATUS_FILTERS = ["scheduled", "fired", "cancelled", "failed", "all"] as const;
type ReminderStatusFilter = (typeof REMINDER_STATUS_FILTERS)[number];

function isStatusFilter(value: string): value is ReminderStatusFilter {
	return (REMINDER_STATUS_FILTERS as readonly string[]).includes(value);
}

function parseFireAt(payload: Record<string, unknown>): Date | Response {
	const { fire_at: fireAtRaw } = payload;
	if (typeof fireAtRaw !== "string" || fireAtRaw.trim().length === 0) {
		return Response.json({ error: "fire_at must be a non-empty ISO 8601 string" }, { status: 400 });
	}
	const fireAt = new Date(fireAtRaw);
	if (Number.isNaN(fireAt.getTime())) {
		return Response.json({ error: "fire_at must be a valid ISO 8601 timestamp" }, { status: 400 });
	}
	return fireAt;
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

/** `GET /api/reminders?status=scheduled|fired|cancelled|all` (defaults to `scheduled`). */
export async function handleListReminders(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const statusRaw = url.searchParams.get("status") ?? "scheduled";
	if (!isStatusFilter(statusRaw)) {
		return Response.json(
			{ error: `status must be one of ${REMINDER_STATUS_FILTERS.join(", ")}` },
			{ status: 400 },
		);
	}

	const reminders = await listReminders(env.ORLA_DB, { status: statusRaw });
	return Response.json({ reminders });
}

/** `POST /api/reminders` `{ text, fire_at }` — always `source: "manual"`. */
export async function handleCreateReminder(request: Request, env: Env): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const { text } = payload;
	if (typeof text !== "string" || text.trim().length === 0) {
		return Response.json({ error: "text must be a non-empty string" }, { status: 400 });
	}

	const fireAt = parseFireAt(payload);
	if (fireAt instanceof Response) return fireAt;

	try {
		const reminder = await scheduleReminder(env, { text, fireAt, source: "manual" });
		return Response.json(reminder, { status: 201 });
	} catch (err) {
		if (err instanceof ReminderValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
}

/** `DELETE /api/reminders/:id` — cancels (idempotent) and reschedules the Scheduler's alarm. */
export async function handleCancelReminder(env: Env, id: string): Promise<Response> {
	const result = await cancelReminder(env, id);
	if (result === "not_found") {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	return new Response(null, { status: 204 });
}

/**
 * `POST /api/action-items/:id/remind` `{ fire_at }` — the F3 "propose reminders for one-tap
 * confirmation" path (PRD F5): the client already decided the task text (the action item's own)
 * and just supplies the chosen time.
 */
export async function handleRemindFromActionItem(
	request: Request,
	env: Env,
	actionItemId: string,
): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const itemRow = await env.ORLA_DB.prepare("SELECT id, text FROM action_items WHERE id = ?")
		.bind(actionItemId)
		.first<{ id: string; text: string }>();
	if (!itemRow) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	const fireAt = parseFireAt(payload);
	if (fireAt instanceof Response) return fireAt;

	try {
		const reminder = await scheduleReminder(env, {
			text: itemRow.text,
			fireAt,
			source: "action_item",
			sourceId: itemRow.id,
		});
		return Response.json(reminder, { status: 201 });
	} catch (err) {
		if (err instanceof ReminderValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
}
