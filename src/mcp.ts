/**
 * MCP (Model Context Protocol) client — Streamable HTTP transport only (PRD §12, the only tool
 * surface: first-party modules or remote MCP servers, nothing else). No SDK dependency: raw
 * JSON-RPC 2.0 over `fetch`, per
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (transport, session
 * headers) and https://modelcontextprotocol.io/specification/2025-06-18/server/tools (tools/list,
 * tools/call shapes, annotations).
 *
 * Session handling: a server MAY return an `Mcp-Session-Id` header from `initialize`, which must
 * then be echoed on every later request in that session. This client keeps that id only in
 * memory, for the lifetime of one logical call (`listTools` or `callTool`, which each run their
 * own `initialize` -> `notifications/initialized` -> real request handshake internally) — never
 * across separate top-level calls, and never written to D1 (PRD §11: schemas are snapshotted, not
 * live-refreshed per turn, but the transport session itself is even shorter-lived than that).
 */

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;

// Test-only hook, mirroring `setCompactionThresholdForTests` (src/conversation.ts): lets a test
// exercise the timeout path in milliseconds instead of needing to wait out the real 10s.
let testTimeoutMs: number | undefined;

/** Test-only: override (or clear, with `undefined`) the per-request timeout used by `mcpRequest`. */
export function setMcpTimeoutForTests(ms: number | undefined): void {
	testTimeoutMs = ms;
}

export type McpServerConfig = {
	url: string;
	auth_header?: string | null;
};

export type McpToolAnnotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

export type McpTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: McpToolAnnotations;
};

export type McpTextContent = { type: "text"; text: string };

export type McpToolResult = {
	content: McpTextContent[];
	isError?: boolean;
};

export class McpError extends Error {
	status?: number;
	code?: number;

	constructor(message: string, opts?: { status?: number; code?: number }) {
		super(message);
		this.name = "McpError";
		this.status = opts?.status;
		this.code = opts?.code;
	}
}

// Test-only hook, mirroring `setLlmFetchForTests` (src/conversation.ts) and
// `setReminderFetchForTests` (src/reminders.ts): both `Conversation#send`'s tool-execution step
// and `src/routes/mcp.ts` share this single override so a test can fake every MCP server they talk
// to without threading a fetchImpl through every call site by hand.
let testMcpFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake fetch used for all MCP server calls. */
export function setMcpFetchForTests(f: typeof fetch | undefined): void {
	testMcpFetch = f;
}

/** The fetch implementation callers should pass to `listTools`/`callTool`/`mcpRequest`. */
export function mcpFetch(): typeof fetch {
	return testMcpFetch ?? fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

let nextRequestId = 1;

function headersFor(server: McpServerConfig, sessionId: string | undefined): HeadersInit {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": PROTOCOL_VERSION,
	};
	if (server.auth_header) {
		headers.Authorization = server.auth_header;
	}
	if (sessionId) {
		headers["Mcp-Session-Id"] = sessionId;
	}
	return headers;
}

/** Scans an SSE response body for the first `message` event whose JSON-RPC `id` matches. */
async function readSseResponse(response: Response, id: number): Promise<unknown> {
	const text = await response.text();
	for (const block of text.split("\n\n")) {
		const dataLines = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim());
		if (dataLines.length === 0) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(dataLines.join("\n"));
		} catch {
			continue;
		}
		if (isRecord(parsed) && parsed.id === id) {
			return parsed;
		}
	}
	throw new McpError("MCP SSE stream ended without a matching JSON-RPC response");
}

export type McpRequestResult<T> = { result: T; sessionId?: string };

/**
 * Sends one JSON-RPC 2.0 request (or, with `opts.notify`, a notification with no `id`) to
 * `server.url`. Handles both a single JSON response and an SSE stream response, per the
 * Streamable HTTP spec. 10s timeout via `AbortController`. Throws `McpError` on any failure.
 */
export async function mcpRequest<T = unknown>(
	server: McpServerConfig,
	method: string,
	params: Record<string, unknown> | undefined,
	fetchImpl: typeof fetch,
	opts?: { sessionId?: string; notify?: boolean },
): Promise<McpRequestResult<T>> {
	const id = nextRequestId++;
	const body: Record<string, unknown> = opts?.notify
		? { jsonrpc: "2.0", method, params }
		: { jsonrpc: "2.0", id, method, params };

	const timeoutMs = testTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let response: Response;
	try {
		response = await fetchImpl(server.url, {
			method: "POST",
			headers: headersFor(server, opts?.sessionId),
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new McpError(`MCP request "${method}" timed out after ${timeoutMs}ms`);
		}
		const message = err instanceof Error ? err.message : "unknown error";
		throw new McpError(`MCP request "${method}" failed: ${message}`);
	} finally {
		clearTimeout(timer);
	}

	const sessionId = response.headers.get("Mcp-Session-Id") ?? opts?.sessionId;

	if (opts?.notify) {
		if (!response.ok && response.status !== 202) {
			throw new McpError(`MCP notification "${method}" failed with status ${response.status}`, {
				status: response.status,
			});
		}
		return { result: undefined as T, sessionId: sessionId ?? undefined };
	}

	if (!response.ok) {
		throw new McpError(`MCP request "${method}" failed with status ${response.status}`, {
			status: response.status,
		});
	}

	const contentType = response.headers.get("Content-Type") ?? "";
	let payload: unknown;
	if (contentType.includes("text/event-stream")) {
		payload = await readSseResponse(response, id);
	} else {
		try {
			payload = await response.json();
		} catch {
			throw new McpError(`MCP response for "${method}" was not valid JSON`);
		}
	}

	if (!isRecord(payload)) {
		throw new McpError(`MCP response for "${method}" was not a JSON object`);
	}
	if ("error" in payload && isRecord(payload.error)) {
		const rpcError = payload.error as { code?: number; message?: string };
		throw new McpError(rpcError.message ?? `MCP error calling "${method}"`, {
			code: rpcError.code,
		});
	}
	if (!("result" in payload)) {
		throw new McpError(`MCP response for "${method}" is missing a result`);
	}

	return { result: payload.result as T, sessionId: sessionId ?? undefined };
}

/** One `initialize` -> `notifications/initialized` handshake, then runs `fn` with that session id. */
async function withSession<T>(
	server: McpServerConfig,
	fetchImpl: typeof fetch,
	fn: (sessionId: string | undefined) => Promise<T>,
): Promise<T> {
	const init = await mcpRequest(
		server,
		"initialize",
		{
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "orla", version: "1.0.0" },
		},
		fetchImpl,
	);

	await mcpRequest(server, "notifications/initialized", undefined, fetchImpl, {
		sessionId: init.sessionId,
		notify: true,
	});

	return fn(init.sessionId);
}

type ToolsListResult = { tools?: McpTool[]; nextCursor?: string };

/** `tools/list`, following `nextCursor` pagination to completion. */
export async function listTools(
	server: McpServerConfig,
	fetchImpl: typeof fetch,
): Promise<McpTool[]> {
	return withSession(server, fetchImpl, async (sessionId) => {
		const tools: McpTool[] = [];
		let cursor: string | undefined;

		do {
			const { result } = await mcpRequest<ToolsListResult>(
				server,
				"tools/list",
				cursor ? { cursor } : undefined,
				fetchImpl,
				{ sessionId },
			);
			tools.push(...(result.tools ?? []));
			cursor = result.nextCursor;
		} while (cursor);

		return tools;
	});
}

type ToolsCallResult = { content?: unknown[]; isError?: boolean };

/**
 * `tools/call`. Only `text` content items are kept in the result; every other content type (image,
 * audio, resource, resource_link, …) is collapsed to a placeholder so the model always sees plain
 * text — the PRD's "quoted data, not instructions" framing only makes sense for text.
 */
export async function callTool(
	server: McpServerConfig,
	name: string,
	args: Record<string, unknown>,
	fetchImpl: typeof fetch,
): Promise<McpToolResult> {
	return withSession(server, fetchImpl, async (sessionId) => {
		const { result } = await mcpRequest<ToolsCallResult>(
			server,
			"tools/call",
			{ name, arguments: args },
			fetchImpl,
			{ sessionId },
		);

		const content: McpTextContent[] = (result.content ?? []).map((item) => {
			if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
				return { type: "text", text: item.text };
			}
			const type = isRecord(item) && typeof item.type === "string" ? item.type : "unknown";
			return { type: "text", text: `[${type} content omitted]` };
		});

		return { content, isError: result.isError };
	});
}
