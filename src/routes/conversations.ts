/** HTTP handlers for F1 chat: the D1 conversation index and the per-conversation DO (PLAN step 5). */

import { getMemoryBlock } from "../memory";
import { providerFromEnv } from "../llm";

/** Matches `/api/conversations/:id/messages`, capturing `:id` only when it is a v4 UUID. */
export const MESSAGES_PATH_RE =
	/^\/api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/messages$/i;

const MAX_MESSAGE_LENGTH = 20_000;

type ConversationRow = {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
};

function conversationStub(env: Env, id: string) {
	return env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
}

async function getConversationRow(db: D1Database, id: string): Promise<ConversationRow | null> {
	const row = await db
		.prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?")
		.bind(id)
		.first<ConversationRow>();
	return row ?? null;
}

export async function handleCreateConversation(env: Env): Promise<Response> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare("INSERT INTO conversations (id) VALUES (?)").bind(id).run();
	const row = await getConversationRow(env.ORLA_DB, id);
	if (!row) {
		throw new Error("handleCreateConversation: row missing after insert");
	}
	return Response.json(row, { status: 201 });
}

export async function handleListConversations(env: Env): Promise<Response> {
	const result = await env.ORLA_DB.prepare(
		"SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100",
	).all<ConversationRow>();
	return Response.json({ conversations: result.results });
}

export async function handleGetMessages(env: Env, id: string): Promise<Response> {
	const row = await getConversationRow(env.ORLA_DB, id);
	if (!row) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	const turns = await conversationStub(env, id).listTurns();
	return Response.json({ turns });
}

export async function handlePostMessage(request: Request, env: Env, id: string): Promise<Response> {
	const row = await getConversationRow(env.ORLA_DB, id);
	if (!row) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}

	const { message, tz_offset_minutes: tzOffsetMinutesRaw } = payload as Record<string, unknown>;
	if (typeof message !== "string" || message.trim().length === 0) {
		return Response.json({ error: "message must be a non-empty string" }, { status: 400 });
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return Response.json(
			{ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` },
			{ status: 400 },
		);
	}
	if (tzOffsetMinutesRaw !== undefined && typeof tzOffsetMinutesRaw !== "number") {
		return Response.json({ error: "tz_offset_minutes must be a number" }, { status: 400 });
	}

	if (!env.OPENROUTER_API_KEY) {
		return Response.json({ error: "llm not configured" }, { status: 500 });
	}

	const memoryBlock = await getMemoryBlock(env.ORLA_DB);

	const result = await conversationStub(env, id).send(message, {
		conversationId: id,
		assistantName: env.ASSISTANT_NAME,
		memoryBlock,
		model: env.LLM_MODEL,
		apiKey: env.OPENROUTER_API_KEY,
		baseUrl: env.OPENROUTER_BASE_URL,
		provider: providerFromEnv(env),
		tzOffsetMinutes: tzOffsetMinutesRaw as number | undefined,
	});

	if (!result.ok) {
		return Response.json({ error: "busy" }, { status: 409 });
	}

	return new Response(result.stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
