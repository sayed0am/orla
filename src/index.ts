import { DurableObject } from "cloudflare:workers";
import { insertRawNote, listRawNotes } from "./notes";

const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_LENGTH = 20_000;

/** Per-conversation state: chat turns, SSE streaming, reminder alarms (PRD §5). */
export class Conversation extends DurableObject<Env> {
	async fetch(_request: Request): Promise<Response> {
		return new Response("not implemented", { status: 501 });
	}
}

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

		if (url.pathname === "/api/notes") {
			if (request.method === "POST") {
				return handleCreateNote(request, env);
			}
			if (request.method === "GET") {
				return handleListNotes(request, env);
			}
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},

	async scheduled(controller, _env, _ctx) {
		switch (controller.cron) {
			case "0 3 * * *":
				// F3 nightly reorganization
				break;
			case "0 6 * * *":
				// F4 morning brief
				break;
		}
	},
} satisfies ExportedHandler<Env>;
