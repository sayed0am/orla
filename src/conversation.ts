/**
 * Per-conversation Durable Object: turn history, SSE streaming, the sticky OpenRouter
 * `session_id` (PRD §5, PLAN step 5). SQLite-backed (`new_sqlite_classes`); D1 holds only the
 * conversation index used for listing (see `src/routes/conversations.ts`).
 */

import { DurableObject } from "cloudflare:workers";
import { logLlmCall } from "./cost";
import { completeJson, streamChat, type Usage } from "./llm";
import { buildMessages } from "./prompt";
import {
	buildReminderDetectionMessages,
	formatReminderLocalTime,
	normalizeReminderDetection,
	REMINDER_TRIGGER_RE,
	ReminderValidationError,
	scheduleReminder,
} from "./reminders";

export type Turn = {
	seq: number;
	role: "user" | "assistant";
	content: string;
	created_at: string;
};

export type SendOpts = {
	/** The conversation's D1 index row id — the DO cannot recover this from its own identity. */
	conversationId: string;
	assistantName: string;
	memoryBlock: string;
	model: string;
	apiKey: string;
	baseUrl: string;
	/** Minutes to add to UTC to get the user's local time, for F5 reminder-time resolution. */
	tzOffsetMinutes?: number;
};

export type SendResult =
	| { ok: true; stream: ReadableStream<Uint8Array> }
	| { ok: false; reason: "busy" };

// Test-only hook: RPC arguments can't carry functions, so tests install a fake LLM fetch here
// instead, mirroring `setJwksFetchForTests` in src/auth.ts.
let testLlmFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake LLM fetch used by `Conversation#send`. */
export function setLlmFetchForTests(f: typeof fetch | undefined): void {
	testLlmFetch = f;
}

function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Per-conversation state: chat turns, SSE streaming, reminder alarms (PRD §5). */
export class Conversation extends DurableObject<Env> {
	private busy = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS turns (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					role TEXT NOT NULL CHECK(role IN ('user','assistant')),
					content TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
				)
			`);

			const existing = await this.ctx.storage.get<string>("session_id");
			if (existing === undefined) {
				await this.ctx.storage.put("session_id", crypto.randomUUID());
			}
		});
	}

	async listTurns(): Promise<Turn[]> {
		return this.ctx.storage.sql
			.exec<Turn>("SELECT seq, role, content, created_at FROM turns ORDER BY seq ASC")
			.toArray();
	}

	/**
	 * Streams an assistant reply to `userMessage`. Serializes against concurrent sends on the same
	 * conversation (DOs are single-threaded, but two tabs could otherwise interleave two in-flight
	 * streams) by returning `{ ok: false, reason: "busy" }` while a previous send is still running.
	 * (A thrown error's exact class does not reliably survive the Worker<->DO RPC boundary — it
	 * arrives as a generic `Error` with the message prefixed — so busy signalling is a return value
	 * instead of an exception.)
	 *
	 * The upstream LLM call is consumed by a task registered with `ctx.waitUntil` that writes into
	 * a `TransformStream` whose readable side is returned immediately — so persistence (the
	 * assistant turn, the cost log, the D1 index touch) completes even if the client disconnects
	 * mid-stream, and the runtime won't tear the task down once the response is sent.
	 */
	async send(userMessage: string, opts: SendOpts): Promise<SendResult> {
		if (this.busy) {
			return { ok: false, reason: "busy" };
		}
		this.busy = true;

		const sessionId = (await this.ctx.storage.get<string>("session_id")) ?? crypto.randomUUID();
		const priorTurns = await this.listTurns();
		const history = priorTurns.map((turn) => ({ role: turn.role, content: turn.content }));

		this.ctx.storage.sql.exec("INSERT INTO turns (role, content) VALUES ('user', ?)", userMessage);

		const fetchImpl = testLlmFetch ?? fetch;

		// F5 — "remind me Thursday 3pm to…" (PRD F5). A cheap, regex-gated pre-step: NOT a general
		// tool-calling loop, just one narrow `completeJson` extraction wired into this one call
		// site (see src/reminders.ts's module doc comment). Scheduling here is an *acting* tool
		// running with no tap-to-confirm, which the PRD's capability tiers (§12) otherwise require —
		// a deliberate, documented trade-off: F5 explicitly makes chat-created reminders a P1
		// feature, the assistant's reply (via `dynamicContext` below) always states what was
		// scheduled, and `DELETE /api/reminders/:id` is the one-tap undo.
		let dynamicContext: string | undefined;
		let reminderEvent: { id: string; text: string; fire_at: string } | undefined;

		if (REMINDER_TRIGGER_RE.test(userMessage)) {
			try {
				const now = new Date();
				const detection = await completeJson<unknown>(
					buildReminderDetectionMessages(userMessage, now, opts.tzOffsetMinutes ?? 0),
					{
						apiKey: opts.apiKey,
						model: opts.model,
						baseUrl: opts.baseUrl,
						sessionId,
						jobType: "chat",
					},
					fetchImpl,
				);
				await logLlmCall(this.env.ORLA_DB, {
					jobType: "chat",
					model: opts.model,
					usage: detection.usage,
				});

				const parsed = normalizeReminderDetection(detection.value);
				if (parsed?.is_reminder && parsed.fire_at !== null) {
					try {
						const reminder = await scheduleReminder(this.env, {
							text: parsed.text.length > 0 ? parsed.text : userMessage,
							fireAt: new Date(parsed.fire_at),
							source: "chat",
							sourceId: opts.conversationId,
						});
						reminderEvent = { id: reminder.id, text: reminder.text, fire_at: reminder.fire_at };
						dynamicContext = `Reminder scheduled for ${formatReminderLocalTime(parsed.fire_at)}: "${reminder.text}"`;
					} catch (err) {
						const reason =
							err instanceof ReminderValidationError
								? err.message
								: "could not schedule that reminder";
						dynamicContext = `Reminder request was ambiguous: ${reason}; ask the user to clarify.`;
					}
				} else if (parsed?.is_reminder && parsed.ambiguous) {
					dynamicContext = `Reminder request was ambiguous: ${parsed.ambiguous}; ask the user to clarify.`;
				}
			} catch {
				// Extraction call failed outright (bad JSON, upstream error, etc.) — this is a
				// best-effort side feature, so fall through to a normal reply rather than blocking
				// the chat turn on it.
			}
		}

		const messages = buildMessages({
			assistantName: opts.assistantName,
			memoryBlock: opts.memoryBlock,
			history,
			userMessage,
			dynamicContext,
		});

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();

		const run = async (): Promise<void> => {
			let assistantText = "";
			let usage: Usage | null = null;

			try {
				if (reminderEvent) {
					await this.writeChunk(writer, encoder.encode(sseEvent("reminder", reminderEvent)));
				}
				for await (const event of streamChat(
					messages,
					{
						apiKey: opts.apiKey,
						model: opts.model,
						baseUrl: opts.baseUrl,
						sessionId,
						jobType: "chat",
					},
					fetchImpl,
				)) {
					if (event.type === "delta") {
						assistantText += event.text;
						await this.writeChunk(writer, encoder.encode(sseEvent("delta", event.text)));
					} else if (event.type === "done") {
						usage = event.usage;
						await this.writeChunk(writer, encoder.encode(sseEvent("done", { usage: event.usage })));
					} else {
						await this.writeChunk(
							writer,
							encoder.encode(sseEvent("error", { message: event.message })),
						);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "unknown error";
				await this.writeChunk(writer, encoder.encode(sseEvent("error", { message })));
			} finally {
				if (assistantText.length > 0) {
					this.ctx.storage.sql.exec(
						"INSERT INTO turns (role, content) VALUES ('assistant', ?)",
						assistantText,
					);
				}
				if (usage !== null) {
					await logLlmCall(this.env.ORLA_DB, { jobType: "chat", model: opts.model, usage });
					await this.touchConversation(opts.conversationId, userMessage);
				}
				this.busy = false;
				try {
					await writer.close();
				} catch {
					// Client already gone; nothing left to flush.
				}
			}
		};

		this.ctx.waitUntil(run());

		return { ok: true, stream: readable };
	}

	private async writeChunk(
		writer: WritableStreamDefaultWriter<Uint8Array>,
		chunk: Uint8Array,
	): Promise<void> {
		try {
			await writer.write(chunk);
		} catch {
			// Client disconnected mid-stream; keep running so persistence still completes.
		}
	}

	private async touchConversation(conversationId: string, firstMessage: string): Promise<void> {
		const row = await this.env.ORLA_DB.prepare("SELECT title FROM conversations WHERE id = ?")
			.bind(conversationId)
			.first<{ title: string }>();

		if (row && row.title.length === 0) {
			const title = firstMessage.trim().slice(0, 60);
			await this.env.ORLA_DB.prepare(
				"UPDATE conversations SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
			)
				.bind(title, conversationId)
				.run();
			return;
		}

		await this.env.ORLA_DB.prepare(
			"UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
		)
			.bind(conversationId)
			.run();
	}
}
