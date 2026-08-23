import { requireAuth } from "./auth";
import { runMorningBrief } from "./brief";
import { insertRawNote, listRawNotes } from "./notes";
import { runReorganization } from "./reorganize";
import {
	CREDENTIAL_PATH_RE,
	handleAuthStatus,
	handleDeleteCredential,
	handleListCredentials,
	handleLoginOptions,
	handleLoginVerify,
	handleLogout,
	handleRegisterOptions,
	handleRegisterVerify,
} from "./routes/auth";
import { handleBriefGet, handleBriefRun } from "./routes/brief";
import {
	handleCreateConversation,
	handleGetMessages,
	handleListConversations,
	handlePostMessage,
	MESSAGES_PATH_RE,
} from "./routes/conversations";
import { handleCostSummary } from "./routes/costs";
import {
	handleActionItems,
	handleActionItemUpdate,
	handleExport,
	handleJournalList,
	handleJournalSearch,
} from "./routes/journal";
import {
	handleConfirmAction,
	handleCreateServer,
	handleDeleteServer,
	handleListActions,
	handleListServers,
	handleRefreshServer,
	handleRejectAction,
	handleTestServer,
	handleUpdateServer,
	MCP_SERVER_PATH_RE,
	MCP_SERVER_REFRESH_PATH_RE,
	MCP_SERVER_TEST_PATH_RE,
	PENDING_ACTION_CONFIRM_PATH_RE,
	PENDING_ACTION_REJECT_PATH_RE,
} from "./routes/mcp";
import {
	handleMemoryCreate,
	handleMemoryDelete,
	handleMemoryList,
	handleMemoryPreview,
	handleMemoryUpdate,
	MEMORY_FACT_PATH_RE,
} from "./routes/memory";
import {
	handlePushSubscribe,
	handlePushTest,
	handlePushUnsubscribe,
	handleVapidPublicKey,
} from "./routes/push";
import {
	handleCancelReminder,
	handleCreateReminder,
	handleListReminders,
	handleRemindFromActionItem,
} from "./routes/reminders";

export { Conversation } from "./conversation";
export { Scheduler } from "./reminders";

const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_ITEM_PATH_RE =
	/^\/api\/action-items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ACTION_ITEM_REMIND_PATH_RE =
	/^\/api\/action-items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/remind$/i;
const REMINDER_PATH_RE =
	/^\/api\/reminders\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_BODY_LENGTH = 20_000;

async function handleCreateNote(request: Request, env: Env): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}

	const { body, private: isPrivate, client_id: clientId } = payload as Record<string, unknown>;

	if (typeof body !== "string" || body.trim().length === 0) {
		return Response.json({ error: "body must be a non-empty string" }, { status: 400 });
	}
	if (body.length > MAX_BODY_LENGTH) {
		return Response.json(
			{ error: `body must be at most ${MAX_BODY_LENGTH} characters` },
			{ status: 400 },
		);
	}
	if (isPrivate !== undefined && typeof isPrivate !== "boolean") {
		return Response.json({ error: "private must be a boolean" }, { status: 400 });
	}
	if (clientId !== undefined && (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId))) {
		return Response.json({ error: "client_id must be a UUID" }, { status: 400 });
	}

	const note = await insertRawNote(env.ORLA_DB, { body, private: isPrivate, client_id: clientId });
	return Response.json(note, { status: 201 });
}

async function handleReorganizeRun(env: Env): Promise<Response> {
	const result = await runReorganization(env);
	return Response.json(result, { status: 200 });
}

type ReorgRunRow = {
	id: string;
	started_at: string;
	finished_at: string | null;
	status: string;
	notes_in: number;
	notes_ok: number;
	notes_failed: number;
	error: string | null;
};

async function handleListReorgRuns(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const limitParam = url.searchParams.get("limit");

	let limit = 20;
	if (limitParam !== null) {
		limit = Number(limitParam);
		if (!Number.isInteger(limit) || limit <= 0) {
			return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
		}
	}

	const result = await env.ORLA_DB.prepare(
		"SELECT id, started_at, finished_at, status, notes_in, notes_ok, notes_failed, error FROM reorg_runs ORDER BY started_at DESC, rowid DESC LIMIT ?",
	)
		.bind(limit)
		.all<ReorgRunRow>();

	return Response.json({ runs: result.results });
}

async function handleListNotes(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const limitParam = url.searchParams.get("limit");
	const before = url.searchParams.get("before") ?? undefined;

	let limit: number | undefined;
	if (limitParam !== null) {
		limit = Number(limitParam);
		if (!Number.isInteger(limit) || limit <= 0) {
			return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
		}
	}

	const notes = await listRawNotes(env.ORLA_DB, { limit, before });
	return Response.json({ notes });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, assistant: env.ASSISTANT_NAME });
		}

		// Passkey auth routes (Phase 3, docs/PLAN.md) gate themselves — bootstrap and login must be
		// reachable with no prior credential, so they're wired ahead of the blanket `/api/*` gate.
		if (url.pathname === "/api/auth/status" && request.method === "GET") {
			return handleAuthStatus(request, env);
		}

		if (url.pathname === "/api/auth/register/options" && request.method === "POST") {
			return handleRegisterOptions(request, env);
		}

		if (url.pathname === "/api/auth/register/verify" && request.method === "POST") {
			return handleRegisterVerify(request, env);
		}

		if (url.pathname === "/api/auth/login/options" && request.method === "POST") {
			return handleLoginOptions(request, env);
		}

		if (url.pathname === "/api/auth/login/verify" && request.method === "POST") {
			return handleLoginVerify(request, env);
		}

		if (url.pathname === "/api/auth/logout" && request.method === "POST") {
			return handleLogout();
		}

		if (url.pathname === "/api/auth/credentials" && request.method === "GET") {
			return handleListCredentials(request, env);
		}

		const credentialMatch = CREDENTIAL_PATH_RE.exec(url.pathname);
		if (credentialMatch && request.method === "DELETE") {
			const id = credentialMatch[1] as string;
			return handleDeleteCredential(request, env, id);
		}

		if (url.pathname.startsWith("/api/")) {
			const authResult = await requireAuth(request, env);
			if (authResult instanceof Response) {
				return authResult;
			}
		}

		if (url.pathname === "/api/notes") {
			if (request.method === "POST") {
				return handleCreateNote(request, env);
			}
			if (request.method === "GET") {
				return handleListNotes(request, env);
			}
		}

		if (url.pathname === "/api/conversations") {
			if (request.method === "POST") {
				return handleCreateConversation(env);
			}
			if (request.method === "GET") {
				return handleListConversations(env);
			}
		}

		const messagesMatch = MESSAGES_PATH_RE.exec(url.pathname);
		if (messagesMatch) {
			const id = messagesMatch[1] as string;
			if (request.method === "GET") {
				return handleGetMessages(env, id);
			}
			if (request.method === "POST") {
				return handlePostMessage(request, env, id);
			}
		}

		if (url.pathname === "/api/reorganize/run" && request.method === "POST") {
			return handleReorganizeRun(env);
		}

		if (url.pathname === "/api/reorganize/runs" && request.method === "GET") {
			return handleListReorgRuns(request, env);
		}

		if (url.pathname === "/api/costs" && request.method === "GET")
			return handleCostSummary(request, env);

		if (url.pathname === "/api/journal" && request.method === "GET") {
			return handleJournalList(request, env);
		}

		if (url.pathname === "/api/journal/search" && request.method === "GET") {
			return handleJournalSearch(request, env);
		}

		if (url.pathname === "/api/action-items" && request.method === "GET") {
			return handleActionItems(request, env);
		}

		const actionItemMatch = ACTION_ITEM_PATH_RE.exec(url.pathname);
		if (actionItemMatch && request.method === "PATCH") {
			const id = actionItemMatch[1] as string;
			return handleActionItemUpdate(request, env, id);
		}

		if (url.pathname === "/api/export" && request.method === "GET") {
			return handleExport(env, request);
		}

		if (url.pathname === "/api/memory/preview" && request.method === "GET") {
			return handleMemoryPreview(env);
		}

		if (url.pathname === "/api/memory") {
			if (request.method === "GET") {
				return handleMemoryList(request, env);
			}
			if (request.method === "POST") {
				return handleMemoryCreate(request, env);
			}
		}

		const memoryFactMatch = MEMORY_FACT_PATH_RE.exec(url.pathname);
		if (memoryFactMatch) {
			const id = memoryFactMatch[1] as string;
			if (request.method === "PATCH") {
				return handleMemoryUpdate(request, env, id);
			}
			if (request.method === "DELETE") {
				return handleMemoryDelete(env, id);
			}
		}

		if (url.pathname === "/api/mcp/servers") {
			if (request.method === "GET") {
				return handleListServers(env);
			}
			if (request.method === "POST") {
				return handleCreateServer(request, env);
			}
		}

		const mcpServerRefreshMatch = MCP_SERVER_REFRESH_PATH_RE.exec(url.pathname);
		if (mcpServerRefreshMatch && request.method === "POST") {
			const id = mcpServerRefreshMatch[1] as string;
			return handleRefreshServer(env, id);
		}

		const mcpServerTestMatch = MCP_SERVER_TEST_PATH_RE.exec(url.pathname);
		if (mcpServerTestMatch && request.method === "POST") {
			const id = mcpServerTestMatch[1] as string;
			return handleTestServer(env, id);
		}

		const mcpServerMatch = MCP_SERVER_PATH_RE.exec(url.pathname);
		if (mcpServerMatch) {
			const id = mcpServerMatch[1] as string;
			if (request.method === "PATCH") {
				return handleUpdateServer(request, env, id);
			}
			if (request.method === "DELETE") {
				return handleDeleteServer(env, id);
			}
		}

		if (url.pathname === "/api/actions" && request.method === "GET") {
			return handleListActions(request, env);
		}

		const actionConfirmMatch = PENDING_ACTION_CONFIRM_PATH_RE.exec(url.pathname);
		if (actionConfirmMatch && request.method === "POST") {
			const id = actionConfirmMatch[1] as string;
			return handleConfirmAction(env, id);
		}

		const actionRejectMatch = PENDING_ACTION_REJECT_PATH_RE.exec(url.pathname);
		if (actionRejectMatch && request.method === "POST") {
			const id = actionRejectMatch[1] as string;
			return handleRejectAction(env, id);
		}

		if (url.pathname === "/api/push/subscribe") {
			if (request.method === "POST") {
				return handlePushSubscribe(request, env);
			}
			if (request.method === "DELETE") {
				return handlePushUnsubscribe(request, env);
			}
		}

		if (url.pathname === "/api/push/vapid-public-key" && request.method === "GET") {
			return handleVapidPublicKey(env);
		}

		if (url.pathname === "/api/push/test" && request.method === "POST") {
			return handlePushTest(env);
		}

		if (url.pathname === "/api/brief" && request.method === "GET") {
			return handleBriefGet(request, env);
		}

		if (url.pathname === "/api/brief/run" && request.method === "POST") {
			return handleBriefRun(env);
		}

		if (url.pathname === "/api/reminders") {
			if (request.method === "GET") {
				return handleListReminders(request, env);
			}
			if (request.method === "POST") {
				return handleCreateReminder(request, env);
			}
		}

		const reminderMatch = REMINDER_PATH_RE.exec(url.pathname);
		if (reminderMatch && request.method === "DELETE") {
			const id = reminderMatch[1] as string;
			return handleCancelReminder(env, id);
		}

		const remindActionItemMatch = ACTION_ITEM_REMIND_PATH_RE.exec(url.pathname);
		if (remindActionItemMatch && request.method === "POST") {
			const id = remindActionItemMatch[1] as string;
			return handleRemindFromActionItem(request, env, id);
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},

	async scheduled(controller, env, ctx) {
		switch (controller.cron) {
			case "0 3 * * *":
				// F3 nightly reorganization
				ctx.waitUntil(
					runReorganization(env).catch((err) => {
						console.error("scheduled reorganization crashed", err);
					}),
				);
				break;
			case "0 6 * * *":
				// F4 morning brief
				ctx.waitUntil(
					runMorningBrief(env).catch((err) => {
						console.error("scheduled morning brief crashed", err);
					}),
				);
				break;
		}
	},
} satisfies ExportedHandler<Env>;
