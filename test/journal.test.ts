/**
 * Tests for F7 journal API (src/journal.ts + src/routes/journal.ts). Storage persists across the
 * whole vitest run (see vitest.config.ts), so every insert here is tagged with a unique marker
 * (a UUID embedded in `cleaned_text`/`text`, or a marker-derived tag) and assertions filter down
 * to rows carrying that marker rather than assuming an empty table.
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import type { ActionItemStatus, ActionItemWithContext, JournalEntry } from "../src/journal";
import {
	handleActionItems,
	handleActionItemUpdate,
	handleExport,
	handleJournalList,
	handleJournalSearch,
} from "../src/routes/journal";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

type NoteType = "journal" | "meeting" | "task" | "idea" | "reference";

type InsertOrganizedOpts = {
	cleanedText: string;
	type?: NoteType;
	summary?: string;
	tags?: string[];
	capturedAt?: string; // raw_notes.created_at override
	organizedCreatedAt?: string; // organized_notes.created_at override
};

async function insertOrganizedNote(
	opts: InsertOrganizedOpts,
): Promise<{ rawNoteId: string; organizedId: string }> {
	const rawId = crypto.randomUUID();
	// Mark processed_at immediately: this raw note is about to get an organized_notes row, and a
	// raw note with an organized row is always processed — leaving it NULL would make a later
	// runReorganization() call (elsewhere in this shared-storage suite) pick it back up and try to
	// INSERT a second organized_notes row for the same raw_note_id, hitting the UNIQUE constraint.
	if (opts.capturedAt) {
		await env.ORLA_DB.prepare(
			"INSERT INTO raw_notes (id, body, created_at, processed_at) VALUES (?, ?, ?, ?)",
		)
			.bind(rawId, opts.cleanedText, opts.capturedAt, opts.capturedAt)
			.run();
	} else {
		const now = new Date().toISOString();
		await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body, processed_at) VALUES (?, ?, ?)")
			.bind(rawId, opts.cleanedText, now)
			.run();
	}

	const organizedId = crypto.randomUUID();
	const columns =
		"id, raw_note_id, run_id, type, cleaned_text, summary, tags, attendees, decisions, model" +
		(opts.organizedCreatedAt ? ", created_at" : "");
	const placeholders = opts.organizedCreatedAt
		? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
		: "?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
	const values: unknown[] = [
		organizedId,
		rawId,
		crypto.randomUUID(),
		opts.type ?? "journal",
		opts.cleanedText,
		opts.summary ?? "summary",
		JSON.stringify(opts.tags ?? []),
		JSON.stringify([]),
		JSON.stringify([]),
		"test-model",
	];
	if (opts.organizedCreatedAt) {
		values.push(opts.organizedCreatedAt);
	}

	await env.ORLA_DB.prepare(`INSERT INTO organized_notes (${columns}) VALUES (${placeholders})`)
		.bind(...values)
		.run();

	return { rawNoteId: rawId, organizedId };
}

async function insertActionItem(opts: {
	organizedNoteId: string;
	text: string;
	dueDate: string | null;
	status?: ActionItemStatus;
	createdAt?: string;
}): Promise<string> {
	const id = crypto.randomUUID();
	if (opts.createdAt) {
		await env.ORLA_DB.prepare(
			"INSERT INTO action_items (id, organized_note_id, text, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(
				id,
				opts.organizedNoteId,
				opts.text,
				opts.dueDate,
				opts.status ?? "open",
				opts.createdAt,
			)
			.run();
	} else {
		await env.ORLA_DB.prepare(
			"INSERT INTO action_items (id, organized_note_id, text, due_date, status) VALUES (?, ?, ?, ?, ?)",
		)
			.bind(id, opts.organizedNoteId, opts.text, opts.dueDate, opts.status ?? "open")
			.run();
	}
	return id;
}

function addDays(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00.000Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

describe("handleJournalList", () => {
	it("filters by day (the raw note's captured_at date)", async () => {
		const marker = crypto.randomUUID();
		await insertOrganizedNote({
			cleanedText: `day-match ${marker}`,
			capturedAt: "2024-01-15T10:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `day-other ${marker}`,
			capturedAt: "2024-01-16T10:00:00.000Z",
		});

		const res = await handleJournalList(new Request("http://x/api/journal?day=2024-01-15"), env);
		expect(res.status).toBe(200);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		const matched = entries.filter((e) => e.cleaned_text.includes(marker));
		expect(matched).toHaveLength(1);
		expect(matched[0]?.cleaned_text).toContain("day-match");
		expect(matched[0]?.captured_at.startsWith("2024-01-15")).toBe(true);
	});

	it("filters by from/to range on captured_at", async () => {
		const marker = crypto.randomUUID();
		await insertOrganizedNote({
			cleanedText: `range-before ${marker}`,
			capturedAt: "2024-02-01T00:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `range-in ${marker}`,
			capturedAt: "2024-02-05T00:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `range-after ${marker}`,
			capturedAt: "2024-02-10T00:00:00.000Z",
		});

		const res = await handleJournalList(
			new Request("http://x/api/journal?from=2024-02-02&to=2024-02-09"),
			env,
		);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		const matched = entries.filter((e) => e.cleaned_text.includes(marker));
		expect(matched).toHaveLength(1);
		expect(matched[0]?.cleaned_text).toContain("range-in");
	});

	it("filters by type", async () => {
		const marker = crypto.randomUUID();
		await insertOrganizedNote({ cleanedText: `type-task ${marker}`, type: "task" });
		await insertOrganizedNote({ cleanedText: `type-idea ${marker}`, type: "idea" });

		const res = await handleJournalList(new Request("http://x/api/journal?type=task"), env);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		const matched = entries.filter((e) => e.cleaned_text.includes(marker));
		expect(matched).toHaveLength(1);
		expect(matched[0]?.type).toBe("task");
	});

	it("filters by tag (JSON array membership)", async () => {
		const marker = crypto.randomUUID();
		const tag = `tag-${marker}`;
		await insertOrganizedNote({ cleanedText: `tag-match ${marker}`, tags: [tag, "other"] });
		await insertOrganizedNote({ cleanedText: `tag-miss ${marker}`, tags: ["other"] });

		const res = await handleJournalList(new Request(`http://x/api/journal?tag=${tag}`), env);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		const matched = entries.filter((e) => e.cleaned_text.includes(marker));
		expect(matched).toHaveLength(1);
		expect(matched[0]?.cleaned_text).toContain("tag-match");
	});

	it("filters by a before cursor on organized_notes.created_at", async () => {
		const marker = crypto.randomUUID();
		const tag = `before-${marker}`;
		await insertOrganizedNote({
			cleanedText: `before-earlier ${marker}`,
			tags: [tag],
			organizedCreatedAt: "2021-02-01T00:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `before-later ${marker}`,
			tags: [tag],
			organizedCreatedAt: "2021-02-02T00:00:00.000Z",
		});

		const res = await handleJournalList(
			new Request(`http://x/api/journal?tag=${tag}&before=2021-02-02T00:00:00.000Z`),
			env,
		);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		expect(entries).toHaveLength(1);
		expect(entries[0]?.cleaned_text).toContain("before-earlier");
	});

	it("caps the number of returned entries to the given limit, newest first", async () => {
		const marker = crypto.randomUUID();
		const tag = `limit-${marker}`;
		await insertOrganizedNote({
			cleanedText: `limit-1 ${marker}`,
			tags: [tag],
			organizedCreatedAt: "2021-03-01T00:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `limit-2 ${marker}`,
			tags: [tag],
			organizedCreatedAt: "2021-03-02T00:00:00.000Z",
		});
		await insertOrganizedNote({
			cleanedText: `limit-3 ${marker}`,
			tags: [tag],
			organizedCreatedAt: "2021-03-03T00:00:00.000Z",
		});

		const res = await handleJournalList(
			new Request(`http://x/api/journal?tag=${tag}&limit=2`),
			env,
		);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		expect(entries).toHaveLength(2);
		expect(entries[0]?.cleaned_text).toContain("limit-3");
		expect(entries[1]?.cleaned_text).toContain("limit-2");
	});

	it("rejects a limit above 200", async () => {
		const res = await handleJournalList(new Request("http://x/api/journal?limit=201"), env);
		expect(res.status).toBe(400);
	});

	it("accepts the boundary limit of 200", async () => {
		const res = await handleJournalList(new Request("http://x/api/journal?limit=200"), env);
		expect(res.status).toBe(200);
	});

	it("rejects a non-numeric limit", async () => {
		const res = await handleJournalList(new Request("http://x/api/journal?limit=abc"), env);
		expect(res.status).toBe(400);
	});

	it("includes action_items on an entry", async () => {
		const marker = crypto.randomUUID();
		const tag = `ai-${marker}`;
		const { organizedId } = await insertOrganizedNote({
			cleanedText: `has-action-items ${marker}`,
			tags: [tag],
		});
		await insertActionItem({ organizedNoteId: organizedId, text: `todo ${marker}`, dueDate: null });

		const res = await handleJournalList(new Request(`http://x/api/journal?tag=${tag}`), env);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		expect(entries).toHaveLength(1);
		expect(entries[0]?.action_items).toHaveLength(1);
		expect(entries[0]?.action_items[0]?.text).toBe(`todo ${marker}`);
	});
});

describe("handleJournalSearch", () => {
	it("rejects an empty or missing query", async () => {
		const missing = await handleJournalSearch(new Request("http://x/api/journal/search"), env);
		expect(missing.status).toBe(400);

		const empty = await handleJournalSearch(
			new Request("http://x/api/journal/search?q=%20%20"),
			env,
		);
		expect(empty.status).toBe(400);
	});

	it("finds entries by cleaned_text content", async () => {
		const marker = `mk${crypto.randomUUID().replace(/-/g, "")}`;
		await insertOrganizedNote({ cleanedText: `some note mentioning ${marker} in its body` });

		const res = await handleJournalSearch(
			new Request(`http://x/api/journal/search?q=${marker}`),
			env,
		);
		expect(res.status).toBe(200);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		expect(entries.some((e) => e.cleaned_text.includes(marker))).toBe(true);
	});

	it("finds entries by a tag term", async () => {
		const marker = `mk${crypto.randomUUID().replace(/-/g, "")}`;
		await insertOrganizedNote({
			cleanedText: "unrelated body with no marker here",
			tags: [marker],
		});

		const res = await handleJournalSearch(
			new Request(`http://x/api/journal/search?q=${marker}`),
			env,
		);
		expect(res.status).toBe(200);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		expect(entries.some((e) => e.tags.includes(marker))).toBe(true);
	});

	it("ranks a double-match above a single-match", async () => {
		const marker = `mk${crypto.randomUUID().replace(/-/g, "")}`;
		await insertOrganizedNote({ cleanedText: `single mention of ${marker} appears once here` });
		await insertOrganizedNote({
			cleanedText: `double mention of ${marker} appears here too`,
			summary: `also about ${marker}`,
		});

		const res = await handleJournalSearch(
			new Request(`http://x/api/journal/search?q=${marker}`),
			env,
		);
		const { entries } = (await res.json()) as { entries: JournalEntry[] };
		const matched = entries.filter((e) => e.cleaned_text.includes(marker));
		expect(matched).toHaveLength(2);
		// The double-match (term in both cleaned_text and summary) ranks first (lower/better bm25).
		expect(matched[0]?.summary).toContain(marker);
	});

	it("treats a query containing FTS operator syntax literally, without erroring", async () => {
		const res = await handleJournalSearch(
			new Request(`http://x/api/journal/search?q=${encodeURIComponent('foo OR "')}`),
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: JournalEntry[] };
		expect(Array.isArray(body.entries)).toBe(true);
	});

	it("rejects a limit above 100", async () => {
		const res = await handleJournalSearch(
			new Request("http://x/api/journal/search?q=test&limit=101"),
			env,
		);
		expect(res.status).toBe(400);
	});
});

describe("handleActionItems", () => {
	it("defaults to status=open and filters by status", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({ cleanedText: `status-parent ${marker}` });
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `open-item ${marker}`,
			dueDate: null,
			status: "open",
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `done-item ${marker}`,
			dueDate: null,
			status: "done",
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `dismissed-item ${marker}`,
			dueDate: null,
			status: "dismissed",
		});

		const defaultRes = await handleActionItems(new Request("http://x/api/action-items"), env);
		const { items: defaultItems } = (await defaultRes.json()) as { items: ActionItemWithContext[] };
		const defaultMatched = defaultItems.filter((i) => i.text.includes(marker));
		expect(defaultMatched).toHaveLength(1);
		expect(defaultMatched[0]?.status).toBe("open");

		const allRes = await handleActionItems(
			new Request("http://x/api/action-items?status=all"),
			env,
		);
		const { items: allItems } = (await allRes.json()) as { items: ActionItemWithContext[] };
		expect(allItems.filter((i) => i.text.includes(marker))).toHaveLength(3);

		const doneRes = await handleActionItems(
			new Request("http://x/api/action-items?status=done"),
			env,
		);
		const { items: doneItems } = (await doneRes.json()) as { items: ActionItemWithContext[] };
		const doneMatched = doneItems.filter((i) => i.text.includes(marker));
		expect(doneMatched).toHaveLength(1);
		expect(doneMatched[0]?.status).toBe("done");

		// carries the parent note's summary/captured_at as context
		expect(typeof doneMatched[0]?.summary).toBe("string");
		expect(typeof doneMatched[0]?.captured_at).toBe("string");
	});

	it("rejects an invalid status filter", async () => {
		const res = await handleActionItems(new Request("http://x/api/action-items?status=bogus"), env);
		expect(res.status).toBe(400);
	});

	it("rejects an invalid due filter", async () => {
		const res = await handleActionItems(new Request("http://x/api/action-items?due=bogus"), env);
		expect(res.status).toBe(400);
	});

	it("filters by due=today/overdue/week at the UTC boundaries", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({ cleanedText: `due-parent ${marker}` });

		const today = new Date().toISOString().slice(0, 10);
		const yesterday = addDays(today, -1);
		const inThreeDays = addDays(today, 3);
		const inSixDays = addDays(today, 6); // inside the 7-day (today..+6) week window
		const inSevenDays = addDays(today, 7); // just outside the week window

		await insertActionItem({
			organizedNoteId: organizedId,
			text: `today-item ${marker}`,
			dueDate: today,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `overdue-item ${marker}`,
			dueDate: yesterday,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `soon-item ${marker}`,
			dueDate: inThreeDays,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `edge-in-item ${marker}`,
			dueDate: inSixDays,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `edge-out-item ${marker}`,
			dueDate: inSevenDays,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `no-date-item ${marker}`,
			dueDate: null,
		});

		const todayRes = await handleActionItems(
			new Request("http://x/api/action-items?status=all&due=today"),
			env,
		);
		const { items: todayItems } = (await todayRes.json()) as { items: ActionItemWithContext[] };
		expect(todayItems.filter((i) => i.text.includes(marker)).map((i) => i.text)).toEqual([
			`today-item ${marker}`,
		]);

		const overdueRes = await handleActionItems(
			new Request("http://x/api/action-items?status=all&due=overdue"),
			env,
		);
		const { items: overdueItems } = (await overdueRes.json()) as {
			items: ActionItemWithContext[];
		};
		expect(overdueItems.filter((i) => i.text.includes(marker)).map((i) => i.text)).toEqual([
			`overdue-item ${marker}`,
		]);

		const weekRes = await handleActionItems(
			new Request("http://x/api/action-items?status=all&due=week"),
			env,
		);
		const { items: weekItems } = (await weekRes.json()) as { items: ActionItemWithContext[] };
		const weekMatched = weekItems.filter((i) => i.text.includes(marker)).map((i) => i.text);
		expect(weekMatched).toContain(`today-item ${marker}`);
		expect(weekMatched).toContain(`soon-item ${marker}`);
		expect(weekMatched).toContain(`edge-in-item ${marker}`);
		expect(weekMatched).not.toContain(`edge-out-item ${marker}`);
		expect(weekMatched).not.toContain(`overdue-item ${marker}`);
		expect(weekMatched).not.toContain(`no-date-item ${marker}`);
	});

	it("orders by due_date ascending with NULLs last, then by created_at", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({ cleanedText: `order-parent ${marker}` });
		const today = new Date().toISOString().slice(0, 10);
		const later = addDays(today, 5);

		await insertActionItem({
			organizedNoteId: organizedId,
			text: `null-first ${marker}`,
			dueDate: null,
			createdAt: "2020-01-01T00:00:00.000Z",
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `later-date ${marker}`,
			dueDate: later,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `earlier-date ${marker}`,
			dueDate: today,
		});
		await insertActionItem({
			organizedNoteId: organizedId,
			text: `null-second ${marker}`,
			dueDate: null,
			createdAt: "2020-01-02T00:00:00.000Z",
		});

		const res = await handleActionItems(
			new Request("http://x/api/action-items?status=all&due=all"),
			env,
		);
		const { items } = (await res.json()) as { items: ActionItemWithContext[] };
		const matched = items.filter((i) => i.text.includes(marker)).map((i) => i.text);
		expect(matched).toEqual([
			`earlier-date ${marker}`,
			`later-date ${marker}`,
			`null-first ${marker}`,
			`null-second ${marker}`,
		]);
	});
});

describe("handleActionItemUpdate", () => {
	it("updates status and returns the updated item", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({ cleanedText: `patch-parent ${marker}` });
		const itemId = await insertActionItem({
			organizedNoteId: organizedId,
			text: `patch-item ${marker}`,
			dueDate: null,
		});

		const res = await handleActionItemUpdate(
			new Request("http://x/api/action-items/x", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "done" }),
			}),
			env,
			itemId,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string };
		expect(body.id).toBe(itemId);
		expect(body.status).toBe("done");
	});

	it("returns 404 for an unknown id", async () => {
		const res = await handleActionItemUpdate(
			new Request("http://x/api/action-items/x", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "done" }),
			}),
			env,
			crypto.randomUUID(),
		);
		expect(res.status).toBe(404);
	});

	it("returns 400 for an invalid status value", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({
			cleanedText: `bad-status-parent ${marker}`,
		});
		const itemId = await insertActionItem({
			organizedNoteId: organizedId,
			text: `bad-status-item ${marker}`,
			dueDate: null,
		});

		const res = await handleActionItemUpdate(
			new Request("http://x/api/action-items/x", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "bogus" }),
			}),
			env,
			itemId,
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a missing status field", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({
			cleanedText: `missing-status-parent ${marker}`,
		});
		const itemId = await insertActionItem({
			organizedNoteId: organizedId,
			text: `missing-status-item ${marker}`,
			dueDate: null,
		});

		const res = await handleActionItemUpdate(
			new Request("http://x/api/action-items/x", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
			env,
			itemId,
		);
		expect(res.status).toBe(400);
	});
});

describe("handleExport", () => {
	it("includes a private raw note and sets the Content-Disposition header", async () => {
		const marker = crypto.randomUUID();
		const rawId = crypto.randomUUID();
		await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body, private) VALUES (?, ?, 1)")
			.bind(rawId, `private export note ${marker}`)
			.run();

		const res = await handleExport(env);
		expect(res.status).toBe(200);

		const disposition = res.headers.get("content-disposition");
		expect(disposition).toContain("attachment");
		expect(disposition).toMatch(/filename="orla-export-\d{4}-\d{2}-\d{2}\.json"/);

		const body = (await res.json()) as {
			exported_at: string;
			raw_notes: { id: string; body: string }[];
		};
		expect(typeof body.exported_at).toBe("string");
		const found = body.raw_notes.find((n) => n.id === rawId);
		expect(found).toBeDefined();
		expect(found?.body).toBe(`private export note ${marker}`);
	});
});

// The following hit the router in src/index.ts, which is owned by a concurrently-running agent
// wiring these exact handlers (see task contract). Until that wiring lands these are expected to
// 404 — see the final report for which of these were failing at the time this file was written.
describe("routing (owned by a concurrent src/index.ts change)", () => {
	it("GET /api/journal is routed with a valid Access JWT", async () => {
		const res = await SELF.fetch("http://example.com/api/journal", await withAccessHeader());
		expect(res.status).toBe(200);
	});

	it("GET /api/journal/search is routed with a valid Access JWT", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/journal/search?q=test",
			await withAccessHeader(),
		);
		expect(res.status).toBe(200);
	});

	it("GET /api/action-items is routed with a valid Access JWT", async () => {
		const res = await SELF.fetch("http://example.com/api/action-items", await withAccessHeader());
		expect(res.status).toBe(200);
	});

	it("PATCH /api/action-items/:id is routed with a valid Access JWT", async () => {
		const marker = crypto.randomUUID();
		const { organizedId } = await insertOrganizedNote({ cleanedText: `wiring-parent ${marker}` });
		const itemId = await insertActionItem({
			organizedNoteId: organizedId,
			text: `wiring-item ${marker}`,
			dueDate: null,
		});

		const res = await SELF.fetch(
			`http://example.com/api/action-items/${itemId}`,
			await withAccessHeader({
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "done" }),
			}),
		);
		expect(res.status).toBe(200);
	});

	it("GET /api/export is routed with a valid Access JWT", async () => {
		const res = await SELF.fetch("http://example.com/api/export", await withAccessHeader());
		expect(res.status).toBe(200);
	});
});
