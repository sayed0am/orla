import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { setLlmFetchForTests } from "../src/conversation";
import { handlePostMessage } from "../src/routes/conversations";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setLlmFetchForTests(undefined);
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
