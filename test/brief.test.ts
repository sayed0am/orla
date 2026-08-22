import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import type { BriefInputs } from "../src/brief";
import { buildBriefInputs, renderBriefMarkdown, runMorningBrief } from "../src/brief";
import { generateVapidKeys } from "../src/push";
import { consecutiveFailedRuns } from "../src/reorganize";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";
import { decryptPushBody, generateTestSubscriber } from "./push-crypto-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

async function insertRawNoteAt(createdAt: string, body: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		"INSERT INTO raw_notes (id, body, created_at, private) VALUES (?, ?, ?, 0)",
	)
		.bind(id, body, createdAt)
		.run();
	return id;
}

/**
 * Inserts an organized note tied to `opts.rawNoteId`, and — since a real reorganization pass
 * always stamps `raw_notes.processed_at` together with writing `organized_notes` — marks that raw
 * note processed too. Skipping this would leave an inconsistent row (already organized, but still
 * "unprocessed") that a *different* test file's `runReorganization` sweep could pick up later and
 * crash on the `organized_notes.raw_note_id` UNIQUE constraint, since storage persists across the
 * whole test run.
 */
async function insertOrganizedNote(opts: {
	rawNoteId: string;
	type: string;
	summary: string;
	tags: string[];
}): Promise<string> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		`INSERT INTO organized_notes (id, raw_note_id, run_id, type, cleaned_text, summary, tags, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			opts.rawNoteId,
			crypto.randomUUID(),
			opts.type,
			opts.summary,
			opts.summary,
			JSON.stringify(opts.tags),
			"test-model",
		)
		.run();
	await env.ORLA_DB.prepare("UPDATE raw_notes SET processed_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), opts.rawNoteId)
		.run();
	return id;
}

async function insertActionItem(opts: {
	organizedNoteId: string;
	text: string;
	dueDate: string | null;
}): Promise<string> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		"INSERT INTO action_items (id, organized_note_id, text, due_date) VALUES (?, ?, ?, ?)",
	)
		.bind(id, opts.organizedNoteId, opts.text, opts.dueDate)
		.run();
	return id;
}

async function insertSubscription(subscriber: { p256dh: string; auth: string }): Promise<string> {
	const endpoint = `https://push.example.com/brief/${crypto.randomUUID()}`;
	await env.ORLA_DB.prepare(
		"INSERT INTO push_subscriptions (id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
	)
		.bind(crypto.randomUUID(), endpoint, subscriber.p256dh, subscriber.auth)
		.run();
	return endpoint;
}

describe("buildBriefInputs", () => {
	it("splits open action items into overdue-flagged today_items and undated_items", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const forDate = "2026-08-22";
		const rawId = await insertRawNoteAt(`${forDate}T09:00:00.000Z`, `note ${marker}`);
		const orgId = await insertOrganizedNote({
			rawNoteId: rawId,
			type: "task",
			summary: `summary ${marker}`,
			tags: [],
		});

		const overdueId = await insertActionItem({
			organizedNoteId: orgId,
			text: `overdue ${marker}`,
			dueDate: "2026-08-21",
		});
		const dueTodayId = await insertActionItem({
			organizedNoteId: orgId,
			text: `due today ${marker}`,
			dueDate: forDate,
		});
		const undatedId = await insertActionItem({
			organizedNoteId: orgId,
			text: `undated ${marker}`,
			dueDate: null,
		});

		const inputs = await buildBriefInputs(env.ORLA_DB, forDate);

		const overdue = inputs.today_items.find((i) => i.id === overdueId);
		expect(overdue).toMatchObject({
			text: `overdue ${marker}`,
			due_date: "2026-08-21",
			overdue: true,
		});

		const dueToday = inputs.today_items.find((i) => i.id === dueTodayId);
		expect(dueToday).toMatchObject({
			text: `due today ${marker}`,
			due_date: forDate,
			overdue: false,
		});

		const undated = inputs.undated_items.find((i) => i.id === undatedId);
		expect(undated).toMatchObject({ text: `undated ${marker}`, due_date: null, overdue: false });
	});

	it("includes only organized notes whose raw note was captured the day before forDate", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const forDate = "2026-08-22";

		const yesterdayRawId = await insertRawNoteAt("2026-08-21T08:00:00.000Z", `yesterday ${marker}`);
		const yesterdayOrgId = await insertOrganizedNote({
			rawNoteId: yesterdayRawId,
			type: "journal",
			summary: `yesterday summary ${marker}`,
			tags: ["marker-tag"],
		});

		const todayRawId = await insertRawNoteAt("2026-08-22T08:00:00.000Z", `today ${marker}`);
		const todayOrgId = await insertOrganizedNote({
			rawNoteId: todayRawId,
			type: "journal",
			summary: `today summary ${marker}`,
			tags: [],
		});

		const inputs = await buildBriefInputs(env.ORLA_DB, forDate);

		const yesterdayEntry = inputs.yesterday.find((n) => n.id === yesterdayOrgId);
		expect(yesterdayEntry).toMatchObject({
			type: "journal",
			summary: `yesterday summary ${marker}`,
			tags: ["marker-tag"],
		});
		expect(inputs.yesterday.some((n) => n.id === todayOrgId)).toBe(false);
	});

	it("reports pending_raw and reorg_health consistent with the underlying tables", async () => {
		const forDate = "2026-08-22";
		const before = await buildBriefInputs(env.ORLA_DB, forDate);

		const publicId = await insertRawNoteAt(new Date().toISOString(), "pending public note");
		await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body, private) VALUES (?, ?, 1)")
			.bind(crypto.randomUUID(), "pending private note")
			.run();

		const after = await buildBriefInputs(env.ORLA_DB, forDate);
		expect(after.pending_raw).toBe(before.pending_raw + 1);

		const expectedFailures = await consecutiveFailedRuns(env.ORLA_DB);
		expect(after.reorg_health.consecutive_failures).toBe(expectedFailures);

		await env.ORLA_DB.prepare("UPDATE raw_notes SET processed_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), publicId)
			.run();
	});
});

describe("renderBriefMarkdown", () => {
	it("renders every section with content and marks overdue items", () => {
		const inputs: BriefInputs = {
			for_date: "2026-08-22",
			today_items: [
				{ id: "1", text: "Overdue task", due_date: "2026-08-21", overdue: true },
				{ id: "2", text: "Due today task", due_date: "2026-08-22", overdue: false },
			],
			undated_items: [{ id: "3", text: "Someday task", due_date: null, overdue: false }],
			yesterday: [
				{ id: "4", type: "journal", summary: "Went for a run", tags: ["running", "morning"] },
			],
			reorg_health: { last_run: null, consecutive_failures: 0 },
			pending_raw: 0,
		};

		const md = renderBriefMarkdown(inputs, "Orla");

		expect(md).toContain("# Morning brief — 2026-08-22");
		expect(md).toContain("_Prepared by Orla._");
		expect(md).toContain("## Today");
		expect(md).toContain("- ⚠ Overdue task (due 2026-08-21)");
		expect(md).toContain("- Due today task (due 2026-08-22)");
		expect(md).toContain("## Also on your list");
		expect(md).toContain("- Someday task");
		expect(md).toContain("## Yesterday");
		expect(md).toContain("- journal · Went for a run · #running #morning");
		expect(md).not.toContain("## System");
	});

	it("shows empty-state lines when there is nothing to report", () => {
		const inputs: BriefInputs = {
			for_date: "2026-08-23",
			today_items: [],
			undated_items: [],
			yesterday: [],
			reorg_health: { last_run: null, consecutive_failures: 0 },
			pending_raw: 0,
		};

		const md = renderBriefMarkdown(inputs, "Orla");
		expect(md).toContain("Nothing due today.");
		expect(md).toContain("Nothing else on your list.");
		expect(md).toContain("No notes from yesterday.");
		expect(md).not.toContain("## System");
	});

	it("adds a System section when reorganization has failed or notes are pending", () => {
		const inputs: BriefInputs = {
			for_date: "2026-08-22",
			today_items: [],
			undated_items: [],
			yesterday: [],
			reorg_health: { last_run: null, consecutive_failures: 3 },
			pending_raw: 5,
		};

		const md = renderBriefMarkdown(inputs, "Orla");
		expect(md).toContain("## System");
		expect(md).toContain("failed 3 time(s) in a row");
		expect(md).toContain("5 note(s) are still waiting to be processed");
	});
});

describe("runMorningBrief", () => {
	it("stores the brief idempotently for the day and pushes counts matching buildBriefInputs", async () => {
		const now = new Date("2026-09-15T07:00:00.000Z");
		const forDate = "2026-09-15";

		const rawId = await insertRawNoteAt(now.toISOString(), "brief marker note");
		const orgId = await insertOrganizedNote({
			rawNoteId: rawId,
			type: "task",
			summary: "marker",
			tags: [],
		});
		await insertActionItem({ organizedNoteId: orgId, text: "marker due today", dueDate: forDate });

		const expectedInputs = await buildBriefInputs(env.ORLA_DB, forDate);
		const expectedTodayCount = expectedInputs.today_items.length;
		const expectedOverdueCount = expectedInputs.today_items.filter((item) => item.overdue).length;
		const expectAlert = expectedInputs.reorg_health.consecutive_failures >= 2;

		const vapidKeys = await generateVapidKeys();
		const subscriber = await generateTestSubscriber();
		const endpoint = await insertSubscription(subscriber);

		const captured: Uint8Array[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			captured.push(init?.body as Uint8Array);
			return new Response(null, { status: 201 });
		};

		const testEnv: Env = {
			...env,
			VAPID_PUBLIC_KEY: vapidKeys.publicKey,
			VAPID_PRIVATE_KEY: vapidKeys.privateKey,
		};

		const result = await runMorningBrief(testEnv, { now, fetchImpl });
		expect(result.forDate).toBe(forDate);
		expect(result.pushed).toBeGreaterThanOrEqual(1);
		expect(captured).toHaveLength(expectAlert ? 2 : 1);

		const payloads = await Promise.all(
			captured.map(async (body) => {
				const decrypted = await decryptPushBody(body.buffer as ArrayBuffer, subscriber);
				return JSON.parse(decrypted) as { title: string; body: string; url: string };
			}),
		);

		const briefMessage = payloads.find((p) => p.title === "Good morning");
		expect(briefMessage).toMatchObject({
			body: `${expectedTodayCount} due today, ${expectedOverdueCount} overdue`,
			url: "/#brief",
		});

		if (expectAlert) {
			const alertMessage = payloads.find((p) => p.title === "Orla needs attention");
			expect(alertMessage?.url).toBe("/#costs");
			expect(alertMessage?.body).toContain(
				`failed ${expectedInputs.reorg_health.consecutive_failures} times`,
			);
		}

		// Re-running the same day upserts the existing row rather than creating a new one.
		const noopFetch: typeof fetch = async () => new Response(null, { status: 201 });
		const result2 = await runMorningBrief(testEnv, { now, fetchImpl: noopFetch });
		expect(result2.briefId).toBe(result.briefId);

		const countRow = await env.ORLA_DB.prepare(
			"SELECT COUNT(*) AS n FROM briefs WHERE for_date = ?",
		)
			.bind(forDate)
			.first<{ n: number }>();
		expect(countRow?.n).toBe(1);

		const briefRow = await env.ORLA_DB.prepare(
			"SELECT body_md, pushed_at FROM briefs WHERE for_date = ?",
		)
			.bind(forDate)
			.first<{ body_md: string; pushed_at: string | null }>();
		expect(briefRow?.pushed_at).not.toBeNull();
		expect(briefRow?.body_md).toContain(`# Morning brief — ${forDate}`);

		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.run();
	});

	it("sends a second push warning once consecutive_failures reaches 2, regardless of pre-existing runs", async () => {
		const now = new Date("2026-09-16T07:00:00.000Z");

		// These two are dated after every other test's reorg_runs rows (real "now" in this suite
		// is far earlier), so they are guaranteed to be the most recent by started_at.
		await env.ORLA_DB.prepare(
			"INSERT INTO reorg_runs (id, status, started_at, finished_at) VALUES (?, 'failed', ?, ?)",
		)
			.bind(crypto.randomUUID(), "2026-09-16T06:58:00.000Z", "2026-09-16T06:58:01.000Z")
			.run();
		await env.ORLA_DB.prepare(
			"INSERT INTO reorg_runs (id, status, started_at, finished_at) VALUES (?, 'failed', ?, ?)",
		)
			.bind(crypto.randomUUID(), "2026-09-16T06:59:00.000Z", "2026-09-16T06:59:01.000Z")
			.run();

		const consecutiveFailures = await consecutiveFailedRuns(env.ORLA_DB);
		expect(consecutiveFailures).toBeGreaterThanOrEqual(2);

		const vapidKeys = await generateVapidKeys();
		const subscriber = await generateTestSubscriber();
		const endpoint = await insertSubscription(subscriber);

		const captured: Uint8Array[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			captured.push(init?.body as Uint8Array);
			return new Response(null, { status: 201 });
		};

		const testEnv: Env = {
			...env,
			VAPID_PUBLIC_KEY: vapidKeys.publicKey,
			VAPID_PRIVATE_KEY: vapidKeys.privateKey,
		};

		await runMorningBrief(testEnv, { now, fetchImpl });
		expect(captured).toHaveLength(2);

		const payloads = await Promise.all(
			captured.map(async (body) => {
				const decrypted = await decryptPushBody(body.buffer as ArrayBuffer, subscriber);
				return JSON.parse(decrypted) as { title: string; body: string; url: string };
			}),
		);

		const alert = payloads.find((p) => p.title === "Orla needs attention");
		expect(alert).toMatchObject({ url: "/#costs" });
		expect(alert?.body).toContain(`failed ${consecutiveFailures} times`);

		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.run();
	});

	it("skips push entirely when VAPID keys are not configured", async () => {
		const now = new Date("2026-09-17T07:00:00.000Z");
		const testEnv: Env = { ...env, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" };

		const result = await runMorningBrief(testEnv, { now });
		expect(result.pushed).toBe(0);
		expect(result.failed).toBe(0);

		const row = await env.ORLA_DB.prepare("SELECT pushed_at FROM briefs WHERE for_date = ?")
			.bind("2026-09-17")
			.first<{ pushed_at: string | null }>();
		expect(row?.pushed_at).toBeNull();
	});
});

describe("POST /api/brief/run and GET /api/brief", () => {
	it("runs synchronously, stores a brief for today, and GET returns it", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/brief/run",
			await withAccessHeader({ method: "POST" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			briefId: string;
			forDate: string;
			pushed: number;
			failed: number;
		};
		expect(typeof body.briefId).toBe("string");
		// The route's env has no VAPID keys configured in tests, so push is skipped.
		expect(body.pushed).toBe(0);

		const getRes = await SELF.fetch(
			`http://example.com/api/brief?date=${body.forDate}`,
			await withAccessHeader(),
		);
		expect(getRes.status).toBe(200);
		const { brief } = (await getRes.json()) as { brief: { for_date: string; body_md: string } };
		expect(brief.for_date).toBe(body.forDate);
		expect(brief.body_md).toContain("# Morning brief");
	});

	it("rejects unauthenticated requests to run the brief", async () => {
		const res = await SELF.fetch("http://example.com/api/brief/run", { method: "POST" });
		expect(res.status).toBe(401);
	});

	it("returns 404 for a date with no stored brief", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/brief?date=1999-01-01",
			await withAccessHeader(),
		);
		expect(res.status).toBe(404);
	});
});
