import { describe, expect, it } from "vitest";
import { completeJson, type LlmConfig, LlmError, providerFromEnv, streamChat } from "../src/llm";
import type { ChatMessage } from "../src/prompt";

const cfg: LlmConfig = {
	apiKey: "test-key",
	model: "deepseek/deepseek-v4-flash-0731",
	baseUrl: "https://gateway.example/v1/acct/gw/openrouter",
	sessionId: "session-123",
	jobType: "chat",
};

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

type CapturedRequest = { url: string; init: RequestInit };

function fakeFetch(response: Response, captured: CapturedRequest[]): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured.push({ url: String(input), init: init ?? {} });
		return response;
	}) as typeof fetch;
}

function sseStream(fullText: string, splitAt: number[]): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(fullText);
	const pieces: Uint8Array[] = [];
	let start = 0;
	for (const point of splitAt) {
		pieces.push(bytes.slice(start, point));
		start = point;
	}
	pieces.push(bytes.slice(start));

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const piece of pieces) {
				controller.enqueue(piece);
			}
			controller.close();
		},
	});
}

function parsedBody(captured: CapturedRequest[]): Record<string, unknown> {
	const body = captured[0]?.init.body;
	expect(typeof body).toBe("string");
	return JSON.parse(body as string);
}

describe("streamChat", () => {
	it("concatenates deltas, splits chunk boundaries mid-JSON, and ends on [DONE]", async () => {
		const fullText =
			'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],' +
			'"usage":{"prompt_tokens":10,"completion_tokens":2,' +
			'"prompt_tokens_details":{"cached_tokens":4},"cost":0.0001}}\n\n' +
			"data: [DONE]\n\n";

		// Split right in the middle of the second chunk's JSON payload (inside the word "world"),
		// simulating a network read that cuts a `data:` line mid-object.
		const splitIndex = fullText.indexOf('"world"') + 3;
		const stream = sseStream(fullText, [splitIndex]);
		const response = new Response(stream, { status: 200 });

		const captured: CapturedRequest[] = [];
		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		const deltas = events
			.filter((e) => e.type === "delta")
			.map((e) => (e as { text: string }).text);
		expect(deltas.join("")).toBe("Hello world");

		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		const done = doneEvents[0] as {
			type: "done";
			usage: {
				prompt_tokens: number;
				cached_tokens: number;
				completion_tokens: number;
				cost_usd: number | null;
			};
			finish_reason: string | null;
		};
		expect(done.usage).toEqual({
			prompt_tokens: 10,
			cached_tokens: 4,
			completion_tokens: 2,
			cost_usd: 0.0001,
		});
		expect(done.finish_reason).toBe("stop");

		// [DONE] must be the last thing processed — no events after it.
		expect(events[events.length - 1]?.type).toBe("done");
	});

	it("yields an error event on a non-2xx response", async () => {
		const response = new Response("rate limited, slow down", { status: 429 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
		const err = events[0] as { type: "error"; message: string };
		expect(err.message).toContain("429");
		expect(err.message).toContain("rate limited, slow down");
	});

	it("sends session_id, provider.zdr, usage.include, and the Authorization header", async () => {
		const stream = sseStream("data: [DONE]\n\n", []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events).toHaveLength(0);
		const body = parsedBody(captured);
		expect(body.session_id).toBe("session-123");
		expect(body.provider).toEqual({ zdr: true });
		expect(body.usage).toEqual({ include: true });
		expect(body.stream).toBe(true);
		expect(body.model).toBe(cfg.model);

		const headers = new Headers(captured[0]?.init.headers);
		expect(headers.get("Authorization")).toBe("Bearer test-key");
	});

	it("pins provider.order and disables fallbacks when cfg.provider is set", async () => {
		const stream = sseStream("data: [DONE]\n\n", []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(
			messages,
			{ ...cfg, provider: "deepinfra" },
			fakeFetch(response, captured),
		)) {
			events.push(event);
		}

		expect(events).toHaveLength(0);
		const body = parsedBody(captured);
		expect(body.provider).toEqual({ zdr: true, order: ["deepinfra"], allow_fallbacks: false });
	});

	it("ignores SSE comment/keepalive lines", async () => {
		const fullText =
			': keepalive\n\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
		const stream = sseStream(fullText, []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ type: "delta", text: "hi" });
	});

	it("yields the delta before done when a single chunk carries both content and usage", async () => {
		const fullText =
			'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],' +
			'"usage":{"prompt_tokens":7,"completion_tokens":3,' +
			'"prompt_tokens_details":{"cached_tokens":1},"cost":0.00005}}\n\n' +
			"data: [DONE]\n\n";
		const stream = sseStream(fullText, []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		// The final chunk carries both the last delta ("!") and usage in the same object — the
		// delta must be yielded first, then done, never dropped or reordered.
		const deltas = events
			.filter((e) => e.type === "delta")
			.map((e) => (e as { text: string }).text);
		expect(deltas.join("")).toBe("Hello !");

		expect(events).toHaveLength(3);
		expect(events[0]).toEqual({ type: "delta", text: "Hello " });
		expect(events[1]).toEqual({ type: "delta", text: "!" });
		expect(events[2]).toMatchObject({
			type: "done",
			usage: {
				prompt_tokens: 7,
				cached_tokens: 1,
				completion_tokens: 3,
				cost_usd: 0.00005,
			},
			finish_reason: "stop",
		});
	});

	it("terminates cleanly with no done event when [DONE] arrives before any usage chunk", async () => {
		const fullText = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n';
		const stream = sseStream(fullText, []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events).toEqual([{ type: "delta", text: "partial" }]);
		expect(events.some((e) => e.type === "done")).toBe(false);
	});

	it("accumulates a tool call's arguments split across many chunks and yields tool_calls before done", async () => {
		const fullText =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function",' +
			'"function":{"name":"get_weather","arguments":""}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"NYC\\"}"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],' +
			'"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n' +
			"data: [DONE]\n\n";
		const stream = sseStream(fullText, []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events.filter((e) => e.type === "delta")).toHaveLength(0);
		const toolCallEvents = events.filter((e) => e.type === "tool_calls");
		expect(toolCallEvents).toHaveLength(1);
		const toolCalls = toolCallEvents[0] as {
			type: "tool_calls";
			calls: { id: string; name: string; arguments: string }[];
		};
		expect(toolCalls.calls).toEqual([
			{ id: "call_1", name: "get_weather", arguments: '{"location":"NYC"}' },
		]);

		// tool_calls must come before done, in that order, with nothing after done.
		expect(events.map((e) => e.type)).toEqual(["tool_calls", "done"]);
		expect(events[1]).toMatchObject({ type: "done", finish_reason: "tool_calls" });
	});

	it("splits arguments across a chunk boundary mid-stream (raw byte split)", async () => {
		const fullText =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function",' +
			'"function":{"name":"search","arguments":"{\\"q\\":\\"orla ' +
			'personal assistant\\"}"}}]}}]}\n\n' +
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
			"data: [DONE]\n\n";
		const bytes = new TextEncoder().encode(fullText);
		const splitIndex = Math.floor(bytes.length / 2);
		const stream = sseStream(fullText, [splitIndex]);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		const toolCalls = events.find((e) => e.type === "tool_calls") as
			| { type: "tool_calls"; calls: { id: string; name: string; arguments: string }[] }
			| undefined;
		expect(toolCalls?.calls).toEqual([
			{ id: "call_9", name: "search", arguments: '{"q":"orla personal assistant"}' },
		]);
	});

	it("yields tool_calls before done even when usage never arrives (finish_reason alone)", async () => {
		const fullText =
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function",' +
			'"function":{"name":"noop","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
			"data: [DONE]\n\n";
		const stream = sseStream(fullText, []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const events = [];
		for await (const event of streamChat(messages, cfg, fakeFetch(response, captured))) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "tool_calls", calls: [{ id: "call_2", name: "noop", arguments: "{}" }] },
		]);
	});

	it("includes tools and tool_choice: auto in the request body when cfg.tools is set", async () => {
		const stream = sseStream("data: [DONE]\n\n", []);
		const response = new Response(stream, { status: 200 });
		const captured: CapturedRequest[] = [];

		const toolDef = {
			type: "function" as const,
			function: { name: "s1__list_events", description: "List events", parameters: {} },
		};

		for await (const _event of streamChat(
			messages,
			{ ...cfg, tools: [toolDef] },
			fakeFetch(response, captured),
		)) {
			// drain
		}

		const body = parsedBody(captured);
		expect(body.tools).toEqual([toolDef]);
		expect(body.tool_choice).toBe("auto");
	});

	it("omits tools and tool_choice entirely when cfg.tools is unset or empty", async () => {
		const response1 = new Response(sseStream("data: [DONE]\n\n", []), { status: 200 });
		const captured1: CapturedRequest[] = [];
		for await (const _e of streamChat(messages, cfg, fakeFetch(response1, captured1))) {
			// drain
		}
		const body1 = parsedBody(captured1);
		expect(body1).not.toHaveProperty("tools");
		expect(body1).not.toHaveProperty("tool_choice");

		const response2 = new Response(sseStream("data: [DONE]\n\n", []), { status: 200 });
		const captured2: CapturedRequest[] = [];
		for await (const _e of streamChat(
			messages,
			{ ...cfg, tools: [] },
			fakeFetch(response2, captured2),
		)) {
			// drain
		}
		const body2 = parsedBody(captured2);
		expect(body2).not.toHaveProperty("tools");
		expect(body2).not.toHaveProperty("tool_choice");
	});
});

describe("completeJson", () => {
	it("parses the JSON content and returns usage", async () => {
		const payload = {
			choices: [{ message: { content: JSON.stringify({ foo: 42 }) } }],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 2 },
				cost: 0.00002,
			},
		};
		const response = new Response(JSON.stringify(payload), { status: 200 });
		const captured: CapturedRequest[] = [];

		const { value, usage } = await completeJson<{ foo: number }>(
			messages,
			cfg,
			fakeFetch(response, captured),
		);

		expect(value).toEqual({ foo: 42 });
		expect(usage).toEqual({
			prompt_tokens: 5,
			cached_tokens: 2,
			completion_tokens: 1,
			cost_usd: 0.00002,
		});

		const body = parsedBody(captured);
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.stream).toBe(false);
		expect(body.session_id).toBe("session-123");
		expect(body.provider).toEqual({ zdr: true });
		expect(body.usage).toEqual({ include: true });
	});

	it("throws LlmError on a 500 response", async () => {
		const response = new Response("internal error", { status: 500 });
		const captured: CapturedRequest[] = [];

		await expect(completeJson(messages, cfg, fakeFetch(response, captured))).rejects.toBeInstanceOf(
			LlmError,
		);

		try {
			await completeJson(
				messages,
				cfg,
				fakeFetch(new Response("internal error", { status: 500 }), captured),
			);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(LlmError);
			expect((err as LlmError).status).toBe(500);
		}
	});

	it("throws LlmError when the message content is not valid JSON", async () => {
		const payload = { choices: [{ message: { content: "not json" } }], usage: {} };
		const response = new Response(JSON.stringify(payload), { status: 200 });
		const captured: CapturedRequest[] = [];

		await expect(completeJson(messages, cfg, fakeFetch(response, captured))).rejects.toBeInstanceOf(
			LlmError,
		);
	});

	it("pins provider.order and disables fallbacks when cfg.provider is set", async () => {
		const payload = {
			choices: [{ message: { content: JSON.stringify({ foo: 1 }) } }],
			usage: {},
		};
		const response = new Response(JSON.stringify(payload), { status: 200 });
		const captured: CapturedRequest[] = [];

		await completeJson(messages, { ...cfg, provider: "deepinfra" }, fakeFetch(response, captured));

		const body = parsedBody(captured);
		expect(body.provider).toEqual({ zdr: true, order: ["deepinfra"], allow_fallbacks: false });
	});
});

describe("providerFromEnv", () => {
	it("returns the configured provider slug", () => {
		expect(providerFromEnv({ LLM_PROVIDER: "deepinfra" })).toBe("deepinfra");
	});

	it("returns undefined when LLM_PROVIDER is unset", () => {
		expect(providerFromEnv({})).toBeUndefined();
	});

	it("treats an empty string as unset", () => {
		expect(providerFromEnv({ LLM_PROVIDER: "" })).toBeUndefined();
	});
});
