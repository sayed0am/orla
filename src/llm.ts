/**
 * OpenRouter client via Cloudflare AI Gateway (PLAN step 6). Pure networking module — the caller
 * supplies `fetchImpl` in tests and the D1 write (see `cost.ts`) happens outside this file.
 *
 * `baseUrl` is whatever the caller passes; in production it is expected to have the shape
 * `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/openrouter`.
 */

import type { ChatMessage } from "./prompt";

export type LlmConfig = {
	apiKey: string;
	model: string;
	baseUrl: string;
	sessionId: string;
	jobType: "chat" | "reorganize" | "brief";
};

export type Usage = {
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number | null;
};

export type StreamEvent =
	| { type: "delta"; text: string }
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
	return {
		model: cfg.model,
		messages,
		stream,
		session_id: cfg.sessionId,
		usage: { include: true },
		provider: { zdr: true },
	};
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
 * A single SSE chunk can carry a content delta AND the final usage payload in the same object
 * (some providers fold the last delta and usage together). Returns 0-2 events, delta before done,
 * so callers must emit them in array order rather than collapsing to a single event.
 */
function interpretChunk(chunk: unknown): StreamEvent[] {
	if (!isRecord(chunk)) return [];

	const events: StreamEvent[] = [];

	const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
	const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
	const delta = isRecord(firstChoice?.delta) ? firstChoice.delta : undefined;
	const content = typeof delta?.content === "string" ? delta.content : undefined;

	if (content !== undefined && content.length > 0) {
		events.push({ type: "delta", text: content });
	}

	const usageRaw = isRecord(chunk.usage) ? chunk.usage : undefined;
	if (usageRaw !== undefined) {
		const finishReason =
			typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;
		events.push({ type: "done", usage: extractUsage(usageRaw), finish_reason: finishReason });
	}

	return events;
}

function parseSseLine(rawLine: string): StreamEvent[] | typeof SSE_DONE {
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

	return interpretChunk(chunk);
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
				const parsed = parseSseLine(line);
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
