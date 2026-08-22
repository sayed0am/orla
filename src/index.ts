import { requireAuth } from "./auth";
import { runMorningBrief } from "./brief";
import { insertRawNote, listRawNotes } from "./notes";
import { runReorganization } from "./reorganize";
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
	handlePushSubscribe,
	handlePushTest,
	handlePushUnsubscribe,
	handleVapidPublicKey,
} from "./routes/push";

export { Conversation } from "./conversation";

const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_ITEM_PATH_RE =
	/^\/api\/action-items\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
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
			return handleExport(env);
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
