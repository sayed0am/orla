/**
 * Tests for Memory Option A (PRD §8): `src/memory.ts`, `src/routes/memory.ts`, the reorganize
 * proposal path (`src/reorganize.ts`), and the chat prefix wiring (`src/routes/conversations.ts`).
 * Storage persists across the whole vitest run (see vitest.config.ts) — every fact this file
 * creates is recorded in `createdFactIds` and hard-deleted in `afterAll`, since a leftover
 * `active` fact would otherwise change the memory block another test file's chat tests see.
 */

import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { setLlmFetchForTests } from "../src/conversation";
import { getMemoryBlock, renderMemoryBlock } from "../src/memory";
import { REORG_SYSTEM_PROMPT, runReorganization, setReorgFetchForTests } from "../src/reorganize";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setLlmFetchForTests(undefined);
	setReorgFetchForTests(undefined);
});

type MemoryFactRecord = {
	id: string;
	text: string;
	status: "proposed" | "active" | "archived";
	source: "user" | "reorganize";
	source_note_id: string | null;
	created_at: string;
	updated_at: string;
};

type ConversationRecord = { id: string; title: string; created_at: string; updated_at: string };
type CapturedRequest = { url: string; body: Record<string, unknown> };

// Every fact id created (directly or through routes) below — deleted in `afterAll` so none of
// them linger and change the memory block another test file's chat tests would see.
const createdFactIds: string[] = [];

afterAll(async () => {
	for (const id of createdFactIds) {
		await env.ORLA_DB.prepare("DELETE FROM memory_facts WHERE id = ?").bind(id).run();
	}
});

async function apiCreateFact(text: string): Promise<MemoryFactRecord> {
	const res = await SELF.fetch(
		"http://example.com/api/memory",
		await withAccessHeader({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		}),
	);
	expect(res.status).toBe(201);
	const fact = (await res.json()) as MemoryFactRecord;
	createdFactIds.push(fact.id);
	return fact;
}

async function apiPatchFact(id: string, patch: Record<string, unknown>): Promise<Response> {
	return SELF.fetch(
		`http://example.com/api/memory/${id}`,
		await withAccessHeader({
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		}),
	);
}

async function apiDeleteFact(id: string): Promise<Response> {
	return SELF.fetch(
		`http://example.com/api/memory/${id}`,
		await withAccessHeader({ method: "DELETE" }),
	);
}

async function apiListFacts(status?: string): Promise<{ facts: MemoryFactRecord[] }> {
	const qs = status ? `?status=${status}` : "";
	const res = await SELF.fetch(`http://example.com/api/memory${qs}`, await withAccessHeader());
	expect(res.status).toBe(200);
	return res.json();
}

async function apiPreview(): Promise<{ block: string; chars: number }> {
	const res = await SELF.fetch("http://example.com/api/memory/preview", await withAccessHeader());
	expect(res.status).toBe(200);
	return res.json();
}

async function createConversation(): Promise<ConversationRecord> {
	const res = await SELF.fetch(
		"http://example.com/api/conversations",
		await withAccessHeader({ method: "POST" }),
	);
	expect(res.status).toBe(201);
	return res.json();
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

/** A minimal fake `fetch` for OpenRouter's `/chat/completions` SSE shape (see test/conversation.test.ts). */
function fakeReplyFetch(replyText: string): {
	fetchImpl: typeof fetch;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];

	const fetchImpl: typeof fetch = async (input, init) => {
		const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
		captured.push({ url: String(input), body });

		const encoder = new TextEncoder();
		const lines: string[] = [];
		if (replyText.length > 0) {
			lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`);
		}
		lines.push(
			`data: ${JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					cost: 0.0001,
				},
			})}\n\n`,
		);
		lines.push("data: [DONE]\n\n");

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of lines) {
					controller.enqueue(encoder.encode(line));
				}
				controller.close();
			},
		});
		return new Response(stream, { status: 200 });
	};

	return { fetchImpl, captured };
}

/** A minimal fake `fetch` for `completeJson`'s non-streaming shape (see test/reorganize.test.ts). */
function fakeCompleteJsonFetch(makeContent: (body: Record<string, unknown>) => unknown): {
	fetchImpl: typeof fetch;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];

	const fetchImpl: typeof fetch = async (input, init) => {
		const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
		captured.push({ url: String(input), body });

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

async function insertRawNote(body: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare("INSERT INTO raw_notes (id, body) VALUES (?, ?)").bind(id, body).run();
	return id;
}

describe("renderMemoryBlock", () => {
	it("returns an empty string for no facts", () => {
		expect(renderMemoryBlock([])).toBe("");
	});

	it("renders facts as a header plus one bullet per fact, in the given order", () => {
		const block = renderMemoryBlock([{ text: "Likes tea" }, { text: "Works remotely" }]);
		expect(block).toBe(
			"Facts the user has confirmed about themselves (treat as reliable background, do not " +
				"repeat back unprompted):\n- Likes tea\n- Works remotely",
		);
	});

	it("caps the rendered block at 1500 characters and appends an omission marker", () => {
		const facts = Array.from({ length: 15 }, (_, i) => ({
			text: `fact number ${i} `.padEnd(190, "x"),
		}));
		const block = renderMemoryBlock(facts);

		expect(block.endsWith("- (more facts omitted)")).toBe(true);
		// Not every fact fit — the marker means at least one was dropped.
		expect(block).not.toContain("fact number 14");
		// The cap is enforced before the marker is appended, so the total stays bounded.
		expect(block.length).toBeLessThan(1500 + "- (more facts omitted)".length + 2);
	});
});

describe("chat prefix: memoryBlock wiring (src/routes/conversations.ts)", () => {
	it("sends no memory system message when there are no active facts", async () => {
		const conv = await createConversation();
		const { fetchImpl, captured } = fakeReplyFetch("ok");
		setLlmFetchForTests(fetchImpl);

		const res = await postMessage(conv.id, "hello, any facts about me?");
		await res.text();

		expect(captured).toHaveLength(1);
		const messages = captured[0]?.body.messages as Array<{ role: string; content: unknown }>;
		expect(messages).toHaveLength(2); // static system prompt + the new user turn only
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]?.role).toBe("user");
	});

	it("puts the active-facts block as the second cached system message once one fact is active", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`Marker fact ${marker}`);

		const conv = await createConversation();
		const { fetchImpl, captured } = fakeReplyFetch("ok");
		setLlmFetchForTests(fetchImpl);

		const res = await postMessage(conv.id, "hello");
		await res.text();

		expect(captured).toHaveLength(1);
		type Part = { type: string; text: string; cache_control?: { type: string } };
		const messages = captured[0]?.body.messages as Array<{
			role: string;
			content: Part[] | string;
		}>;

		expect(messages).toHaveLength(3); // system prompt, memory block, user turn
		const memoryMessage = messages[1];
		expect(memoryMessage?.role).toBe("system");
		expect(Array.isArray(memoryMessage?.content)).toBe(true);
		const content = (memoryMessage?.content ?? []) as Part[];
		const part = content[0];
		expect(part?.cache_control).toEqual({ type: "ephemeral" });
		expect(part?.text.startsWith("Facts the user has confirmed about themselves")).toBe(true);
		expect(part?.text).toContain(fact.text);
	});
});

describe("Memory CRUD routes (src/routes/memory.ts)", () => {
	it("POST /api/memory creates an active, user-sourced fact and validates length", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`  User typed fact ${marker}  `);

		expect(fact.text).toBe(`User typed fact ${marker}`); // trimmed
		expect(fact.status).toBe("active");
		expect(fact.source).toBe("user");
		expect(fact.source_note_id).toBeNull();

		const tooLongRes = await SELF.fetch(
			"http://example.com/api/memory",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "x".repeat(201) }),
			}),
		);
		expect(tooLongRes.status).toBe(400);
		expect(await tooLongRes.json()).toHaveProperty("error");

		const emptyRes = await SELF.fetch(
			"http://example.com/api/memory",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "   " }),
			}),
		);
		expect(emptyRes.status).toBe(400);
	});

	it("GET /api/memory filters by status and rejects an unknown status", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`Listable fact ${marker}`);

		const { facts: activeFacts } = await apiListFacts("active");
		expect(activeFacts.some((f) => f.id === fact.id)).toBe(true);

		const { facts: proposedFacts } = await apiListFacts("proposed");
		expect(proposedFacts.some((f) => f.id === fact.id)).toBe(false);

		const badRes = await SELF.fetch(
			"http://example.com/api/memory?status=bogus",
			await withAccessHeader(),
		);
		expect(badRes.status).toBe(400);
	});

	it("PATCH /api/memory/:id edits text and status, 404s an unknown id, 400s a bad status", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`Patchable fact ${marker}`);

		const editRes = await apiPatchFact(fact.id, { text: `Edited fact ${marker}` });
		expect(editRes.status).toBe(200);
		const edited = (await editRes.json()) as MemoryFactRecord;
		expect(edited.text).toBe(`Edited fact ${marker}`);
		expect(edited.updated_at >= edited.created_at).toBe(true);

		const archiveRes = await apiPatchFact(fact.id, { status: "archived" });
		expect(archiveRes.status).toBe(200);
		expect(((await archiveRes.json()) as MemoryFactRecord).status).toBe("archived");

		const notFoundRes = await apiPatchFact(crypto.randomUUID(), { status: "active" });
		expect(notFoundRes.status).toBe(404);

		const badStatusRes = await apiPatchFact(fact.id, { status: "bogus" });
		expect(badStatusRes.status).toBe(400);
	});

	it("DELETE /api/memory/:id hard-deletes (204) and 404s a repeat delete", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`Deletable fact ${marker}`);
		// Delete it right away in this test rather than waiting for afterAll's cleanup pass.
		const idx = createdFactIds.indexOf(fact.id);
		if (idx >= 0) createdFactIds.splice(idx, 1);

		const res = await apiDeleteFact(fact.id);
		expect(res.status).toBe(204);

		const secondRes = await apiDeleteFact(fact.id);
		expect(secondRes.status).toBe(404);
	});
});

describe("renderMemoryBlock ordering via getMemoryBlock", () => {
	it("keeps facts in creation order after one is edited (updated_at moves, created_at doesn't)", async () => {
		// Explicit, widely-separated created_at values (rather than two back-to-back API calls)
		// make the ordering assertion deterministic instead of racing D1's millisecond timestamp
		// resolution.
		const marker = crypto.randomUUID().slice(0, 8);
		const idA = crypto.randomUUID();
		const idB = crypto.randomUUID();
		const textA = `order-a ${marker}`;
		const textB = `order-b ${marker}`;
		createdFactIds.push(idA, idB);

		await env.ORLA_DB.prepare(
			"INSERT INTO memory_facts (id, text, status, source, created_at, updated_at) VALUES (?, ?, 'active', 'user', ?, ?)",
		)
			.bind(idA, textA, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
			.run();
		await env.ORLA_DB.prepare(
			"INSERT INTO memory_facts (id, text, status, source, created_at, updated_at) VALUES (?, ?, 'active', 'user', ?, ?)",
		)
			.bind(idB, textB, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
			.run();

		const before = await getMemoryBlock(env.ORLA_DB);
		expect(before.indexOf(textA)).toBeGreaterThanOrEqual(0);
		expect(before.indexOf(textB)).toBeGreaterThan(before.indexOf(textA));

		// Editing A bumps its updated_at to "now" (2026-08-22-ish) while created_at stays fixed at
		// 2026-01-01 — if ordering used updated_at, A would now sort after B; it must not.
		const editedText = `order-a-edited ${marker}`;
		const patchRes = await apiPatchFact(idA, { text: editedText });
		expect(patchRes.status).toBe(200);
		const patched = (await patchRes.json()) as MemoryFactRecord;
		expect(patched.updated_at > patched.created_at).toBe(true);

		const after = await getMemoryBlock(env.ORLA_DB);
		expect(after.indexOf(editedText)).toBeGreaterThanOrEqual(0);
		expect(after.indexOf(textB)).toBeGreaterThan(after.indexOf(editedText));
	});
});

describe("GET /api/memory/preview", () => {
	it("matches getMemoryBlock and reports its character count", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const fact = await apiCreateFact(`Preview fact ${marker}`);

		const preview = await apiPreview();
		const direct = await getMemoryBlock(env.ORLA_DB);

		expect(preview.block).toBe(direct);
		expect(preview.chars).toBe(direct.length);
		expect(preview.block).toContain(fact.text);
	});
});

describe("reorganize: memory_candidates proposals (PRD §8, src/reorganize.ts)", () => {
	it("REORG_SYSTEM_PROMPT documents the memory_candidates field", () => {
		expect(REORG_SYSTEM_PROMPT).toContain("memory_candidates");
		expect(REORG_SYSTEM_PROMPT).toContain("durable facts about the user");
	});

	it("inserts a proposed memory_facts row per candidate, attributed to its organized note", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const noteId = await insertRawNote(`I really love ${marker} tea in the mornings`);
		const candidateText = `Likes ${marker} tea in the mornings`;

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
					memory_candidates: id === noteId ? [candidateText] : [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		await runReorganization(env, { batchSize: 25 });

		const proposedRow = await env.ORLA_DB.prepare(
			"SELECT id, status, source, source_note_id FROM memory_facts WHERE text = ?",
		)
			.bind(candidateText)
			.first<{ id: string; status: string; source: string; source_note_id: string | null }>();
		expect(proposedRow).not.toBeNull();
		expect(proposedRow?.status).toBe("proposed");
		expect(proposedRow?.source).toBe("reorganize");
		expect(proposedRow?.source_note_id).not.toBeNull();

		const organizedRow = await env.ORLA_DB.prepare(
			"SELECT id FROM organized_notes WHERE raw_note_id = ?",
		)
			.bind(noteId)
			.first<{ id: string }>();
		expect(proposedRow?.source_note_id).toBe(organizedRow?.id);

		if (proposedRow) createdFactIds.push(proposedRow.id);
	});

	it("skips a candidate that case-insensitively duplicates an existing fact", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const existingText = `Owns a ${marker} bicycle`;
		await apiCreateFact(existingText);

		const noteId = await insertRawNote(`talked about my ${marker} bicycle again`);

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
					memory_candidates: id === noteId ? [existingText.toUpperCase()] : [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		await runReorganization(env, { batchSize: 25 });

		const countRow = await env.ORLA_DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_facts WHERE lower(text) = lower(?)",
		)
			.bind(existingText)
			.first<{ n: number }>();
		expect(countRow?.n).toBe(1); // only the original — the duplicate candidate was skipped
	});

	it("drops a candidate over 200 characters without quarantining the note", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const noteId = await insertRawNote(`a note with marker ${marker}`);
		const longCandidate = `${marker} ${"x".repeat(210)}`;

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
					memory_candidates: id === noteId ? [longCandidate] : [],
				})),
			};
		});
		setReorgFetchForTests(fetchImpl);

		await runReorganization(env, { batchSize: 25 });

		const noteRow = await env.ORLA_DB.prepare("SELECT processed_at FROM raw_notes WHERE id = ?")
			.bind(noteId)
			.first<{ processed_at: string | null }>();
		expect(noteRow?.processed_at).not.toBeNull(); // the note itself was NOT quarantined

		const factRow = await env.ORLA_DB.prepare("SELECT id FROM memory_facts WHERE text = ?")
			.bind(longCandidate)
			.first();
		expect(factRow).toBeNull();
	});
});
