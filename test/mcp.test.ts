import { afterEach, describe, expect, it } from "vitest";
import {
	callTool,
	listTools,
	McpError,
	type McpServerConfig,
	mcpRequest,
	setMcpTimeoutForTests,
} from "../src/mcp";

afterEach(() => {
	setMcpTimeoutForTests(undefined);
});

const server: McpServerConfig = { url: "https://mcp.example/mcp" };

type Captured = { url: string; init: RequestInit; body: Record<string, unknown> };

function jsonRpcResponse(id: unknown, result: unknown, sessionId?: string): Response {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (sessionId) {
		headers["Mcp-Session-Id"] = sessionId;
	}
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers });
}

function sseRpcResponse(id: unknown, result: unknown): Response {
	const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/**
 * A fake MCP server: answers `initialize` with a session id, `notifications/initialized` with a
 * bare 202, and everything else via `handlers[method]`. `useSse` routes `tools/list`/`tools/call`
 * through an SSE response instead of a plain JSON one, to exercise both transport shapes.
 */
function fakeMcpServer(opts: {
	handlers: Record<string, (params: Record<string, unknown> | undefined) => unknown>;
	sessionId?: string;
	useSse?: boolean;
}): { fetchImpl: typeof fetch; captured: Captured[] } {
	const captured: Captured[] = [];

	const fetchImpl: typeof fetch = async (input, init) => {
		const bodyText = String(init?.body ?? "{}");
		const body = JSON.parse(bodyText) as Record<string, unknown>;
		captured.push({ url: String(input), init: init ?? {}, body });

		if (init?.signal?.aborted) {
			throw new DOMException("aborted", "AbortError");
		}

		if (body.method === "initialize") {
			return jsonRpcResponse(body.id, { protocolVersion: "2025-06-18" }, opts.sessionId);
		}
		if (body.method === "notifications/initialized") {
			return new Response(null, { status: 202 });
		}

		const handler = opts.handlers[body.method as string];
		if (!handler) {
			return Response.json(
				{ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method" } },
				{ status: 200 },
			);
		}
		const result = handler(body.params as Record<string, unknown> | undefined);
		return opts.useSse ? sseRpcResponse(body.id, result) : jsonRpcResponse(body.id, result);
	};

	return { fetchImpl, captured };
}

describe("mcpRequest", () => {
	it("parses a plain JSON response", async () => {
		const { fetchImpl } = fakeMcpServer({
			handlers: { ping: () => ({ pong: true }) },
		});
		const { result } = await mcpRequest(server, "ping", undefined, fetchImpl);
		expect(result).toEqual({ pong: true });
	});

	it("parses an SSE response, picking the event whose id matches the request", async () => {
		const { fetchImpl } = fakeMcpServer({
			handlers: { ping: () => ({ pong: true }) },
			useSse: true,
		});
		const { result } = await mcpRequest(server, "ping", undefined, fetchImpl);
		expect(result).toEqual({ pong: true });
	});

	it("throws McpError on a JSON-RPC error response", async () => {
		const fetchImpl: typeof fetch = async () =>
			Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } });
		await expect(mcpRequest(server, "tools/call", undefined, fetchImpl)).rejects.toThrow(
			"bad params",
		);
	});

	it("throws McpError on a non-2xx status", async () => {
		const fetchImpl: typeof fetch = async () => new Response("nope", { status: 500 });
		const promise = mcpRequest(server, "ping", undefined, fetchImpl);
		await expect(promise).rejects.toThrow(McpError);
		await expect(promise).rejects.toMatchObject({ status: 500 });
	});

	it("times out and throws McpError", async () => {
		setMcpTimeoutForTests(20);
		const fetchImpl: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		await expect(mcpRequest(server, "ping", undefined, fetchImpl)).rejects.toThrow(McpError);
	});
});

describe("listTools", () => {
	it("initializes, sends notifications/initialized, then tools/list", async () => {
		const { fetchImpl, captured } = fakeMcpServer({
			handlers: {
				"tools/list": () => ({
					tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		});

		const tools = await listTools(server, fetchImpl);
		expect(tools).toEqual([{ name: "search", inputSchema: { type: "object", properties: {} } }]);

		expect(captured.map((c) => c.body.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		// The notification has no `id` at all — it's a JSON-RPC notification, not a request.
		expect(captured[1]?.body.id).toBeUndefined();
	});

	it("follows nextCursor pagination to completion", async () => {
		let calls = 0;
		const { fetchImpl } = fakeMcpServer({
			handlers: {
				"tools/list": (params) => {
					calls += 1;
					if (params?.cursor === undefined) {
						return { tools: [{ name: "a", inputSchema: {} }], nextCursor: "page-2" };
					}
					expect(params.cursor).toBe("page-2");
					return { tools: [{ name: "b", inputSchema: {} }] };
				},
			},
		});

		const tools = await listTools(server, fetchImpl);
		expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
		expect(calls).toBe(2);
	});

	it("propagates the Mcp-Session-Id from initialize onto every later request", async () => {
		const { fetchImpl, captured } = fakeMcpServer({
			handlers: { "tools/list": () => ({ tools: [] }) },
			sessionId: "session-abc",
		});

		await listTools(server, fetchImpl);

		const initHeaders = new Headers(captured[0]?.init.headers);
		expect(initHeaders.get("Mcp-Session-Id")).toBeNull();
		const notifyHeaders = new Headers(captured[1]?.init.headers);
		expect(notifyHeaders.get("Mcp-Session-Id")).toBe("session-abc");
		const listHeaders = new Headers(captured[2]?.init.headers);
		expect(listHeaders.get("Mcp-Session-Id")).toBe("session-abc");
	});

	it("sends the required transport headers", async () => {
		const { fetchImpl, captured } = fakeMcpServer({
			handlers: { "tools/list": () => ({ tools: [] }) },
		});
		await listTools({ ...server, auth_header: "Bearer secret-token" }, fetchImpl);

		const headers = new Headers(captured[0]?.init.headers);
		expect(headers.get("Accept")).toBe("application/json, text/event-stream");
		expect(headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
		expect(headers.get("Authorization")).toBe("Bearer secret-token");
	});
});

describe("callTool", () => {
	it("keeps only text content and collapses everything else to a placeholder", async () => {
		const { fetchImpl } = fakeMcpServer({
			handlers: {
				"tools/call": () => ({
					content: [
						{ type: "text", text: "here are your events" },
						{ type: "image", data: "base64...", mimeType: "image/png" },
						{ type: "resource_link", uri: "file:///notes.txt" },
					],
				}),
			},
		});

		const result = await callTool(server, "list_events", {}, fetchImpl);
		expect(result.content).toEqual([
			{ type: "text", text: "here are your events" },
			{ type: "text", text: "[image content omitted]" },
			{ type: "text", text: "[resource_link content omitted]" },
		]);
		expect(result.isError).toBeUndefined();
	});

	it("passes through isError and the tool name/arguments", async () => {
		const { fetchImpl, captured } = fakeMcpServer({
			handlers: {
				"tools/call": (params) => {
					expect(params).toEqual({ name: "send_email", arguments: { to: "a@b.com" } });
					return { content: [{ type: "text", text: "rate limited" }], isError: true };
				},
			},
		});

		const result = await callTool(server, "send_email", { to: "a@b.com" }, fetchImpl);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "rate limited" }]);
		expect(captured.at(-1)?.body.method).toBe("tools/call");
	});
});
