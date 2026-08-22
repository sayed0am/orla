import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import {
	consecutiveFailedRuns,
	REORG_SYSTEM_PROMPT,
	runReorganization,
	setReorgFetchForTests,
	validateOutput,
} from "../src/reorganize";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setReorgFetchForTests(undefined);
});

type CapturedRequest = { url: string; body: Record<string, unknown> };

type RawNoteRow = {
	id: string;
	body: string;
	created_at: string;
	private: number;
	processed_at: string | null;
};

async function insertRawNote(opts: { body: string; private?: boolean }): Promise<RawNoteRow> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body, private) VALUES (?, ?, ?)")
		.bind(id, opts.body, opts.private ? 1 : 0)
		.run();
	const row = await env.ORLA_DB.prepare(
		"SELECT id, body, created_at, private, processed_at FROM raw_notes WHERE id = ?",
	)
		.bind(id)
		.first<RawNoteRow>();
	if (!row) throw new Error("insertRawNote: row missing after insert");
	return row;
}

/** Builds a fake `fetch` answering `completeJson`'s non-streaming shape (see test/llm.test.ts). */
function fakeCompleteJsonFetch(
	makeContent: (body: Record<string, unknown>) => unknown,
	opts?: { status?: number },
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const status = opts?.status ?? 200;

	const fetchImpl: typeof fetch = async (input, init) => {
		const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
		captured.push({ url: String(input), body });

		if (status !== 200) {
			return new Response("upstream failure", { status });
		}

		const content = makeContent(body);
		const payload = {
			choices: [{ message: { content: JSON.stringify(content) } }],
			usage: {
				prompt_tokens: 50,
				completion_tokens: 20,
				prompt_tokens_details: { cached_tokens: 40 },
				cost: 0.0003,
			},
		};
		return new Response(JSON.stringify(payload), { status: 200 });
	};

	return { fetchImpl, captured };
}

function extractInputIds(body: Record<string, unknown>): string[] {
	const messages = body.messages as Array<{ role: string; content: unknown }>;
	const userMessage = messages.find((m) => m.role === "user");
	const parsed = JSON.parse(userMessage?.content as string) as {
		notes: { id: string; body: string; captured_at: string }[];
	};
	return parsed.notes.map((n) => n.id);
}

describe("validateOutput", () => {
	it("accepts a well-formed happy-path note", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "journal",
						cleaned_text: "Went for a run this morning.",
						summary: "Morning run.",
						tags: ["running", "morning"],
						action_items: [],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(bad).toHaveLength(0);
		expect(ok).toHaveLength(1);
		expect(ok[0]).toEqual({
			id: "a",
			type: "journal",
			cleaned_text: "Went for a run this morning.",
			summary: "Morning run.",
			tags: ["running", "morning"],
			action_items: [],
			attendees: [],
			decisions: [],
		});
	});

	it("quarantines an entry with an invalid type enum", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "not-a-type",
						cleaned_text: "text",
						summary: "s",
						tags: [],
						action_items: [],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(ok).toHaveLength(0);
		expect(bad).toHaveLength(1);
		expect(bad[0]?.id).toBe("a");
		expect(bad[0]?.reason).toContain("invalid type");
	});

	it("quarantines a missing id with reason 'missing from model output'", () => {
		const { ok, bad } = validateOutput({ notes: [] }, ["a", "b"]);
		expect(ok).toHaveLength(0);
		expect(bad).toHaveLength(2);
		for (const entry of bad) {
			expect(entry.reason).toBe("missing from model output");
		}
		expect(bad.map((b) => b.id).sort()).toEqual(["a", "b"]);
	});

	it("quarantines an id not present in the input batch", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "unknown-id",
						type: "journal",
						cleaned_text: "text",
						summary: "s",
						tags: [],
						action_items: [],
						attendees: [],
						decisions: [],
					},
					{ id: "a", type: "journal", cleaned_text: "t", summary: "s", tags: [] },
				],
			},
			["a"],
		);
		expect(ok).toHaveLength(1);
		expect(bad).toHaveLength(1);
		expect(bad[0]).toMatchObject({ id: "unknown-id", reason: "unknown id not in input batch" });
	});

	it("lowercases and deduplicates tags", () => {
		const { ok } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "idea",
						cleaned_text: "t",
						summary: "s",
						tags: ["Foo", "foo", " Bar ", "bar"],
						action_items: [],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(ok[0]?.tags).toEqual(["foo", "bar"]);
	});

	it("enforces due_date format, rejecting a malformed date", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "task",
						cleaned_text: "t",
						summary: "s",
						tags: [],
						action_items: [{ text: "do the thing", due_date: "next tuesday" }],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(ok).toHaveLength(0);
		expect(bad[0]?.reason).toContain("due_date");
	});

	it("accepts a null due_date and a valid YYYY-MM-DD due_date", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "task",
						cleaned_text: "t",
						summary: "s",
						tags: [],
						action_items: [
							{ text: "no date", due_date: null },
							{ text: "dated", due_date: "2026-09-01" },
						],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(bad).toHaveLength(0);
		expect(ok[0]?.action_items).toEqual([
			{ text: "no date", due_date: null },
			{ text: "dated", due_date: "2026-09-01" },
		]);
	});

	it("truncates a summary longer than 140 characters", () => {
		const longSummary = "x".repeat(200);
		const { ok } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "reference",
						cleaned_text: "t",
						summary: longSummary,
						tags: [],
						action_items: [],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(ok[0]?.summary).toHaveLength(140);
		expect(ok[0]?.summary).toBe("x".repeat(140));
	});

	it("keeps only the first occurrence of a duplicate id", () => {
		const { ok, bad } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "journal",
						cleaned_text: "first",
						summary: "s1",
						tags: [],
						action_items: [],
						attendees: [],
						decisions: [],
					},
					{
						id: "a",
						type: "journal",
						cleaned_text: "second",
						summary: "s2",
						tags: [],
						action_items: [],
						attendees: [],
						decisions: [],
					},
				],
			},
			["a"],
		);
		expect(ok).toHaveLength(1);
		expect(bad).toHaveLength(0);
		expect(ok[0]?.cleaned_text).toBe("first");
	});

	it("clears attendees/decisions for non-meeting types even if the model supplied them", () => {
		const { ok } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "journal",
						cleaned_text: "t",
						summary: "s",
						tags: [],
						action_items: [],
						attendees: ["should be dropped"],
						decisions: ["should be dropped"],
					},
				],
			},
			["a"],
		);
		expect(ok[0]?.attendees).toEqual([]);
		expect(ok[0]?.decisions).toEqual([]);
	});

	it("keeps attendees/decisions for a meeting type", () => {
		const { ok } = validateOutput(
			{
				notes: [
					{
						id: "a",
						type: "meeting",
						cleaned_text: "t",
						summary: "s",
						tags: [],
						action_items: [],
						attendees: ["Alice", "Bob"],
						decisions: ["Ship it"],
					},
				],
			},
			["a"],
		);
		expect(ok[0]?.attendees).toEqual(["Alice", "Bob"]);
		expect(ok[0]?.decisions).toEqual(["Ship it"]);
	});
});

describe("runReorganization", () => {
	it("organizes well-formed notes, sets processed_at, logs the reorganize call with the batch model and a cached system prompt first", async () => {
		const noteA = await insertRawNote({ body: "buy milk and eggs" });
		const noteB = await insertRawNote({ body: "call mom tomorrow" });

		const { fetchImpl, captured } = fakeCompleteJsonFetch((body) => {
			const ids = extractInputIds(body);
			return {
				notes: ids.map((id) => ({
					id,
					type: "task",
					cleaned_text: id === noteA.id ? "Buy milk and eggs." : "Call mom tomorrow.",
					summary: id === noteA.id ? "Buy milk and eggs." : "Call mom tomorrow.",
					tags: ["errand"],
					action_items: id === noteB.id ? [{ text: "call mom", due_date: null }] : [],
					attendees: [],
					decisions: [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		const result = await runReorganization(env, { batchSize: 25 });

		expect(result.status).toBe("ok");
		expect(result.notesOk).toBeGreaterThanOrEqual(2);
		expect(result.notesFailed).toBe(0);

		// Other test files share this D1 instance (see vitest.config.ts), so unprocessed notes
		// left over from earlier files may ride along in the same batch(es) — assert on the first
		// captured request's shape rather than an exact batch count.
		expect(captured.length).toBeGreaterThanOrEqual(1);
		const firstMessage = captured[0]?.body.messages as Array<{
			role: string;
			content: unknown;
		}>;
		expect(firstMessage[0]).toMatchObject({
			role: "system",
			content: [{ type: "text", text: REORG_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
		});
		expect(captured[0]?.body.model).toBe(env.LLM_MODEL_BATCH);
		expect(captured[0]?.body.session_id).toBe(result.runId);

		const orgA = await env.ORLA_DB.prepare(
			"SELECT type, cleaned_text, summary, tags, model, run_id FROM organized_notes WHERE raw_note_id = ?",
		)
			.bind(noteA.id)
			.first<{
				type: string;
				cleaned_text: string;
				summary: string;
				tags: string;
				model: string;
				run_id: string;
			}>();
		expect(orgA).toMatchObject({
			type: "task",
			cleaned_text: "Buy milk and eggs.",
			summary: "Buy milk and eggs.",
			model: env.LLM_MODEL_BATCH,
			run_id: result.runId,
		});
		expect(JSON.parse(orgA?.tags ?? "[]")).toEqual(["errand"]);

		const orgB = await env.ORLA_DB.prepare("SELECT id FROM organized_notes WHERE raw_note_id = ?")
			.bind(noteB.id)
			.first<{ id: string }>();
		expect(orgB).not.toBeNull();

		const actionItem = await env.ORLA_DB.prepare(
			"SELECT text, due_date, status FROM action_items WHERE organized_note_id = ?",
		)
			.bind(orgB?.id)
			.first<{ text: string; due_date: string | null; status: string }>();
		expect(actionItem).toMatchObject({ text: "call mom", due_date: null, status: "open" });

		const rawA = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(noteA.id)
			.first<{ processed_at: string | null }>();
		expect(rawA?.processed_at).not.toBeNull();

		const llmCall = await env.ORLA_DB.prepare(
			"SELECT job_type, model FROM llm_calls WHERE job_type = 'reorganize' AND model = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind(env.LLM_MODEL_BATCH)
			.first<{ job_type: string; model: string }>();
		expect(llmCall).toMatchObject({ job_type: "reorganize" });

		const runRow = await env.ORLA_DB.prepare("SELECT status FROM reorg_runs WHERE id = ?")
			.bind(result.runId)
			.first<{ status: string }>();
		expect(runRow?.status).toBe("ok");
	});

	it("marks a private note processed without sending it to the LLM or including it in the request", async () => {
		const privateNote = await insertRawNote({ body: "secret diary entry", private: true });
		const publicNote = await insertRawNote({ body: "public note" });

		const { fetchImpl, captured } = fakeCompleteJsonFetch((body) => {
			const ids = extractInputIds(body);
			return {
				notes: ids.map((id) => ({
					id,
					type: "journal",
					cleaned_text: "cleaned",
					summary: "summary",
					tags: [],
					action_items: [],
					attendees: [],
					decisions: [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		const result = await runReorganization(env, { batchSize: 25 });
		expect(result.status).toBe("ok");

		const allIds = captured.flatMap((c) => extractInputIds(c.body));
		expect(allIds).not.toContain(privateNote.id);
		expect(allIds).toContain(publicNote.id);

		const privateRow = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(privateNote.id)
			.first<{ processed_at: string | null }>();
		expect(privateRow?.processed_at).not.toBeNull();

		const organized = await env.ORLA_DB.prepare(
			"SELECT id FROM organized_notes WHERE raw_note_id = ?",
		)
			.bind(privateNote.id)
			.first();
		expect(organized).toBeNull();
	});

	it("quarantines a note the model returns garbage for while organizing its sibling; run is partial", async () => {
		const goodNote = await insertRawNote({ body: "good note" });
		const badNote = await insertRawNote({ body: "bad note" });

		const { fetchImpl } = fakeCompleteJsonFetch((body) => {
			const ids = extractInputIds(body);
			return {
				notes: ids.map((id) =>
					id === goodNote.id
						? {
								id,
								type: "journal",
								cleaned_text: "cleaned good note",
								summary: "good",
								tags: [],
								action_items: [],
								attendees: [],
								decisions: [],
							}
						: {
								id,
								type: "not-a-real-type",
								cleaned_text: "cleaned bad note",
								summary: "bad",
								tags: [],
								action_items: [],
								attendees: [],
								decisions: [],
							},
				),
			};
		});
		setReorgFetchForTests(fetchImpl);

		const result = await runReorganization(env, { batchSize: 25 });
		expect(result.status).toBe("partial");
		expect(result.notesFailed).toBeGreaterThanOrEqual(1);

		const goodRow = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(goodNote.id)
			.first<{ processed_at: string | null }>();
		expect(goodRow?.processed_at).not.toBeNull();

		const badRow = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(badNote.id)
			.first<{ processed_at: string | null }>();
		expect(badRow?.processed_at).toBeNull();

		const quarantine = await env.ORLA_DB.prepare(
			"SELECT reason FROM reorg_quarantine WHERE raw_note_id = ? AND run_id = ?",
		)
			.bind(badNote.id, result.runId)
			.first<{ reason: string }>();
		expect(quarantine?.reason).toContain("invalid type");
	});

	it("quarantines every note in a batch on an upstream 500 and the run fails without throwing", async () => {
		const noteA = await insertRawNote({ body: "note a" });
		const noteB = await insertRawNote({ body: "note b" });

		const { fetchImpl } = fakeCompleteJsonFetch(() => ({ notes: [] }), { status: 500 });
		setReorgFetchForTests(fetchImpl);

		const result = await runReorganization(env, { batchSize: 25 });
		expect(result.status).toBe("failed");
		expect(result.notesOk).toBe(0);
		expect(result.notesFailed).toBeGreaterThanOrEqual(2);

		for (const note of [noteA, noteB]) {
			const row = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
				.bind(note.id)
				.first<{ processed_at: string | null }>();
			expect(row?.processed_at).toBeNull();

			const quarantine = await env.ORLA_DB.prepare(
				"SELECT reason FROM reorg_quarantine WHERE raw_note_id = ? AND run_id = ?",
			)
				.bind(note.id, result.runId)
				.first<{ reason: string }>();
			expect(quarantine?.reason).toContain("llm error");
		}

		const runRow = await env.ORLA_DB.prepare(
			"SELECT status, finished_at FROM reorg_runs WHERE id = ?",
		)
			.bind(result.runId)
			.first<{ status: string; finished_at: string | null }>();
		expect(runRow?.status).toBe("failed");
		expect(runRow?.finished_at).not.toBeNull();
	});

	it("gives up on a poison note after 3 prior quarantine attempts, marking it processed on the 4th", async () => {
		const poisonNote = await insertRawNote({ body: "poison note" });

		for (let i = 0; i < 3; i++) {
			await env.ORLA_DB.prepare(
				"INSERT INTO reorg_quarantine (id, run_id, raw_note_id, reason) VALUES (?, ?, ?, ?)",
			)
				.bind(crypto.randomUUID(), crypto.randomUUID(), poisonNote.id, "invalid type: bogus")
				.run();
		}

		const { fetchImpl } = fakeCompleteJsonFetch((body) => {
			const ids = extractInputIds(body);
			return {
				notes: ids.map((id) => ({
					id,
					type: "still-bogus",
					cleaned_text: "t",
					summary: "s",
					tags: [],
					action_items: [],
					attendees: [],
					decisions: [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		const result = await runReorganization(env, { batchSize: 25 });
		// notesOk is 0 for this run (every note on the wire this run is invalid, including any
		// leftover unprocessed notes from earlier tests), so per the ok/partial/failed rule this
		// lands on "failed" rather than "partial" — see runReorganization's status derivation.
		expect(result.status).toBe("failed");

		const row = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(poisonNote.id)
			.first<{ processed_at: string | null }>();
		expect(row?.processed_at).not.toBeNull();

		const giveUp = await env.ORLA_DB.prepare(
			"SELECT reason FROM reorg_quarantine WHERE raw_note_id = ? AND run_id = ?",
		)
			.bind(poisonNote.id, result.runId)
			.first<{ reason: string }>();
		expect(giveUp?.reason).toBe("gave up after 3 attempts");

		const totalQuarantineRows = await env.ORLA_DB.prepare(
			"SELECT COUNT(*) AS n FROM reorg_quarantine WHERE raw_note_id = ?",
		)
			.bind(poisonNote.id)
			.first<{ n: number }>();
		expect(totalQuarantineRows?.n).toBe(4);
	});
});

describe("POST /api/reorganize/run", () => {
	it("runs synchronously and returns 200 with the run result", async () => {
		await insertRawNote({ body: "route wiring test note" });

		const { fetchImpl } = fakeCompleteJsonFetch((body) => {
			const ids = extractInputIds(body);
			return {
				notes: ids.map((id) => ({
					id,
					type: "journal",
					cleaned_text: "cleaned",
					summary: "summary",
					tags: [],
					action_items: [],
					attendees: [],
					decisions: [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		const res = await SELF.fetch(
			"http://example.com/api/reorganize/run",
			await withAccessHeader({ method: "POST" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { runId: string; status: string };
		expect(typeof body.runId).toBe("string");
		expect(["ok", "partial", "failed"]).toContain(body.status);

		const listRes = await SELF.fetch(
			"http://example.com/api/reorganize/runs",
			await withAccessHeader(),
		);
		expect(listRes.status).toBe(200);
		const { runs } = (await listRes.json()) as { runs: { id: string }[] };
		expect(runs.some((r) => r.id === body.runId)).toBe(true);
	});

	it("rejects unauthenticated requests", async () => {
		const res = await SELF.fetch("http://example.com/api/reorganize/run", { method: "POST" });
		expect(res.status).toBe(401);
	});
});

describe("GET /api/reorganize/runs", () => {
	it("rejects a non-numeric limit", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/reorganize/runs?limit=abc",
			await withAccessHeader(),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});
});

describe("consecutiveFailedRuns", () => {
	it("counts failed runs since the most recent non-failed run", async () => {
		const okId = crypto.randomUUID();
		await env.ORLA_DB.prepare(
			"INSERT INTO reorg_runs (id, status, finished_at) VALUES (?, 'ok', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
		)
			.bind(okId)
			.run();

		const before = await consecutiveFailedRuns(env.ORLA_DB);

		const failId1 = crypto.randomUUID();
		await env.ORLA_DB.prepare(
			"INSERT INTO reorg_runs (id, status, finished_at) VALUES (?, 'failed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
		)
			.bind(failId1)
			.run();
		const failId2 = crypto.randomUUID();
		await env.ORLA_DB.prepare(
			"INSERT INTO reorg_runs (id, status, finished_at) VALUES (?, 'failed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
		)
			.bind(failId2)
			.run();

		const after = await consecutiveFailedRuns(env.ORLA_DB);
		expect(after).toBe(before + 2);
	});
});
