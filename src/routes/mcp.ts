/**
 * HTTP handlers for the MCP client (PRD §12): server CRUD (the only place a tool schema snapshot
 * changes — create, refresh, and nothing else) and the tap-to-confirm `pending_actions` queue for
 * act-tier tool calls raised by `Conversation#send` (src/conversation.ts).
 */

import { callTool, listTools, McpError, type McpTool, mcpFetch } from "../mcp";
import {
	createServer,
	deleteServer,
	expireStalePendingActions,
	getPendingAction,
	getServer,
	listPendingActions,
	listServers,
	type McpServerRow,
	McpServerValidationError,
	type PendingAction,
	type PendingActionStatus,
	replaceServerSchema,
	resolvePendingAction,
	toolsFromSchemaJson,
	toolTier,
	updateServer,
} from "../tools";

/** Matches `/api/mcp/servers/:id`, capturing `:id` only when it is a v4 UUID. */
export const MCP_SERVER_PATH_RE =
	/^\/api\/mcp\/servers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
/** Matches `/api/mcp/servers/:id/refresh`. */
export const MCP_SERVER_REFRESH_PATH_RE =
	/^\/api\/mcp\/servers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/refresh$/i;
/** Matches `/api/mcp/servers/:id/test`. */
export const MCP_SERVER_TEST_PATH_RE =
	/^\/api\/mcp\/servers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/test$/i;
/** Matches `/api/actions/:id/confirm`. */
export const PENDING_ACTION_CONFIRM_PATH_RE =
	/^\/api\/actions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/confirm$/i;
/** Matches `/api/actions/:id/reject`. */
export const PENDING_ACTION_REJECT_PATH_RE =
	/^\/api\/actions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/reject$/i;

const PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = [
	"pending",
	"confirmed",
	"rejected",
	"executed",
	"failed",
	"expired",
];

function isPendingActionStatus(value: string): value is PendingActionStatus {
	return (PENDING_ACTION_STATUSES as readonly string[]).includes(value);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}
	return payload as Record<string, unknown>;
}

function safeJsonParse(json: string | null): unknown {
	if (json === null) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function mcpErrorMessage(err: unknown): string {
	return err instanceof McpError ? err.message : "could not reach that MCP server";
}

/** `auth_header` is never echoed back to the client — only whether one is set (PRD §12, secrets). */
function toPublicServer(row: McpServerRow): Record<string, unknown> {
	const tools = toolsFromSchemaJson(row.schema_json);
	const tiers = { read: 0, act: 0 };
	for (const tool of tools) {
		tiers[toolTier(tool)] += 1;
	}
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		auth_header: row.auth_header !== null && row.auth_header.length > 0,
		enabled: row.enabled === 1,
		tool_count: tools.length,
		tiers,
		schema_refreshed_at: row.schema_refreshed_at,
		created_at: row.created_at,
	};
}

function toPublicTool(tool: McpTool): Record<string, unknown> {
	return { name: tool.name, description: tool.description ?? "", tier: toolTier(tool) };
}

function toPublicAction(action: PendingAction): Record<string, unknown> {
	return {
		id: action.id,
		conversation_id: action.conversation_id,
		server_id: action.server_id,
		tool_name: action.tool_name,
		arguments: safeJsonParse(action.arguments_json),
		status: action.status,
		result: safeJsonParse(action.result_json),
		created_at: action.created_at,
		resolved_at: action.resolved_at,
	};
}

// --- Servers ---------------------------------------------------------------------------------

export async function handleListServers(env: Env): Promise<Response> {
	const rows = await listServers(env.ORLA_DB);
	return Response.json({ servers: rows.map(toPublicServer) });
}

/** `POST /api/mcp/servers` `{ name, url, auth_header? }` — live `tools/list`, then saved together. */
export async function handleCreateServer(request: Request, env: Env): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const { name, url, auth_header: authHeader } = payload;
	if (typeof name !== "string" || name.trim().length === 0) {
		return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
	}
	if (typeof url !== "string") {
		return Response.json({ error: "url must be a string" }, { status: 400 });
	}
	if (authHeader !== undefined && authHeader !== null && typeof authHeader !== "string") {
		return Response.json({ error: "auth_header must be a string" }, { status: 400 });
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return Response.json({ error: "url must be a valid URL" }, { status: 400 });
	}
	if (parsedUrl.protocol !== "https:") {
		return Response.json({ error: "url must use https" }, { status: 400 });
	}

	let tools: McpTool[];
	try {
		tools = await listTools({ url, auth_header: authHeader ?? null }, mcpFetch());
	} catch (err) {
		return Response.json({ error: mcpErrorMessage(err) }, { status: 502 });
	}

	let row: McpServerRow;
	try {
		row = await createServer(env.ORLA_DB, { name, url, auth_header: authHeader ?? null });
	} catch (err) {
		if (err instanceof McpServerValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	await replaceServerSchema(env.ORLA_DB, row.id, tools);
	const saved = await getServer(env.ORLA_DB, row.id);
	return Response.json(
		{ server: toPublicServer(saved ?? row), tools: tools.map(toPublicTool) },
		{ status: 201 },
	);
}

/** `PATCH /api/mcp/servers/:id` `{ enabled?, name?, auth_header? }`. */
export async function handleUpdateServer(
	request: Request,
	env: Env,
	id: string,
): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) return payload;

	const { enabled, name, auth_header: authHeader } = payload;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
	}
	if (name !== undefined && typeof name !== "string") {
		return Response.json({ error: "name must be a string" }, { status: 400 });
	}
	if (authHeader !== undefined && authHeader !== null && typeof authHeader !== "string") {
		return Response.json({ error: "auth_header must be a string" }, { status: 400 });
	}

	try {
		const row = await updateServer(env.ORLA_DB, id, {
			enabled: enabled as boolean | undefined,
			name: name as string | undefined,
			auth_header: authHeader as string | null | undefined,
		});
		if (!row) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		return Response.json({ server: toPublicServer(row) });
	} catch (err) {
		if (err instanceof McpServerValidationError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
}

export async function handleDeleteServer(env: Env, id: string): Promise<Response> {
	const deleted = await deleteServer(env.ORLA_DB, id);
	if (!deleted) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	return new Response(null, { status: 204 });
}

/** `POST /api/mcp/servers/:id/refresh` — the only route (besides create) allowed to change a snapshot. */
export async function handleRefreshServer(env: Env, id: string): Promise<Response> {
	const row = await getServer(env.ORLA_DB, id);
	if (!row) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	let tools: McpTool[];
	try {
		tools = await listTools({ url: row.url, auth_header: row.auth_header }, mcpFetch());
	} catch (err) {
		return Response.json({ error: mcpErrorMessage(err) }, { status: 502 });
	}

	await replaceServerSchema(env.ORLA_DB, id, tools);
	const refreshed = await getServer(env.ORLA_DB, id);
	return Response.json({
		server: toPublicServer(refreshed ?? row),
		tools: tools.map(toPublicTool),
	});
}

/** `POST /api/mcp/servers/:id/test` — connects and lists tools without touching the snapshot. */
export async function handleTestServer(env: Env, id: string): Promise<Response> {
	const row = await getServer(env.ORLA_DB, id);
	if (!row) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	try {
		const tools = await listTools({ url: row.url, auth_header: row.auth_header }, mcpFetch());
		return Response.json({ ok: true, tools: tools.map(toPublicTool) });
	} catch (err) {
		return Response.json({ ok: false, error: mcpErrorMessage(err) }, { status: 502 });
	}
}

// --- Pending actions (tap-to-confirm) ----------------------------------------------------------

/** `GET /api/actions?status=pending` — expires stale `pending` rows (>1h) before listing. */
export async function handleListActions(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const statusRaw = url.searchParams.get("status");
	if (statusRaw !== null && !isPendingActionStatus(statusRaw)) {
		return Response.json(
			{ error: `status must be one of ${PENDING_ACTION_STATUSES.join(", ")}` },
			{ status: 400 },
		);
	}

	const actions = await listPendingActions(env.ORLA_DB, statusRaw ?? undefined);
	return Response.json({ actions: actions.map(toPublicAction) });
}

/** `POST /api/actions/:id/confirm` — executes the queued tool call now; the result is NOT fed back
 * into the conversation (keeps the tool loop bounded, PRD §12); the client shows it inline. */
export async function handleConfirmAction(env: Env, id: string): Promise<Response> {
	await expireStalePendingActions(env.ORLA_DB);
	const action = await getPendingAction(env.ORLA_DB, id);
	if (!action) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	if (action.status !== "pending") {
		return Response.json({ error: `action is ${action.status}, not pending` }, { status: 409 });
	}

	await resolvePendingAction(env.ORLA_DB, id, { status: "confirmed" });

	const server = await getServer(env.ORLA_DB, action.server_id);
	if (!server) {
		const failed = await resolvePendingAction(env.ORLA_DB, id, {
			status: "failed",
			resultJson: JSON.stringify({ error: "server not found" }),
		});
		return Response.json({ action: toPublicAction(failed ?? action) });
	}

	const argsRaw = safeJsonParse(action.arguments_json);
	const args =
		argsRaw !== null && typeof argsRaw === "object" ? (argsRaw as Record<string, unknown>) : {};

	try {
		const result = await callTool(
			{ url: server.url, auth_header: server.auth_header },
			action.tool_name,
			args,
			mcpFetch(),
		);
		const text = result.content.map((item) => item.text).join("\n");
		const resolved = await resolvePendingAction(env.ORLA_DB, id, {
			status: result.isError ? "failed" : "executed",
			resultJson: JSON.stringify({ text, isError: result.isError === true }),
		});
		return Response.json({ action: toPublicAction(resolved ?? action) });
	} catch (err) {
		const message = err instanceof Error ? err.message : "tool call failed";
		const resolved = await resolvePendingAction(env.ORLA_DB, id, {
			status: "failed",
			resultJson: JSON.stringify({ error: message }),
		});
		return Response.json({ action: toPublicAction(resolved ?? action) });
	}
}

/** `POST /api/actions/:id/reject`. */
export async function handleRejectAction(env: Env, id: string): Promise<Response> {
	await expireStalePendingActions(env.ORLA_DB);
	const action = await getPendingAction(env.ORLA_DB, id);
	if (!action) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	if (action.status !== "pending") {
		return Response.json({ error: `action is ${action.status}, not pending` }, { status: 409 });
	}

	const resolved = await resolvePendingAction(env.ORLA_DB, id, { status: "rejected" });
	return Response.json({ action: toPublicAction(resolved ?? action) });
}
