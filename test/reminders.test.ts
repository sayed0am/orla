import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { setLlmFetchForTests } from "../src/conversation";
import { generateVapidKeys } from "../src/push";
import {
	cancelReminder,
	type Reminder,
	ReminderValidationError,
	scheduleReminder,
	setReminderFetchForTests,
	setReminderVapidForTests,
} from "../src/reminders";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";
import { decryptPushBody, generateTestSubscriber } from "./push-crypto-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setLlmFetchForTests(undefined);
	setReminderFetchForTests(undefined);
	setReminderVapidForTests(undefined);
});

function schedulerStub() {
	return env.SCHEDULER.get(env.SCHEDULER.idFromName("scheduler"));
}

async function insertSubscription(subscriber: { p256dh: string; auth: string }): Promise<string> {
	const endpoint = `https://push.example.com/reminder/${crypto.randomUUID()}`;
	await env.ORLA_DB.prepare(
		"INSERT INTO push_subscriptions (id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
	)
		.bind(crypto.randomUUID(), endpoint, subscriber.p256dh, subscriber.auth)
		.run();
	return endpoint;
}

describe("scheduleReminder", () => {
	it("inserts a scheduled reminder and arms the Scheduler's alarm", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fireAt = new Date(Date.now() + 60 * 60 * 1000);

		const reminder = await scheduleReminder(env, {
			text: `call the dentist ${marker}`,
			fireAt,
			source: "manual",
		});

		expect(reminder).toMatchObject({
			text: `call the dentist ${marker}`,
			fire_at: fireAt.toISOString(),
			status: "scheduled",
			source: "manual",
			source_id: null,
		});

		const row = await env.ORLA_DB.prepare("SELECT id, status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ id: string; status: string }>();
		expect(row).toMatchObject({ id: reminder.id, status: "scheduled" });

		// `runDurableObjectAlarm` only invokes `alarm()` when an alarm is actually armed, so a
		// truthy result here proves `scheduleReminder` -> `reschedule()` set one.
		const ran = await runDurableObjectAlarm(schedulerStub());
		expect(ran).toBe(true);

		// The reminder isn't due for another hour, so the forced run must be a no-op for it.
		const after = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string }>();
		expect(after?.status).toBe("scheduled");

		await cancelReminder(env, reminder.id);
	});

	it("rejects a fire_at that is not in the future", async () => {
		await expect(
			scheduleReminder(env, {
				text: "past reminder",
				fireAt: new Date(Date.now() - 1000),
				source: "manual",
			}),
		).rejects.toThrow(ReminderValidationError);
	});

	it("rejects a fire_at more than a year out", async () => {
		const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
		await expect(
			scheduleReminder(env, { text: "too far out", fireAt: farFuture, source: "manual" }),
		).rejects.toThrow(ReminderValidationError);
	});

	it("rejects empty text", async () => {
		await expect(
			scheduleReminder(env, {
				text: "   ",
				fireAt: new Date(Date.now() + 60_000),
				source: "manual",
			}),
		).rejects.toThrow(ReminderValidationError);
	});
});

describe("cancelReminder", () => {
	it("returns not_found for an unknown id", async () => {
		expect(await cancelReminder(env, crypto.randomUUID())).toBe("not_found");
	});

	it("cancelling the soonest reminder reschedules the Scheduler's alarm to the next one", async () => {
		const soon = new Date(Date.now() + 60_000);
		const later = new Date(Date.now() + 120_000);
		const soonReminder = await scheduleReminder(env, {
			text: "soon",
			fireAt: soon,
			source: "manual",
		});
		const laterReminder = await scheduleReminder(env, {
			text: "later",
			fireAt: later,
			source: "manual",
		});

		const beforeCancel = await schedulerStub().reschedule();
		expect(beforeCancel.nextFireAt).toBe(soon.toISOString());

		expect(await cancelReminder(env, soonReminder.id)).toBe("cancelled");

		const afterCancel = await schedulerStub().reschedule();
		expect(afterCancel.nextFireAt).toBe(later.toISOString());

		await cancelReminder(env, laterReminder.id);
		const cleared = await schedulerStub().reschedule();
		expect(cleared.nextFireAt).toBeNull();
	});

	it("cancelling an already-cancelled reminder is a no-op, not an error", async () => {
		const reminder = await scheduleReminder(env, {
			text: "double cancel",
			fireAt: new Date(Date.now() + 60_000),
			source: "manual",
		});
		expect(await cancelReminder(env, reminder.id)).toBe("cancelled");
		expect(await cancelReminder(env, reminder.id)).toBe("cancelled");

		const row = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string }>();
		expect(row?.status).toBe("cancelled");
	});
});

describe("Scheduler#alarm", () => {
	it("fires a due reminder, sends exactly one push, and marks it fired", async () => {
		const vapidKeys = await generateVapidKeys();
		const subscriber = await generateTestSubscriber();
		const endpoint = await insertSubscription(subscriber);
		setReminderVapidForTests({
			publicKey: vapidKeys.publicKey,
			privateKey: vapidKeys.privateKey,
			subject: "mailto:test@example.com",
		});

		const captured: Uint8Array[] = [];
		setReminderFetchForTests(async (_input, init) => {
			captured.push(init?.body as Uint8Array);
			return new Response(null, { status: 201 });
		});

		const marker = crypto.randomUUID().slice(0, 8);
		const reminder = await scheduleReminder(env, {
			text: `water plants ${marker}`,
			fireAt: new Date(Date.now() + 5_000), // within the alarm's 30s lookahead
			source: "manual",
		});

		const ran = await runDurableObjectAlarm(schedulerStub());
		expect(ran).toBe(true);
		expect(captured).toHaveLength(1);

		const decrypted = await decryptPushBody(captured[0]?.buffer as ArrayBuffer, subscriber);
		expect(JSON.parse(decrypted)).toEqual({
			title: "Reminder",
			body: `water plants ${marker}`,
			url: "/#brief",
		});

		const row = await env.ORLA_DB.prepare("SELECT status, fired_at FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string; fired_at: string | null }>();
		expect(row?.status).toBe("fired");
		expect(row?.fired_at).not.toBeNull();

		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.run();
	});

	it("marks a due reminder fired without pushing when VAPID is not configured", async () => {
		setReminderVapidForTests(null);
		let calls = 0;
		setReminderFetchForTests(async () => {
			calls++;
			return new Response(null, { status: 201 });
		});

		const reminder = await scheduleReminder(env, {
			text: "no push configured",
			fireAt: new Date(Date.now() + 5_000),
			source: "manual",
		});

		expect(await runDurableObjectAlarm(schedulerStub())).toBe(true);
		expect(calls).toBe(0);

		const row = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string }>();
		expect(row?.status).toBe("fired");
	});

	it("is idempotent across two alarm invocations: exactly one push is ever sent", async () => {
		setReminderVapidForTests(null); // push mechanics are covered above; this isolates idempotence
		const reminder = await scheduleReminder(env, {
			text: "retry me",
			fireAt: new Date(Date.now() + 5_000),
			source: "manual",
		});
		// Keeps the Scheduler's alarm armed after the first run fires `reminder`, so the second
		// `runDurableObjectAlarm` below forces a genuine second `alarm()` invocation instead of
		// finding no alarm set at all.
		const farFuture = await scheduleReminder(env, {
			text: "keeps the alarm armed",
			fireAt: new Date(Date.now() + 60 * 60 * 1000),
			source: "manual",
		});

		let calls = 0;
		setReminderFetchForTests(async () => {
			calls++;
			return new Response(null, { status: 201 });
		});

		expect(await runDurableObjectAlarm(schedulerStub())).toBe(true);
		const afterFirst = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string }>();
		expect(afterFirst?.status).toBe("fired");

		// Second invocation: `reminder` is no longer `scheduled`, so it must not be touched again;
		// `farFuture` isn't due yet either, so this run should process nothing at all.
		expect(await runDurableObjectAlarm(schedulerStub())).toBe(true);
		const afterSecond = await env.ORLA_DB.prepare("SELECT status FROM reminders WHERE id = ?")
			.bind(reminder.id)
			.first<{ status: string }>();
		expect(afterSecond?.status).toBe("fired");
		expect(calls).toBe(0); // VAPID unset in this test, so "push" here means broadcast attempts

		await cancelReminder(env, farFuture.id);
	});
});

describe("reminder routes", () => {
	async function listRemindersReq(status?: string): Promise<Response> {
		const qs = status !== undefined ? `?status=${status}` : "";
		return SELF.fetch(`http://example.com/api/reminders${qs}`, await withAccessHeader());
	}

	async function createReminderReq(body: unknown): Promise<Response> {
		return SELF.fetch(
			"http://example.com/api/reminders",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	}

	async function deleteReminderReq(id: string): Promise<Response> {
		return SELF.fetch(
			`http://example.com/api/reminders/${id}`,
			await withAccessHeader({ method: "DELETE" }),
		);
	}

	it("creates a manual reminder that appears in the default (scheduled) list", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();

		const createRes = await createReminderReq({ text: `buy milk ${marker}`, fire_at: fireAt });
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as Reminder;
		expect(created).toMatchObject({
			text: `buy milk ${marker}`,
			fire_at: fireAt,
			source: "manual",
			status: "scheduled",
		});

		const listRes = await listRemindersReq();
		expect(listRes.status).toBe(200);
		const { reminders } = (await listRes.json()) as { reminders: Reminder[] };
		expect(reminders.some((r) => r.id === created.id)).toBe(true);

		await deleteReminderReq(created.id);
	});

	it("rejects a fire_at that is not in the future", async () => {
		const res = await createReminderReq({
			text: "too late",
			fire_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects a missing or empty text", async () => {
		const res = await createReminderReq({ fire_at: new Date(Date.now() + 60_000).toISOString() });
		expect(res.status).toBe(400);
	});

	it("rejects an invalid status filter", async () => {
		expect((await listRemindersReq("bogus")).status).toBe(400);
	});

	it("cancels a reminder (204) and it moves from the scheduled list to the cancelled list", async () => {
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		const created = (await (
			await createReminderReq({ text: "cancel me", fire_at: fireAt })
		).json()) as Reminder;

		expect((await deleteReminderReq(created.id)).status).toBe(204);

		const { reminders: scheduled } = (await (await listRemindersReq()).json()) as {
			reminders: Reminder[];
		};
		expect(scheduled.some((r) => r.id === created.id)).toBe(false);

		const { reminders: cancelled } = (await (await listRemindersReq("cancelled")).json()) as {
			reminders: Reminder[];
		};
		expect(cancelled.some((r) => r.id === created.id)).toBe(true);
	});

	it("is idempotent (204) on a repeat cancel, and 404s for an unknown id", async () => {
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		const created = (await (
			await createReminderReq({ text: "double cancel via route", fire_at: fireAt })
		).json()) as Reminder;

		expect((await deleteReminderReq(created.id)).status).toBe(204);
		expect((await deleteReminderReq(created.id)).status).toBe(204);
		expect((await deleteReminderReq(crypto.randomUUID())).status).toBe(404);
	});

	it("creates a reminder from an action item via POST /api/action-items/:id/remind", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const rawId = crypto.randomUUID();
		await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body, private) VALUES (?, ?, 0)")
			.bind(rawId, `note ${marker}`)
			.run();
		const orgId = crypto.randomUUID();
		await env.ORLA_DB.prepare(
			`INSERT INTO organized_notes (id, raw_note_id, run_id, type, cleaned_text, summary, tags, model)
			 VALUES (?, ?, ?, 'task', ?, ?, '[]', 'test-model')`,
		)
			.bind(orgId, rawId, crypto.randomUUID(), `note ${marker}`, `note ${marker}`)
			.run();
		// A real reorganization pass always stamps `raw_notes.processed_at` together with writing
		// `organized_notes` (see test/brief.test.ts's `insertOrganizedNote` for the same note):
		// skipping this would leave an inconsistent row that a concurrently-running
		// `runReorganization()` sweep in another test file could pick back up and crash on the
		// `organized_notes.raw_note_id` UNIQUE constraint (storage persists across the whole run).
		await env.ORLA_DB.prepare("UPDATE raw_notes SET processed_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), rawId)
			.run();
		const actionItemId = crypto.randomUUID();
		await env.ORLA_DB.prepare(
			"INSERT INTO action_items (id, organized_note_id, text) VALUES (?, ?, ?)",
		)
			.bind(actionItemId, orgId, `follow up ${marker}`)
			.run();

		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		const res = await SELF.fetch(
			`http://example.com/api/action-items/${actionItemId}/remind`,
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ fire_at: fireAt }),
			}),
		);
		expect(res.status).toBe(201);
		const reminder = (await res.json()) as Reminder;
		expect(reminder).toMatchObject({
			text: `follow up ${marker}`,
			fire_at: fireAt,
			source: "action_item",
			source_id: actionItemId,
			status: "scheduled",
		});

		await deleteReminderReq(reminder.id);
	});

	it("returns 404 reminding from an unknown action item", async () => {
		const res = await SELF.fetch(
			`http://example.com/api/action-items/${crypto.randomUUID()}/remind`,
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ fire_at: new Date(Date.now() + 60_000).toISOString() }),
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("Conversation#send reminder pre-step (PRD F5 chat path)", () => {
	type ConversationRecord = { id: string };

	async function createConversation(): Promise<ConversationRecord> {
		const res = await SELF.fetch(
			"http://example.com/api/conversations",
			await withAccessHeader({ method: "POST" }),
		);
		return (await res.json()) as ConversationRecord;
	}

	async function postMessage(id: string, message: string): Promise<Response> {
		return SELF.fetch(
			`http://example.com/api/conversations/${id}/messages`,
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message }),
			}),
		);
	}

	async function parseSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
		const text = await res.text();
		return text
			.split("\n\n")
			.filter((block) => block.trim().length > 0)
			.map((block) => {
				let event = "";
				let data = "";
				for (const line of block.split("\n")) {
					if (line.startsWith("event:")) event = line.slice("event:".length).trim();
					if (line.startsWith("data:")) data = line.slice("data:".length).trim();
				}
				return { event, data: JSON.parse(data) };
			});
	}

	function fakeStreamingReplyResponse(replyText: string): Response {
		const encoder = new TextEncoder();
		const lines = [
			`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`,
			`data: ${JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			})}\n\n`,
			"data: [DONE]\n\n",
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of lines) controller.enqueue(encoder.encode(line));
				controller.close();
			},
		});
		return new Response(stream, { status: 200 });
	}

	it("skips the extraction call entirely for a message that never mentions 'remind'", async () => {
		const conv = await createConversation();
		const requests: Array<Record<string, unknown>> = [];
		setLlmFetchForTests(async (_input, init) => {
			requests.push(JSON.parse((init?.body as string) ?? "{}"));
			return fakeStreamingReplyResponse("Hi!");
		});

		await (await postMessage(conv.id, "Hello, how are you?")).text();
		expect(requests).toHaveLength(1); // only the normal streaming chat call, no extraction call
	});

	it("schedules a reminder, emits an SSE reminder event before the deltas, and keeps the cached prefix identical to a plain send", async () => {
		// Baseline: a plain, non-reminder send in its own conversation, to compare the cached
		// system-prompt prefix against (the cache-prefix invariant this pre-step must preserve).
		const plainConv = await createConversation();
		const plainRequests: Array<Record<string, unknown>> = [];
		setLlmFetchForTests(async (_input, init) => {
			plainRequests.push(JSON.parse((init?.body as string) ?? "{}"));
			return fakeStreamingReplyResponse("Hello there");
		});
		await (await postMessage(plainConv.id, "Hello, how are you?")).text();
		const plainMessages = plainRequests[0]?.messages as Array<{ role: string; content: unknown }>;

		// The reminder-triggering send, in a fresh conversation.
		const conv = await createConversation();
		const fireAtIso = "2026-08-27T15:00:00-04:00"; // in the future relative to the real clock

		const requests: Array<{ body: Record<string, unknown> }> = [];
		setLlmFetchForTests(async (_input, init) => {
			const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
			requests.push({ body });

			if (body.stream === false) {
				// The reminder-extraction `completeJson` call.
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									is_reminder: true,
									text: "feed the cat",
									fire_at: fireAtIso,
									ambiguous: null,
								}),
							},
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				});
			}

			return fakeStreamingReplyResponse("Done, I'll remind you.");
		});

		const res = await postMessage(conv.id, "remind me Thursday at 3pm to feed the cat");
		expect(res.status).toBe(200);
		const events = await parseSse(res);

		expect(events[0]?.event).toBe("reminder"); // emitted before any delta
		const reminderEvents = events.filter((e) => e.event === "reminder");
		expect(reminderEvents).toHaveLength(1);
		const reminderData = reminderEvents[0]?.data as { id: string; text: string; fire_at: string };
		expect(reminderData.text).toBe("feed the cat");

		const row = await env.ORLA_DB.prepare(
			"SELECT text, source, source_id, status FROM reminders WHERE id = ?",
		)
			.bind(reminderData.id)
			.first<{ text: string; source: string; source_id: string; status: string }>();
		expect(row).toMatchObject({
			text: "feed the cat",
			source: "chat",
			source_id: conv.id,
			status: "scheduled",
		});

		expect(requests).toHaveLength(2);
		expect(requests[0]?.body.stream).toBe(false);
		expect(requests[1]?.body.stream).toBe(true);

		const chatMessages = requests[1]?.body.messages as Array<{ role: string; content: unknown }>;
		expect(chatMessages).toHaveLength(2);
		// Cache-prefix invariant: the cached system message is byte-identical to a plain send's.
		expect(chatMessages[0]).toEqual(plainMessages?.[0]);

		const finalContent = chatMessages[1]?.content as string;
		expect(finalContent.startsWith("remind me Thursday at 3pm to feed the cat")).toBe(true);
		expect(finalContent).toContain("<context>");
		expect(finalContent).toContain("Reminder scheduled for");
		expect(finalContent).toContain('"feed the cat"');

		await cancelReminder(env, reminderData.id);
	});

	it("treats an ambiguous reminder request as such: no reminder is scheduled and the model is told why", async () => {
		const conv = await createConversation();
		const requests: Array<Record<string, unknown>> = [];
		setLlmFetchForTests(async (_input, init) => {
			const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
			requests.push(body);
			if (body.stream === false) {
				return Response.json({
					choices: [
						{
							message: {
								content: JSON.stringify({
									is_reminder: true,
									text: "",
									fire_at: null,
									ambiguous: "no time given",
								}),
							},
						},
					],
					usage: { prompt_tokens: 8, completion_tokens: 4 },
				});
			}
			return fakeStreamingReplyResponse("When would you like the reminder?");
		});

		const before = await env.ORLA_DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{
			n: number;
		}>();
		await (await postMessage(conv.id, "remind me to call mom")).text();
		const after = await env.ORLA_DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{
			n: number;
		}>();
		expect(after?.n).toBe(before?.n);

		const chatReq = requests[1] as Record<string, unknown>;
		const messages = chatReq.messages as Array<{ role: string; content: unknown }>;
		const finalContent = messages[messages.length - 1]?.content as string;
		expect(finalContent).toContain("Reminder request was ambiguous: no time given");
	});

	it("falls through to a normal reply when the extraction call fails outright", async () => {
		const conv = await createConversation();
		setLlmFetchForTests(async (_input, init) => {
			const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
			if (body.stream === false) {
				return new Response("upstream failure", { status: 500 });
			}
			return fakeStreamingReplyResponse("Sure thing");
		});

		const before = await env.ORLA_DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{
			n: number;
		}>();
		const res = await postMessage(conv.id, "please remind me later");
		expect(res.status).toBe(200);
		const events = await parseSse(res);
		expect(events.some((e) => e.event === "reminder")).toBe(false);
		expect(events.some((e) => e.event === "error")).toBe(false);
		expect(
			events
				.filter((e) => e.event === "delta")
				.map((e) => e.data as string)
				.join(""),
		).toBe("Sure thing");

		const after = await env.ORLA_DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{
			n: number;
		}>();
		expect(after?.n).toBe(before?.n);
	});
});
