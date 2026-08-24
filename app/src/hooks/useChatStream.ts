/**
 * Message-pane state machine for one open conversation (PRD F1). React port of the imperative
 * DOM code in `public/chat.js`'s `openConversation`/`send`/confirm-card handlers — see that file
 * for the behavior this mirrors: SSE streaming coalesced via requestAnimationFrame, the 409 "still
 * replying" path, and tap-to-confirm resolution.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { readSse } from "../lib/sse";
import { notifyPendingActionsChanged } from "./usePendingActions";

export interface MessageItem {
	kind: "message";
	id: string;
	role: "user" | "assistant";
	text: string;
	/** True while this assistant message is still receiving deltas (streaming markdown render). */
	streaming: boolean;
}

export interface ToolItem {
	kind: "tool";
	id: string;
	name: string;
	status: "done" | "error";
	preview?: string;
}

export interface ConfirmItem {
	kind: "confirm";
	id: string;
	actionId: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Set once the user taps Allow/Don't allow — swaps the action row for this inline result. */
	result: { text: string } | null;
	/** True while a confirm/reject request is in flight — disables the Allow/Don't allow row. */
	resolving: boolean;
}

export interface ErrorItem {
	kind: "error";
	id: string;
	text: string;
}

export type TranscriptItem = MessageItem | ToolItem | ConfirmItem | ErrorItem;

function newId(): string {
	return crypto.randomUUID();
}

interface UseChatStreamResult {
	items: TranscriptItem[];
	/** True while a load of the conversation's history is in flight. */
	loading: boolean;
	/** True while a message is in flight/streaming — mirrors chat.js's `sending` flag. */
	sending: boolean;
	send: (text: string) => Promise<void>;
	resolveConfirm: (item: ConfirmItem, allow: boolean) => Promise<void>;
}

/** Loads `GET /api/conversations/:id/messages` and streams `POST .../messages` for `conversationId`. */
export function useChatStream(conversationId: string | null): UseChatStreamResult {
	const [items, setItems] = useState<TranscriptItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		if (!conversationId) {
			setItems([]);
			return;
		}
		let cancelled = false;
		setItems([]);
		setLoading(true);

		(async () => {
			let res: Response;
			try {
				res = await apiFetch(`/api/conversations/${conversationId}/messages`);
			} catch (err) {
				console.error("chat: failed to load messages", err);
				if (!cancelled) {
					setItems([{ kind: "error", id: newId(), text: "Couldn't load this conversation." }]);
					setLoading(false);
				}
				return;
			}
			if (cancelled) {
				return;
			}
			if (!res.ok) {
				setItems([{ kind: "error", id: newId(), text: "Couldn't load this conversation." }]);
				setLoading(false);
				return;
			}
			const data = (await res.json()) as {
				turns?: Array<{ role: "user" | "assistant"; content: string }>;
			};
			if (cancelled) {
				return;
			}
			const loaded: TranscriptItem[] = (data.turns ?? []).map((turn) => ({
				kind: "message",
				id: newId(),
				role: turn.role,
				text: turn.content,
				streaming: false,
			}));
			setItems(loaded);
			setLoading(false);
		})();

		return () => {
			cancelled = true;
		};
	}, [conversationId]);

	const send = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0 || sending || !conversationId) {
				return;
			}

			setSending(true);
			const userItem: MessageItem = {
				kind: "message",
				id: newId(),
				role: "user",
				text: trimmed,
				streaming: false,
			};
			const assistantId = newId();
			const assistantItem: MessageItem = {
				kind: "message",
				id: assistantId,
				role: "assistant",
				text: "",
				streaming: true,
			};
			setItems((prev) => [...prev, userItem, assistantItem]);

			const removeAssistantPlaceholder = () => {
				setItems((prev) => prev.filter((item) => item.id !== assistantId));
			};
			const appendError = (message: string) => {
				setItems((prev) => [...prev, { kind: "error", id: newId(), text: message }]);
			};

			try {
				const res = await apiFetch(`/api/conversations/${conversationId}/messages`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ message: trimmed }),
				});

				if (res.status === 409) {
					removeAssistantPlaceholder();
					appendError("Orla is still replying to a previous message.");
					return;
				}
				if (!res.ok || !res.body) {
					removeAssistantPlaceholder();
					appendError("Something went wrong sending that message.");
					return;
				}

				let assistantText = "";
				let streamError: string | undefined;
				let rafHandle: number | null = null;

				const setAssistantText = (nextText: string, streaming: boolean) => {
					setItems((prev) =>
						prev.map((item) =>
							item.id === assistantId && item.kind === "message"
								? { ...item, text: nextText, streaming }
								: item,
						),
					);
				};

				const scheduleAssistantRender = () => {
					if (rafHandle !== null) {
						return;
					}
					rafHandle = requestAnimationFrame(() => {
						rafHandle = null;
						setAssistantText(assistantText, true);
					});
				};

				await readSse(res, (evt) => {
					if (evt.event === "delta") {
						assistantText += evt.text;
						scheduleAssistantRender();
					} else if (evt.event === "tool") {
						setItems((prev) => [
							...prev,
							{
								kind: "tool",
								id: newId(),
								name: evt.name,
								status: evt.status,
								preview: evt.preview,
							},
						]);
					} else if (evt.event === "confirm") {
						setItems((prev) => [
							...prev,
							{
								kind: "confirm",
								id: newId(),
								actionId: evt.action_id,
								name: evt.name,
								arguments: evt.arguments,
								result: null,
								resolving: false,
							},
						]);
						notifyPendingActionsChanged();
					} else if (evt.event === "error") {
						streamError = evt.message;
					}
					// "reminder" and "done" are parsed but intentionally not surfaced here, matching
					// chat.js — the final non-streaming render below runs once the whole SSE response
					// has been read, regardless of a "done" event.
				});

				// Coalesced rAF renders may be mid-flight or skipped for the last delta(s); the final,
				// non-streaming render always happens so the bubble ends up fully parsed.
				if (rafHandle !== null) {
					cancelAnimationFrame(rafHandle);
					rafHandle = null;
				}
				setAssistantText(assistantText, false);

				if (streamError) {
					appendError(streamError);
				}
			} catch (err) {
				console.error("chat: send failed", err);
				appendError("Something went wrong sending that message.");
			} finally {
				setSending(false);
			}
		},
		[conversationId, sending],
	);

	const resolveConfirm = useCallback(async (item: ConfirmItem, allow: boolean) => {
		const path = allow ? "confirm" : "reject";
		const setResolving = (resolving: boolean) => {
			setItems((prev) =>
				prev.map((it) => (it.id === item.id && it.kind === "confirm" ? { ...it, resolving } : it)),
			);
		};

		setResolving(true);
		try {
			const res = await apiFetch(`/api/actions/${item.actionId}/${path}`, { method: "POST" });
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			let resultText: string;
			if (!allow) {
				resultText = "Not allowed.";
			} else {
				const body = (await res.json()) as {
					action?: { result?: { text?: unknown; error?: unknown } };
				};
				const resultData = body.action?.result ?? {};
				const text =
					typeof resultData.text === "string"
						? resultData.text
						: typeof resultData.error === "string"
							? resultData.error
							: JSON.stringify(resultData);
				resultText = `"${text}"`;
			}
			setItems((prev) =>
				prev.map((it) =>
					it.id === item.id && it.kind === "confirm"
						? { ...it, result: { text: resultText }, resolving: false }
						: it,
				),
			);
			notifyPendingActionsChanged();
		} catch (err) {
			console.error(`chat: failed to resolve pending action (${path})`, err);
			setResolving(false);
		}
	}, []);

	return { items, loading, sending, send, resolveConfirm };
}
