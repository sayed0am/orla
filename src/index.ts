import { DurableObject } from "cloudflare:workers";

/** Per-conversation state: chat turns, SSE streaming, reminder alarms (PRD §5). */
export class Conversation extends DurableObject<Env> {
	async fetch(_request: Request): Promise<Response> {
		return new Response("not implemented", { status: 501 });
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, assistant: env.ASSISTANT_NAME });
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
