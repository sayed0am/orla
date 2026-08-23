/**
 * OpenRouter client via Cloudflare AI Gateway (PLAN step 6). Pure networking module — the caller
 * supplies `fetchImpl` in tests and the D1 write (see `cost.ts`) happens outside this file.
 *
 * `baseUrl` is whatever the caller passes; in production it is expected to have the shape
 * `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/openrouter`.
 */

import type { ChatMessage } from "./prompt";
import type { ToolDef } from "./tools";

export type LlmConfig = {
	apiKey: string;
	model: string;
	baseUrl: string;
	sessionId: string;
	jobType: "chat" | "reorganize" | "brief";
	/**
	 * Pinned OpenRouter provider slug (PRD §5, `scripts/zdr-pin.mjs`). When set, the request
	 * restricts routing to this provider with fallbacks disabled; when unset, ZDR-only routing is
	 * still enforced but OpenRouter picks among all ZDR endpoints itself.
	 */
	provider?: string;
	/**
	 * MCP tool definitions (PRD §12, `src/tools.ts`'s `renderToolsForPrompt`). Only ever set for
	 * interactive chat (`Conversation#send`) — background jobs (reorganize, brief) never pass
	 * tools, per the PRD's capability-tier rule. Omitted (or empty) means no `tools`/`tool_choice`
	 * field is sent at all, so a no-MCP-servers request is byte-identical to before tool calling
	 * existed.
	 */
	tools?: ToolDef[];
};

/**
 * Reads `LLM_PROVIDER` off the Worker env, treating an unset or empty value as "no pin" so callers
 * can pass the result straight through to `LlmConfig.provider` without their own env plumbing.
 */
export function providerFromEnv(env: { LLM_PROVIDER?: string }): string | undefined {
	return env.LLM_PROVIDER === "" ? undefined : env.LLM_PROVIDER;
}

export type Usage = {
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number | null;
};

/** One fully-accumulated tool call, reassembled from streamed `function.name`/`arguments` fragments. */
export type StreamToolCall = { id: string; name: string; arguments: string };

export type StreamEvent =
	| { type: "delta"; text: string }
	| { type: "tool_calls"; calls: StreamToolCall[] }
	| { type: "done"; usage: Usage; finish_reason: string | null }
	| { type: "error"; message: string };

export class LlmError extends Error {
	status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "LlmError";
		this.status = status;
	}
}

const SSE_DONE = Symbol("sse-done");
const BODY_SNIPPET_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requestHeaders(cfg: LlmConfig): HeadersInit {
	return {
		Authorization: `Bearer ${cfg.apiKey}`,
		"Content-Type": "application/json",
		"HTTP-Referer": "https://github.com/orla",
		"X-Title": "Orla",
	};
}

function requestBody(
	messages: ChatMessage[],
	cfg: LlmConfig,
	stream: boolean,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: cfg.model,
		messages,
		stream,
		session_id: cfg.sessionId,
		usage: { include: true },
		provider: cfg.provider
			? { zdr: true, order: [cfg.provider], allow_fallbacks: false }
			: { zdr: true },
	};

	if (cfg.tools !== undefined && cfg.tools.length > 0) {
		body.tools = cfg.tools;
		body.tool_choice = "auto";
	}

	return body;
}

async function safeReadText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.length > BODY_SNIPPET_LIMIT ? `${text.slice(0, BODY_SNIPPET_LIMIT)}…` : text;
	} catch {
		return "<unreadable body>";
	}
}

function extractUsage(usageRaw: Record<string, unknown> | undefined): Usage {
	const promptTokens = typeof usageRaw?.prompt_tokens === "number" ? usageRaw.prompt_tokens : 0;
	const completionTokens =
		typeof usageRaw?.completion_tokens === "number" ? usageRaw.completion_tokens : 0;
	const details = isRecord(usageRaw?.prompt_tokens_details)
		? usageRaw.prompt_tokens_details
		: undefined;
	const cachedTokens = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
	const costUsd = typeof usageRaw?.cost === "number" ? usageRaw.cost : null;

	return {
		prompt_tokens: promptTokens,
		cached_tokens: cachedTokens,
		completion_tokens: completionTokens,
		cost_usd: costUsd,
	};
}

/**
 * Streamed `tool_calls` arrive as index-addressed fragments across many chunks (OpenRouter's
 * OpenAI-compatible delta shape): the first fragment for an index usually carries `id` and
 * `function.name`, every fragment appends to `function.arguments`. This accumulates fragments
 * across the whole stream, scoped to one `streamChat` call.
 */
type ToolCallAccumulator = Map<number, { id?: string; name?: string; arguments: string }>;

function newToolCallAccumulator(): ToolCallAccumulator {
	return new Map();
}

function accumulateToolCalls(acc: ToolCallAccumulator, deltaToolCalls: unknown): void {
	if (!Array.isArray(deltaToolCalls)) return;

	for (const item of deltaToolCalls) {
		if (!isRecord(item)) continue;
		const index = typeof item.index === "number" ? item.index : 0;
		const entry = acc.get(index) ?? { arguments: "" };

		if (typeof item.id === "string" && item.id.length > 0) {
			entry.id = item.id;
		}
		const fn = isRecord(item.function) ? item.function : undefined;
		if (typeof fn?.name === "string" && fn.name.length > 0) {
			entry.name = fn.name;
		}
		if (typeof fn?.arguments === "string") {
			entry.arguments += fn.arguments;
		}

		acc.set(index, entry);
	}
}

function finalizeToolCalls(acc: ToolCallAccumulator): StreamToolCall[] {
	return Array.from(acc.entries())
		.sort(([a], [b]) => a - b)
		.map(([index, entry]) => ({
			id: entry.id ?? `call_${index}`,
			name: entry.name ?? "",
			arguments: entry.arguments,
		}));
}

/**
 * A single SSE chunk can carry a content delta, tool-call fragments, and the final usage payload
 * all in the same object (some providers fold the last delta and usage together). Returns 0-2
 * events, delta/tool_calls before done, so callers must emit them in array order rather than
 * collapsing to a single event. `acc` accumulates tool-call fragments across the whole stream;
 * `state` tracks whether a `tool_calls` event has already been emitted this stream, so a
 * `finish_reason` chunk and a later `usage` chunk don't each emit their own.
 */
function interpretChunk(
	chunk: unknown,
	acc: ToolCallAccumulator,
	state: { sawToolCallDelta: boolean; toolCallsEmitted: boolean; finishReason: string | null },
): StreamEvent[] {
	if (!isRecord(chunk)) return [];

	const events: StreamEvent[] = [];

	const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
	const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
	const delta = isRecord(firstChoice?.delta) ? firstChoice.delta : undefined;
	const content = typeof delta?.content === "string" ? delta.content : undefined;

	if (content !== undefined && content.length > 0) {
		events.push({ type: "delta", text: content });
	}

	if (delta?.tool_calls !== undefined) {
		state.sawToolCallDelta = true;
		accumulateToolCalls(acc, delta.tool_calls);
	}

	if (typeof firstChoice?.finish_reason === "string") {
		state.finishReason = firstChoice.finish_reason;
	}

	const emitToolCallsIfNeeded = (): void => {
		if (
			!state.toolCallsEmitted &&
			(state.finishReason === "tool_calls" || state.sawToolCallDelta)
		) {
			events.push({ type: "tool_calls", calls: finalizeToolCalls(acc) });
			state.toolCallsEmitted = true;
		}
	};

	if (state.finishReason === "tool_calls") {
		emitToolCallsIfNeeded();
	}

	const usageRaw = isRecord(chunk.usage) ? chunk.usage : undefined;
	if (usageRaw !== undefined) {
		emitToolCallsIfNeeded();
		events.push({ type: "done", usage: extractUsage(usageRaw), finish_reason: state.finishReason });
	}

	return events;
}

function parseSseLine(
	rawLine: string,
	acc: ToolCallAccumulator,
	state: { sawToolCallDelta: boolean; toolCallsEmitted: boolean; finishReason: string | null },
): StreamEvent[] | typeof SSE_DONE {
	const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
	if (line.length === 0) return [];
	if (line.startsWith(":")) return []; // comment / keepalive
	if (!line.startsWith("data:")) return [];

	const data = line.slice("data:".length).trimStart();
	if (data === "[DONE]") return SSE_DONE;

	let chunk: unknown;
	try {
		chunk = JSON.parse(data);
	} catch {
		return [{ type: "error", message: `unparseable SSE chunk: ${data}` }];
	}

	return interpretChunk(chunk, acc, state);
}

export async function* streamChat(
	messages: ChatMessage[],
	cfg: LlmConfig,
	fetchImpl: typeof fetch = fetch,
): AsyncGenerator<StreamEvent> {
	const response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
		method: "POST",
		headers: requestHeaders(cfg),
		body: JSON.stringify(requestBody(messages, cfg, true)),
	});

	if (!response.ok) {
		const bodySnippet = await safeReadText(response);
		yield {
			type: "error",
			message: `OpenRouter request failed with status ${response.status}: ${bodySnippet}`,
		};
		return;
	}

	if (!response.body) {
		yield { type: "error", message: "OpenRouter response had no body" };
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const toolCallAcc = newToolCallAccumulator();
	const toolCallState = {
		sawToolCallDelta: false,
		toolCallsEmitted: false,
		finishReason: null as string | null,
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}
			if (done) {
				buffer += decoder.decode();
			}

			const lines = buffer.split("\n");
			buffer = done ? "" : (lines.pop() ?? "");

			for (const line of lines) {
				const parsed = parseSseLine(line, toolCallAcc, toolCallState);
				if (parsed === SSE_DONE) return;
				for (const event of parsed) {
					yield event;
				}
			}

			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function completeJson<T>(
	messages: ChatMessage[],
	cfg: LlmConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<{ value: T; usage: Usage }> {
	const response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
		method: "POST",
		headers: requestHeaders(cfg),
		body: JSON.stringify({
			...requestBody(messages, cfg, false),
			response_format: { type: "json_object" },
		}),
	});

	if (!response.ok) {
		const bodySnippet = await safeReadText(response);
		throw new LlmError(
			`OpenRouter request failed with status ${response.status}: ${bodySnippet}`,
			response.status,
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new LlmError("OpenRouter response was not valid JSON", response.status);
	}

	if (!isRecord(payload)) {
		throw new LlmError("OpenRouter response was not a JSON object", response.status);
	}

	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
	const message = isRecord(firstChoice?.message) ? firstChoice.message : undefined;
	const content = typeof message?.content === "string" ? message.content : undefined;

	if (content === undefined) {
		throw new LlmError("OpenRouter response missing message content", response.status);
	}

	let value: T;
	try {
		value = JSON.parse(content) as T;
	} catch {
		throw new LlmError("OpenRouter message content was not valid JSON", response.status);
	}

	const usageRaw = isRecord(payload.usage) ? payload.usage : undefined;
	return { value, usage: extractUsage(usageRaw) };
}
