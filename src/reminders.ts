/**
 * F5 — reminders (PRD F5): Durable Object alarms firing Web Push notifications. D1's `reminders`
 * table (migrations/0006) is the source of truth; the single `Scheduler` Durable Object instance
 * (name "scheduler") holds no reminder data of its own — it only keeps `ctx.storage`'s one alarm
 * pointed at the earliest `scheduled` row, via `reschedule()`.
 *
 * Also home to the static system prompt and JSON-shape helpers for the F5 chat path ("remind me
 * Thursday 3pm to…", PRD F5): a cheap, regex-gated `completeJson` call from
 * `Conversation#send` (src/conversation.ts) extracts `{ is_reminder, text, fire_at, ambiguous }`
 * from a single user message. This is deliberately NOT a general tool-calling loop — just one
 * narrow, hand-validated JSON extraction wired into one call site.
 */

import { DurableObject } from "cloudflare:workers";
import type { ChatMessage } from "./prompt";
import { broadcast, type VapidConfig } from "./push";

export type ReminderStatus = "scheduled" | "fired" | "cancelled" | "failed";
export type ReminderSource = "chat" | "action_item" | "manual";

export type Reminder = {
	id: string;
	text: string;
	fire_at: string;
	status: ReminderStatus;
	source: ReminderSource;
	source_id: string | null;
	created_at: string;
	fired_at: string | null;
};

const REMINDER_COLUMNS = "id, text, fire_at, status, source, source_id, created_at, fired_at";
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
// An alarm fires once storage's clock reaches `setAlarm`'s timestamp; picking up anything due in
// the next 30s (rather than only fire_at <= now) absorbs the gap between the alarm firing and
// this query running, so a reminder set for exactly "now" is never missed by a few milliseconds.
const ALARM_LOOKAHEAD_MS = 30_000;

export class ReminderValidationError extends Error {}

// Test-only hook, mirroring `setPushFetchForTests` in src/routes/push.ts: the Scheduler DO's
// `alarm()` can't have a fake fetch passed through an RPC call, so tests install one here instead.
let testReminderFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake push fetch used by `Scheduler#alarm`. */
export function setReminderFetchForTests(f: typeof fetch | undefined): void {
	testReminderFetch = f;
}

// Test-only hook. Unlike `runMorningBrief` (a plain function taking `env` as a parameter, so a
// test can pass a `{ ...env, VAPID_PUBLIC_KEY: ... }` override directly), `Scheduler#alarm` reads
// `this.env`, which is the Worker's actual bound environment and can't be swapped per call — and
// that bound environment always has an empty `VAPID_PUBLIC_KEY` in this test harness (see
// test/push.test.ts's `expect(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY).toBeFalsy()`), so
// there is no way to exercise the "push configured" path through `this.env` alone. `undefined`
// (the default) defers to `this.env`; `null` or a real `VapidConfig` overrides it explicitly.
let testVapidConfig: VapidConfig | null | undefined;

/** Test-only: override (or clear, with `undefined`) the VAPID config used by `Scheduler#alarm`. */
export function setReminderVapidForTests(v: VapidConfig | null | undefined): void {
	testVapidConfig = v;
}

function schedulerStub(env: Env) {
	return env.SCHEDULER.get(env.SCHEDULER.idFromName("scheduler"));
}

/**
 * Inserts a new reminder (validating `fireAt` is in the future and within a year) and asks the
 * Scheduler DO to reconsider its alarm — the new row might now be the soonest `scheduled` one.
 */
export async function scheduleReminder(
	env: Env,
	input: { text: string; fireAt: Date; source: ReminderSource; sourceId?: string },
): Promise<Reminder> {
	const fireAtMs = input.fireAt.getTime();
	const nowMs = Date.now();
	if (!Number.isFinite(fireAtMs)) {
		throw new ReminderValidationError("fire_at must be a valid date");
	}
	if (fireAtMs <= nowMs) {
		throw new ReminderValidationError("fire_at must be in the future");
	}
	if (fireAtMs - nowMs > MAX_FUTURE_MS) {
		throw new ReminderValidationError("fire_at must be within one year");
	}
	if (input.text.trim().length === 0) {
		throw new ReminderValidationError("text must be a non-empty string");
	}

	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		"INSERT INTO reminders (id, text, fire_at, source, source_id) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, input.text, input.fireAt.toISOString(), input.source, input.sourceId ?? null)
		.run();

	await schedulerStub(env).reschedule();

	const row = await env.ORLA_DB.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`)
		.bind(id)
		.first<Reminder>();
	if (!row) {
		throw new Error("scheduleReminder: row missing after insert");
	}
	return row;
}

/**
 * Cancels a scheduled reminder (idempotent: cancelling an already-fired/cancelled/failed one is a
 * no-op, not an error) and asks the Scheduler DO to reconsider its alarm. Returns "not_found" only
 * when no reminder with `id` exists at all.
 */
export async function cancelReminder(env: Env, id: string): Promise<"cancelled" | "not_found"> {
	const row = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
		.bind(id)
		.first<{ status: ReminderStatus }>();
	if (!row) {
		return "not_found";
	}

	if (row.status === "scheduled") {
		await env.ORLA_DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?")
			.bind(id)
			.run();
		await schedulerStub(env).reschedule();
	}

	return "cancelled";
}

export async function listReminders(
	db: D1Database,
	opts?: { status?: ReminderStatus | "all"; limit?: number },
): Promise<Reminder[]> {
	const limit = opts?.limit ?? 100;

	if (opts?.status !== undefined && opts.status !== "all") {
		const result = await db
			.prepare(
				`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE status = ? ORDER BY fire_at ASC LIMIT ?`,
			)
			.bind(opts.status, limit)
			.all<Reminder>();
		return result.results;
	}

	const result = await db
		.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders ORDER BY fire_at ASC LIMIT ?`)
		.bind(limit)
		.all<Reminder>();
	return result.results;
}

/**
 * Single DO instance (name "scheduler") owning the one alarm that drives every reminder. Holds no
 * reminder data itself — `reschedule()` re-reads D1 for the earliest `scheduled` row and points
 * `ctx.storage`'s alarm at it (or clears the alarm when none remain).
 */
export class Scheduler extends DurableObject<Env> {
	async reschedule(): Promise<{ nextFireAt: string | null }> {
		const row = await this.env.ORLA_DB.prepare(
			"SELECT fire_at FROM reminders WHERE status = 'scheduled' ORDER BY fire_at ASC LIMIT 1",
		).first<{ fire_at: string }>();

		if (!row) {
			await this.ctx.storage.deleteAlarm();
			return { nextFireAt: null };
		}

		await this.ctx.storage.setAlarm(new Date(row.fire_at).getTime());
		return { nextFireAt: row.fire_at };
	}

	/**
	 * Fires every reminder due within the next `ALARM_LOOKAHEAD_MS`, pushes it (skipped, but still
	 * marked fired, when VAPID isn't configured), then reschedules for whatever is next. Re-checks
	 * each row's status immediately before acting so a retried alarm invocation never double-fires
	 * a reminder another invocation already finished.
	 */
	async alarm(): Promise<void> {
		const db = this.env.ORLA_DB;
		const cutoff = new Date(Date.now() + ALARM_LOOKAHEAD_MS).toISOString();

		const due = await db
			.prepare("SELECT id, text FROM reminders WHERE status = 'scheduled' AND fire_at <= ?")
			.bind(cutoff)
			.all<{ id: string; text: string }>();

		const vapid: VapidConfig | null =
			testVapidConfig !== undefined
				? testVapidConfig
				: this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY
					? {
							publicKey: this.env.VAPID_PUBLIC_KEY,
							privateKey: this.env.VAPID_PRIVATE_KEY,
							subject: this.env.VAPID_SUBJECT,
						}
					: null;
		const fetchImpl = testReminderFetch ?? fetch;

		for (const row of due.results) {
			const current = await db
				.prepare("SELECT status FROM reminders WHERE id = ?")
				.bind(row.id)
				.first<{ status: ReminderStatus }>();
			if (current?.status !== "scheduled") {
				continue; // already handled by a prior (possibly retried) invocation of this alarm
			}

			let nextStatus: "fired" | "failed" = "fired";
			if (vapid) {
				try {
					await broadcast(
						db,
						JSON.stringify({ title: "Reminder", body: row.text, url: "/#brief" }),
						vapid,
						fetchImpl,
					);
				} catch {
					nextStatus = "failed";
				}
			}

			await db
				.prepare(
					"UPDATE reminders SET status = ?, fired_at = ? WHERE id = ? AND status = 'scheduled'",
				)
				.bind(nextStatus, new Date().toISOString(), row.id)
				.run();
		}

		await this.reschedule();
	}
}

// --- F5 chat path: "remind me Thursday 3pm to…" (PRD F5) --------------------------------------

/** Gates the cheap reminder-extraction pre-step in `Conversation#send` — most messages skip it. */
export const REMINDER_TRIGGER_RE = /\bremind(er)?\b/i;

/**
 * Static, deterministic system prompt for the reminder-extraction call. No dates or randomness —
 * sent with `cache_control` so it doesn't compete with the main chat system prompt's own cache
 * entry, but still amortizes across every message that mentions "remind".
 */
export const REMINDER_EXTRACTION_SYSTEM_PROMPT = [
	"You detect reminder requests inside a single user chat message.",
	'The user message may ask to be reminded of something at a later time (e.g. "remind me ' +
		'Thursday at 3pm to call the dentist"). Any other message — including one that merely ' +
		'mentions the word "reminder" in passing — is not a reminder request.',
	"You will also receive `now` (an ISO 8601 UTC timestamp) and `tz_offset_minutes` (minutes to " +
		"add to UTC to get the user's local time). Use these, not any date you might otherwise " +
		'assume, to resolve relative times like "Thursday" or "in an hour".',
	"Return ONLY a single JSON object, with no prose before or after it, of the exact shape " +
		'{"is_reminder": boolean, "text": string, "fire_at": string | null, "ambiguous": string | null}.',
	"`is_reminder` is true only when the message clearly asks to be reminded of something at a " +
		"specific or clearly-resolvable future time.",
	'`text` is the short reminder text to show back to the user later (e.g. "call the dentist"); ' +
		'"" when `is_reminder` is false.',
	"`fire_at` is an ISO 8601 timestamp WITH a UTC offset matching `tz_offset_minutes` (e.g. " +
		'"2026-08-27T15:00:00-04:00"), representing the resolved local fire time. `null` when ' +
		"`is_reminder` is false or the time cannot be resolved.",
	'`ambiguous` is a short, user-facing reason (e.g. "which Thursday?" or "no time given") when ' +
		"the message is a reminder request but its time or task is unclear; otherwise `null`.",
	"Never invent a time, date, or task detail that was not stated or clearly implied by the message.",
].join("\n");

export type ReminderDetection = {
	is_reminder: boolean;
	text: string;
	fire_at: string | null;
	ambiguous: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Hand-rolled validation of the extraction call's output — never trust raw model JSON. */
export function normalizeReminderDetection(value: unknown): ReminderDetection | null {
	if (!isRecord(value) || typeof value.is_reminder !== "boolean") {
		return null;
	}
	return {
		is_reminder: value.is_reminder,
		text: typeof value.text === "string" ? value.text : "",
		fire_at: typeof value.fire_at === "string" ? value.fire_at : null,
		ambiguous: typeof value.ambiguous === "string" ? value.ambiguous : null,
	};
}

function cachedSystemMessage(text: string): ChatMessage {
	return {
		role: "system",
		content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
	};
}

/** Builds the (uncached) messages for the reminder-extraction `completeJson` call. */
export function buildReminderDetectionMessages(
	userMessage: string,
	now: Date,
	tzOffsetMinutes: number,
): ChatMessage[] {
	return [
		cachedSystemMessage(REMINDER_EXTRACTION_SYSTEM_PROMPT),
		{
			role: "user",
			content: JSON.stringify({
				message: userMessage,
				now: now.toISOString(),
				tz_offset_minutes: tzOffsetMinutes,
			}),
		},
	];
}

/**
 * Renders the "local" wall-clock time straight out of an offset-carrying ISO 8601 string (e.g.
 * the extraction call's `fire_at`) without touching a host timezone database — the digits before
 * the offset already ARE the local time for that offset.
 */
export function formatReminderLocalTime(offsetIso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(offsetIso);
	if (!match) {
		return offsetIso;
	}
	const [, year, month, day, hour, minute] = match;
	return `${year}-${month}-${day} ${hour}:${minute}`;
}
