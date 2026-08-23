import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { setCompactionThresholdForTests, setLlmFetchForTests } from "../src/conversation";
import { handlePostMessage } from "../src/routes/conversations";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setLlmFetchForTests(undefined);
	setCompactionThresholdForTests(undefined);
});

type ConversationRecord = { id: string; title: string; created_at: string; updated_at: string };
type TurnRecord = { seq: number; role: "user" | "assistant"; content: string; created_at: string };
type CapturedRequest = { url: string; body: Record<string, unknown> };
type SseEvent = { event: string; data: unknown };

async function createConversation(): Promise<Response> {
	return SELF.fetch(
		"http://example.com/api/conversations",
		await withAccessHeader({ method: "POST" }),
	);
}

async function listConversations(): Promise<Response> {
	return SELF.fetch("http://example.com/api/conversations", await withAccessHeader());
}

async function getMessages(id: string): Promise<Response> {
	return SELF.fetch(
		`http://example.com/api/conversations/${id}/messages`,
		await withAccessHeader(),
	);
}

async function postMessage(id: string, message: unknown): Promise<Response> {
	return SELF.fetch(
		`http://example.com/api/conversations/${id}/messages`,
		await withAccessHeader({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message }),
		}),
	);
}

async function parseSse(res: Response): Promise<SseEvent[]> {
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

/** Builds a fake `fetch` that answers OpenRouter's `/chat/completions` with a canned SSE reply. */
function fakeReplyFetch(
	replyText: string,
	opts?: { status?: number; cachedTokens?: number },
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
	const captured: CapturedRequest[] = [];
	const status = opts?.status ?? 200;
	const cachedTokens = opts?.cachedTokens ?? 3;

	const fetchImpl: typeof fetch = async (input, init) => {
		const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
		captured.push({ url: String(input), body });

		if (status !== 200) {
			return new Response("rate limited, slow down", { status });
		}

		const words = replyText.length > 0 ? replyText.split(" ") : [];
		const encoder = new TextEncoder();
		const lines: string[] = [];
		words.forEach((word, i) => {
			const content = i === 0 ? word : ` ${word}`;
			lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
		});
		lines.push(
			`data: ${JSON.stringify({
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: cachedTokens },
					cost: 0.0002,
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

describe("POST /api/conversations", () => {
	it("creates a conversation row", async () => {
		const res = await createConversation();
		expect(res.status).toBe(201);
		const conv = (await res.json()) as ConversationRecord;
		expect(conv.title).toBe("");
		expect(typeof conv.id).toBe("string");
		expect(typeof conv.created_at).toBe("string");
		expect(typeof conv.updated_at).toBe("string");
	});
});

describe("GET /api/conversations", () => {
	it("lists conversations newest-first", async () => {
		const first = (await (await createConversation()).json()) as ConversationRecord;
		const second = (await (await createConversation()).json()) as ConversationRecord;

		const res = await listConversations();
		expect(res.status).toBe(200);
		const { conversations } = (await res.json()) as { conversations: ConversationRecord[] };

		const firstIdx = conversations.findIndex((c) => c.id === first.id);
		const secondIdx = conversations.findIndex((c) => c.id === second.id);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeLessThan(firstIdx);
	});
});

describe("GET /api/conversations/:id/messages", () => {
	it("returns 404 for an unknown conversation", async () => {
		const res = await getMessages(crypto.randomUUID());
		expect(res.status).toBe(404);
		expect(await res.json()).toHaveProperty("error");
	});

	it("returns an empty turns list for a new conversation", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const res = await getMessages(conv.id);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ turns: [] });
	});
});

describe("POST /api/conversations/:id/messages", () => {
	it("streams a reply, persists turns, logs cost, and touches the conversation row", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const { fetchImpl } = fakeReplyFetch("Hello there friend", { cachedTokens: 7 });
		setLlmFetchForTests(fetchImpl);

		const res = await postMessage(conv.id, "Hi assistant");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Connection")).toBe("keep-alive");

		const events = await parseSse(res);
		const deltas = events.filter((e) => e.event === "delta").map((e) => e.data as string);
		expect(deltas.join("")).toBe("Hello there friend");

		const doneEvents = events.filter((e) => e.event === "done");
		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0]?.data).toMatchObject({ usage: { cached_tokens: 7 } });

		const messagesRes = await getMessages(conv.id);
		const { turns } = (await messagesRes.json()) as { turns: TurnRecord[] };
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ role: "user", content: "Hi assistant" });
		expect(turns[1]).toMatchObject({ role: "assistant", content: "Hello there friend" });

		// cached_tokens: 7 is a marker distinctive to this test's fake reply — storage persists
		// across the whole test run (see vitest.config.ts), so filtering on job_type alone would
		// also match rows other tests insert.
		const calls = await env.ORLA_DB.prepare(
			"SELECT job_type, cached_tokens FROM llm_calls WHERE job_type = 'chat' AND cached_tokens = 7",
		).all<{ job_type: string; cached_tokens: number }>();
		expect(calls.results).toHaveLength(1);
		expect(calls.results[0]).toEqual({ job_type: "chat", cached_tokens: 7 });

		const row = await env.ORLA_DB.prepare(
			"SELECT title, created_at, updated_at FROM conversations WHERE id = ?",
		)
			.bind(conv.id)
			.first<{ title: string; created_at: string; updated_at: string }>();
		expect(row?.title).toBe("Hi assistant");
		expect(row && row.updated_at >= row.created_at).toBe(true);
	});

	it("sends prior turns as history and reuses the same session_id on a second message", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const { fetchImpl, captured } = fakeReplyFetch("First reply");
		setLlmFetchForTests(fetchImpl);

		const firstRes = await postMessage(conv.id, "First message");
		await firstRes.text();

		const secondRes = await postMessage(conv.id, "Second message");
		await secondRes.text();

		expect(captured).toHaveLength(2);

		const firstMessages = captured[0]?.body.messages as Array<{ role: string; content: unknown }>;
		expect(firstMessages).toHaveLength(2);
		expect(firstMessages[1]).toEqual({ role: "user", content: "First message" });

		const secondMessages = captured[1]?.body.messages as Array<{ role: string; content: unknown }>;
		expect(secondMessages).toHaveLength(4);
		expect(secondMessages[1]).toEqual({ role: "user", content: "First message" });
		expect(secondMessages[2]).toEqual({ role: "assistant", content: "First reply" });
		expect(secondMessages[3]).toEqual({ role: "user", content: "Second message" });

		expect(captured[1]?.body.session_id).toBe(captured[0]?.body.session_id);
		expect(typeof captured[0]?.body.session_id).toBe("string");
	});

	it("emits an SSE error event on an upstream 429 and persists no assistant turn", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const { fetchImpl } = fakeReplyFetch("", { status: 429 });
		setLlmFetchForTests(fetchImpl);

		const res = await postMessage(conv.id, "Hi assistant");
		expect(res.status).toBe(200);

		const events = await parseSse(res);
		expect(events).toHaveLength(1);
		const errorEvent = events[0];
		expect(errorEvent?.event).toBe("error");
		const errorData = errorEvent?.data as { message: string } | undefined;
		expect(errorData?.message).toContain("429");

		const messagesRes = await getMessages(conv.id);
		const { turns } = (await messagesRes.json()) as { turns: TurnRecord[] };
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ role: "user", content: "Hi assistant" });
	});

	it("rejects an empty message", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const res = await postMessage(conv.id, "   ");
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("returns 404 for an unknown conversation", async () => {
		const res = await postMessage(crypto.randomUUID(), "hello");
		expect(res.status).toBe(404);
		expect(await res.json()).toHaveProperty("error");
	});

	it("returns 500 when OPENROUTER_API_KEY is unset (handler called directly with an env override)", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;
		const noKeyEnv: Env = { ...env, OPENROUTER_API_KEY: "" };

		const request = new Request(`http://example.com/api/conversations/${conv.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		const res = await handlePostMessage(request, noKeyEnv, conv.id);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "llm not configured" });
	});

	it("returns 409 busy when a send is already streaming for the conversation", async () => {
		const conv = (await (await createConversation()).json()) as ConversationRecord;

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl: typeof fetch = async () => {
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
						),
					);
					await gate;
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		};
		setLlmFetchForTests(fetchImpl);

		const first = await postMessage(conv.id, "first message");
		expect(first.status).toBe(200);
		const firstBody = first.body;
		if (!firstBody) throw new Error("expected a response body");
		const reader = firstBody.getReader();

		// Wait for the first delta to arrive so the DO is definitely mid-stream (busy) before the
		// second request is sent.
		const { value, done } = await reader.read();
		expect(done).toBe(false);
		expect(new TextDecoder().decode(value)).toContain("event: delta");

		const second = await postMessage(conv.id, "second message");
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ error: "busy" });

		release();

		// Drain the first stream to completion so the DO's `busy` flag resets and no work is left
		// dangling in the background.
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
		}
	});
});

/** Single-shot streaming reply: one delta chunk carrying the whole text, then `done` and `[DONE]`. */
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

/** Pads/truncates `s` to exactly `len` characters — used to make turn sizes exactly predictable. */
function fixedLength(s: string, len: number): string {
	return s.length >= len ? s.slice(0, len) : s + ".".repeat(len - s.length);
}

function conversationDOStub(id: string) {
	return env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
}

async function turnCompactedFlags(id: string): Promise<Array<{ seq: number; compacted: number }>> {
	return runInDurableObject(conversationDOStub(id), (_instance, state) =>
		state.storage.sql
			.exec<{ seq: number; compacted: number }>("SELECT seq, compacted FROM turns ORDER BY seq ASC")
			.toArray(),
	);
}

describe("Conversation#send history compaction (PRD §5)", () => {
	async function createConversation(): Promise<{ id: string }> {
		const res = await SELF.fetch(
			"http://example.com/api/conversations",
			await withAccessHeader({ method: "POST" }),
		);
		return (await res.json()) as { id: string };
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

	// Turn content is fixed at 18 chars/turn so the char-count math is exact against a 200-char
	// threshold: 10 turns = 180 (<= 200, no compaction), 12 turns = 216 (> 200, compacts).
	const TURN_LEN = 18;

	it(
		"compacts the oldest turns past the threshold, keeps the cached prefix stable, skips a " +
			"second compaction while still under threshold, then folds the prior summary into the next one",
		async () => {
			setCompactionThresholdForTests(200);
			const conv = await createConversation();

			const requests: Array<{ body: Record<string, unknown> }> = [];
			let streamCallIndex = 0;
			let compactionCallIndex = 0;

			setLlmFetchForTests(async (_input, init) => {
				const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
				requests.push({ body });

				if (body.stream === false) {
					compactionCallIndex++;
					return Response.json({
						choices: [
							{
								message: {
									content: JSON.stringify({ summary: `Summary ${compactionCallIndex}` }),
								},
							},
						],
						usage: { prompt_tokens: 12340 + compactionCallIndex, completion_tokens: 10 },
					});
				}

				streamCallIndex++;
				return fakeStreamingReplyResponse(fixedLength(`assistant-${streamCallIndex}`, TURN_LEN));
			});

			// Seed 6 user/assistant pairs (12 turns, 216 chars) — each seeding send's own threshold
			// check runs against only the *already persisted* turns (0, 2, 4, 6, 8, 10 of them), so
			// none of these six sends themselves cross the 200-char threshold.
			for (let i = 1; i <= 6; i++) {
				await (await postMessage(conv.id, fixedLength(`seed-u-${i}`, TURN_LEN))).text();
			}
			expect(requests.filter((r) => r.body.stream === false)).toHaveLength(0);

			// --- Send #7: 12 live turns (216 chars) now exceeds the 200-char threshold. ---
			await (await postMessage(conv.id, fixedLength("seed-u-7", TURN_LEN))).text();

			const compactionRequests = requests.filter((r) => r.body.stream === false);
			expect(compactionRequests).toHaveLength(1);
			const compactionMessages1 = compactionRequests[0]?.body.messages as Array<{
				content: unknown;
			}>;
			const compactionBody1 = JSON.parse(compactionMessages1[1]?.content as string) as {
				previous_summary: string | null;
				turns: Array<{ role: string; content: string }>;
			};

			// (a) the compaction request carries the 4 oldest turns, not the last 8.
			expect(compactionBody1.previous_summary).toBeNull();
			expect(compactionBody1.turns.map((t) => t.content)).toEqual([
				fixedLength("seed-u-1", TURN_LEN),
				fixedLength("assistant-1", TURN_LEN),
				fixedLength("seed-u-2", TURN_LEN),
				fixedLength("assistant-2", TURN_LEN),
			]);

			// (b) the subsequent streaming request is [system, (memory?), summary] then only the 8
			// kept turns plus the new message.
			const send7Messages = requests[requests.length - 1]?.body.messages as Array<{
				role: string;
				content: unknown;
			}>;
			const summaryIdx = send7Messages.findIndex((m) =>
				JSON.stringify(m.content).includes("Summary of the earlier part of this conversation"),
			);
			expect(summaryIdx).toBeGreaterThan(-1);
			expect(send7Messages[summaryIdx]?.role).toBe("system");
			expect(send7Messages[summaryIdx]?.content).toEqual([
				{
					type: "text",
					text: "Summary of the earlier part of this conversation:\nSummary 1",
					cache_control: { type: "ephemeral" },
				},
			]);
			for (const m of send7Messages.slice(0, summaryIdx)) {
				expect(m.role).toBe("system");
			}
			const send7Rest = send7Messages.slice(summaryIdx + 1);
			expect(send7Rest.map((m) => m.content)).toEqual([
				fixedLength("seed-u-3", TURN_LEN),
				fixedLength("assistant-3", TURN_LEN),
				fixedLength("seed-u-4", TURN_LEN),
				fixedLength("assistant-4", TURN_LEN),
				fixedLength("seed-u-5", TURN_LEN),
				fixedLength("assistant-5", TURN_LEN),
				fixedLength("seed-u-6", TURN_LEN),
				fixedLength("assistant-6", TURN_LEN),
				fixedLength("seed-u-7", TURN_LEN),
			]);

			// (c) the 4 oldest turns (lowest seq) are flagged compacted; the rest are not.
			const flags = await turnCompactedFlags(conv.id);
			const sortedSeqs = flags.map((f) => f.seq).sort((a, b) => a - b);
			const compactedSeqs = flags.filter((f) => f.compacted === 1).map((f) => f.seq);
			expect(compactedSeqs).toEqual(sortedSeqs.slice(0, 4));

			// (d) the compaction call got its own llm_calls row.
			const compactionRow = await env.ORLA_DB.prepare(
				"SELECT job_type, prompt_tokens, completion_tokens FROM llm_calls WHERE prompt_tokens = ?",
			)
				.bind(12341)
				.first<{ job_type: string; prompt_tokens: number; completion_tokens: number }>();
			expect(compactionRow).toEqual({
				job_type: "chat",
				prompt_tokens: 12341,
				completion_tokens: 10,
			});

			const summaryAfterFirstCompaction = await conversationDOStub(conv.id).getSummary();
			expect(summaryAfterFirstCompaction).toEqual({
				text: "Summary 1",
				through_seq: sortedSeqs[3],
			});

			// --- Send #8: only 10 live turns (180 chars) — below threshold, no compaction. ---
			const beforeSend8 = requests.length;
			await (await postMessage(conv.id, fixedLength("seed-u-8", TURN_LEN))).text();
			expect(requests.length).toBe(beforeSend8 + 1); // no extra compaction request
			expect(requests[beforeSend8]?.body.stream).toBe(true);

			// (e) the summary text is unchanged, and the prefix is exactly the previous request's
			// full messages plus the newly appended assistant turn.
			const send8Messages = requests[beforeSend8]?.body.messages as Array<{
				role: string;
				content: unknown;
			}>;
			expect(send8Messages.slice(0, -1)).toEqual([
				...send7Messages,
				{ role: "assistant", content: fixedLength("assistant-7", TURN_LEN) },
			]);

			const summaryAfterSend8 = await conversationDOStub(conv.id).getSummary();
			expect(summaryAfterSend8).toEqual(summaryAfterFirstCompaction); // unchanged

			// --- Send #9: back up to 12 live turns (216 chars) — compacts again. ---
			const beforeSend9 = requests.length;
			await (await postMessage(conv.id, fixedLength("seed-u-9", TURN_LEN))).text();
			const secondCompactionRequests = requests
				.slice(beforeSend9)
				.filter((r) => r.body.stream === false);
			expect(secondCompactionRequests).toHaveLength(1);

			const compactionMessages2 = secondCompactionRequests[0]?.body.messages as Array<{
				content: unknown;
			}>;
			const compactionBody2 = JSON.parse(compactionMessages2[1]?.content as string) as {
				previous_summary: string | null;
			};

			// Second compaction folds the first summary in.
			expect(compactionBody2.previous_summary).toBe("Summary 1");
		},
	);

	it("skips compaction on an LLM failure: the send still streams normally and no summary is stored", async () => {
		setCompactionThresholdForTests(1); // any non-empty history exceeds this
		const conv = await createConversation();

		setLlmFetchForTests(async (_input, init) => {
			const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
			if (body.stream === false) {
				return new Response("upstream failure", { status: 500 });
			}
			return fakeStreamingReplyResponse("ok");
		});

		// Seed enough turns that a compaction attempt has non-empty input (more than
		// KEEP_RECENT_TURNS turns already persisted before the triggering send).
		for (let i = 1; i <= 5; i++) {
			await (await postMessage(conv.id, `seed ${i}`)).text();
		}

		const res = await postMessage(conv.id, "one more message");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("event: delta");
		expect(text).not.toContain("event: error");

		expect(await conversationDOStub(conv.id).getSummary()).toBeNull();

		const flags = await turnCompactedFlags(conv.id);
		expect(flags.every((f) => f.compacted === 0)).toBe(true);
		expect(flags).toHaveLength(12); // 5 seed pairs + this send's user+assistant turns
	});
});
