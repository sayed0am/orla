/**
 * Tests for `src/tools.ts`: capability tiers, deterministic prompt rendering, name mangling, and
 * the D1-backed `mcp_servers` / `pending_actions` tables. Storage persists across the whole vitest
 * run (see vitest.config.ts) — every server/action this file creates is tracked and hard-deleted
 * in `afterAll`, since a leftover enabled server would change every chat test's cached prefix.
 */

import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import type { McpTool } from "../src/mcp";
import {
	createPendingAction,
	createServer,
	deleteServer,
	expireStalePendingActions,
	getPendingAction,
	getServer,
	listEnabledServersWithTools,
	listPendingActions,
	listServers,
	type McpServerForPrompt,
	McpServerValidationError,
	mangleToolName,
	parseToolName,
	renderToolsForPrompt,
	replaceServerSchema,
	resolvePendingAction,
	toolsDigest,
	toolTier,
	updateServer,
} from "../src/tools";

const createdServerIds: string[] = [];
const createdActionIds: string[] = [];

afterAll(async () => {
	for (const id of createdServerIds) {
		await env.ORLA_DB.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
	}
	for (const id of createdActionIds) {
		await env.ORLA_DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
	}
});

function readTool(over: Partial<McpTool> = {}): McpTool {
	return {
		name: "list_events",
		description: "List calendar events",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		...over,
	};
}

describe("toolTier", () => {
	it("is read only when readOnlyHint is true and destructiveHint is not true", () => {
		expect(toolTier(readTool())).toBe("read");
		expect(
			toolTier(readTool({ annotations: { readOnlyHint: true, destructiveHint: false } })),
		).toBe("read");
	});

	it("is act when readOnlyHint is true but destructiveHint is also true", () => {
		expect(toolTier(readTool({ annotations: { readOnlyHint: true, destructiveHint: true } }))).toBe(
			"act",
		);
	});

	it("is act when annotations are missing entirely (fail safe, not fail open)", () => {
		expect(toolTier({ name: "mystery", inputSchema: {} })).toBe("act");
	});

	it("is act when readOnlyHint is false or absent", () => {
		expect(toolTier(readTool({ annotations: { readOnlyHint: false } }))).toBe("act");
		expect(toolTier(readTool({ annotations: { destructiveHint: false } }))).toBe("act");
	});
});

describe("mangleToolName / parseToolName", () => {
	it("round-trips a simple name", () => {
		const mangled = mangleToolName("server-1", "list_events");
		expect(parseToolName(mangled)).toEqual({ serverId: "server-1", toolName: "list_events" });
	});

	it("round-trips a tool name that itself contains underscores", () => {
		const serverId = crypto.randomUUID();
		const mangled = mangleToolName(serverId, "send_calendar_invite");
		expect(parseToolName(mangled)).toEqual({ serverId, toolName: "send_calendar_invite" });
	});

	it("returns null for a name with no separator", () => {
		expect(parseToolName("not-mangled")).toBeNull();
	});
});

describe("renderToolsForPrompt", () => {
	it("returns empty tools and an empty system prompt when there are no servers", () => {
		expect(renderToolsForPrompt([])).toEqual({ tools: [], systemPrompt: "" });
	});

	it("returns empty output when servers exist but none has tools", () => {
		const servers: McpServerForPrompt[] = [{ id: "s1", name: "Calendar", tools: [] }];
		expect(renderToolsForPrompt(servers)).toEqual({ tools: [], systemPrompt: "" });
	});

	it("renders one function tool per tool, name-mangled, sorted by server then tool name", () => {
		const servers: McpServerForPrompt[] = [
			{
				id: "srv-b",
				name: "Zeta",
				tools: [readTool({ name: "z_tool" }), readTool({ name: "a_tool" })],
			},
			{ id: "srv-a", name: "Alpha", tools: [readTool({ name: "only_tool" })] },
		];

		const { tools } = renderToolsForPrompt(servers);
		expect(tools.map((t) => t.function.name)).toEqual([
			"srv-a__only_tool",
			"srv-b__a_tool",
			"srv-b__z_tool",
		]);
		expect(tools[0]).toEqual({
			type: "function",
			function: {
				name: "srv-a__only_tool",
				description: "List calendar events",
				parameters: { type: "object", properties: {} },
			},
		});
	});

	it("caps descriptions at 500 characters", () => {
		const longDescription = "x".repeat(600);
		const servers: McpServerForPrompt[] = [
			{ id: "s1", name: "S", tools: [readTool({ description: longDescription })] },
		];
		const { tools } = renderToolsForPrompt(servers);
		expect(tools[0]?.function.description.length).toBe(501); // 500 chars + the truncation mark
		expect(tools[0]?.function.description.startsWith("x".repeat(500))).toBe(true);
	});

	it("lists each tool's tier in the system prompt and states the quoted-data rule", () => {
		const servers: McpServerForPrompt[] = [
			{
				id: "s1",
				name: "Calendar",
				tools: [
					readTool({ name: "list_events" }),
					readTool({ name: "delete_event", annotations: {} }),
				],
			},
		];
		const { systemPrompt } = renderToolsForPrompt(servers);
		expect(systemPrompt).toContain("s1__list_events (Calendar, read-tier)");
		expect(systemPrompt).toContain("s1__delete_event (Calendar, act-tier)");
		expect(systemPrompt).toContain("quoted data");
		expect(systemPrompt).toContain("not instructions");
	});

	it("is deterministic: same servers value renders byte-identical output", () => {
		const servers: McpServerForPrompt[] = [{ id: "s1", name: "Calendar", tools: [readTool()] }];
		const a = renderToolsForPrompt(servers);
		const b = renderToolsForPrompt(structuredClone(servers));
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("toolsDigest", () => {
	it("is stable for the same rendered tools and changes when tools change", async () => {
		const servers: McpServerForPrompt[] = [{ id: "s1", name: "Calendar", tools: [readTool()] }];
		const digestA = await toolsDigest(servers);
		const digestB = await toolsDigest(structuredClone(servers));
		expect(digestA).toBe(digestB);
		expect(digestA).toMatch(/^[0-9a-f]{64}$/);

		const changed: McpServerForPrompt[] = [
			{ id: "s1", name: "Calendar", tools: [readTool({ name: "different_tool" })] },
		];
		expect(await toolsDigest(changed)).not.toBe(digestA);
	});

	it("is empty-input stable ('[]' hashed) regardless of call site", async () => {
		expect(await toolsDigest([])).toBe(await toolsDigest([]));
	});
});

describe("mcp_servers table", () => {
	it("creates, reads, lists, updates, and deletes a server", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const row = await createServer(env.ORLA_DB, {
			name: `Test Calendar ${marker}`,
			url: "https://mcp.example.com/calendar",
			auth_header: "Bearer secret",
		});
		createdServerIds.push(row.id);

		expect(row.enabled).toBe(1);
		expect(row.schema_json).toBe("[]");
		expect(row.auth_header).toBe("Bearer secret");

		const fetched = await getServer(env.ORLA_DB, row.id);
		expect(fetched).toMatchObject({ id: row.id, name: `Test Calendar ${marker}` });

		const all = await listServers(env.ORLA_DB);
		expect(all.some((s) => s.id === row.id)).toBe(true);

		const updated = await updateServer(env.ORLA_DB, row.id, { enabled: false, name: "Renamed" });
		expect(updated).toMatchObject({ id: row.id, enabled: 0, name: "Renamed" });

		const deleted = await deleteServer(env.ORLA_DB, row.id);
		expect(deleted).toBe(true);
		expect(await getServer(env.ORLA_DB, row.id)).toBeNull();
		createdServerIds.splice(createdServerIds.indexOf(row.id), 1);
	});

	it("rejects a non-https url", async () => {
		await expect(
			createServer(env.ORLA_DB, { name: "Bad", url: "http://insecure.example.com" }),
		).rejects.toThrow(McpServerValidationError);
	});

	it("rejects an empty name", async () => {
		await expect(
			createServer(env.ORLA_DB, { name: "   ", url: "https://mcp.example.com" }),
		).rejects.toThrow(McpServerValidationError);
	});

	it("updateServer returns null for an unknown id", async () => {
		expect(await updateServer(env.ORLA_DB, crypto.randomUUID(), { enabled: false })).toBeNull();
	});

	it("replaceServerSchema is the only thing that changes the snapshot, and stamps schema_refreshed_at", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const row = await createServer(env.ORLA_DB, {
			name: `Schema Test ${marker}`,
			url: "https://mcp.example.com/schema",
		});
		createdServerIds.push(row.id);
		expect(row.schema_refreshed_at).toBeNull();

		const tools: McpTool[] = [readTool()];
		await replaceServerSchema(env.ORLA_DB, row.id, tools);

		const refreshed = await getServer(env.ORLA_DB, row.id);
		expect(JSON.parse(refreshed?.schema_json ?? "[]")).toEqual(tools);
		expect(refreshed?.schema_refreshed_at).not.toBeNull();
	});

	it("listEnabledServersWithTools only returns enabled servers, with tools parsed", async () => {
		const marker = crypto.randomUUID().slice(0, 8);
		const enabledRow = await createServer(env.ORLA_DB, {
			name: `Enabled ${marker}`,
			url: "https://mcp.example.com/enabled",
		});
		createdServerIds.push(enabledRow.id);
		await replaceServerSchema(env.ORLA_DB, enabledRow.id, [readTool({ name: `tool_${marker}` })]);

		const disabledRow = await createServer(env.ORLA_DB, {
			name: `Disabled ${marker}`,
			url: "https://mcp.example.com/disabled",
		});
		createdServerIds.push(disabledRow.id);
		await updateServer(env.ORLA_DB, disabledRow.id, { enabled: false });
		await replaceServerSchema(env.ORLA_DB, disabledRow.id, [
			readTool({ name: `hidden_${marker}` }),
		]);

		const enabled = await listEnabledServersWithTools(env.ORLA_DB);
		expect(enabled.some((s) => s.id === enabledRow.id)).toBe(true);
		expect(enabled.some((s) => s.id === disabledRow.id)).toBe(false);

		const found = enabled.find((s) => s.id === enabledRow.id);
		expect(found?.tools.map((t) => t.name)).toEqual([`tool_${marker}`]);
	});
});

describe("pending_actions table", () => {
	it("creates, reads, lists by status, and resolves a pending action", async () => {
		const conversationId = crypto.randomUUID();
		const serverId = crypto.randomUUID();

		const action = await createPendingAction(env.ORLA_DB, {
			conversationId,
			serverId,
			toolName: "send_email",
			argumentsJson: JSON.stringify({ to: "a@b.com" }),
		});
		createdActionIds.push(action.id);

		expect(action.status).toBe("pending");
		expect(action.resolved_at).toBeNull();

		const fetched = await getPendingAction(env.ORLA_DB, action.id);
		expect(fetched).toMatchObject({ id: action.id, status: "pending" });

		const pending = await listPendingActions(env.ORLA_DB, "pending");
		expect(pending.some((a) => a.id === action.id)).toBe(true);

		const resolved = await resolvePendingAction(env.ORLA_DB, action.id, {
			status: "executed",
			resultJson: JSON.stringify({ text: "sent" }),
		});
		expect(resolved).toMatchObject({ status: "executed" });
		expect(resolved?.resolved_at).not.toBeNull();

		const stillPending = await listPendingActions(env.ORLA_DB, "pending");
		expect(stillPending.some((a) => a.id === action.id)).toBe(false);
	});

	it("expires a pending action older than 1 hour", async () => {
		const action = await createPendingAction(env.ORLA_DB, {
			conversationId: crypto.randomUUID(),
			serverId: crypto.randomUUID(),
			toolName: "delete_event",
			argumentsJson: "{}",
		});
		createdActionIds.push(action.id);

		// Backdate it past the 1h TTL directly — createPendingAction always stamps "now".
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		await env.ORLA_DB.prepare("UPDATE pending_actions SET created_at = ? WHERE id = ?")
			.bind(twoHoursAgo, action.id)
			.run();

		await expireStalePendingActions(env.ORLA_DB);

		const after = await getPendingAction(env.ORLA_DB, action.id);
		expect(after?.status).toBe("expired");
		expect(after?.resolved_at).not.toBeNull();
	});

	it("does not expire a pending action within the TTL", async () => {
		const action = await createPendingAction(env.ORLA_DB, {
			conversationId: crypto.randomUUID(),
			serverId: crypto.randomUUID(),
			toolName: "list_events",
			argumentsJson: "{}",
		});
		createdActionIds.push(action.id);

		await expireStalePendingActions(env.ORLA_DB);

		const after = await getPendingAction(env.ORLA_DB, action.id);
		expect(after?.status).toBe("pending");
	});
});
