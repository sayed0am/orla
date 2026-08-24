/**
 * Chat mode: streaming message view with a full-screen Threads list behind the hamburger (at
 * every width). React port of `public/chat.js`'s `mountChat` — see that file and
 * `app/src/hooks/useChatStream.ts` for the behavior ported here.
 */

import { useCallback, useEffect, useState } from "react";
import { useChatStream } from "../../hooks/useChatStream";
import { apiFetch } from "../../lib/api";
import { IconMenu } from "../../ui/icons";
import Composer from "./Composer";
import ConversationList, {
	type ConversationListState,
	type ConversationSummary,
} from "./ConversationList";
import MessageList from "./MessageList";
import "./chat.css";

export default function ChatScreen() {
	const [listState, setListState] = useState<ConversationListState>({ status: "loading" });
	const [activeId, setActiveId] = useState<string | null>(null);
	const [threadsOpen, setThreadsOpen] = useState(false);
	// A message typed before any conversation exists — sent as soon as one is created.
	const [queued, setQueued] = useState<string | null>(null);

	const loadConversations = useCallback(async () => {
		let res: Response;
		try {
			res = await apiFetch("/api/conversations");
		} catch (err) {
			console.error("chat: failed to load conversations", err);
			setListState({ status: "unavailable", message: "Chat is unavailable right now." });
			return;
		}
		if (res.status === 404) {
			setListState({ status: "unavailable", message: "Chat isn't set up yet." });
			return;
		}
		if (!res.ok) {
			setListState({ status: "unavailable", message: "Chat is unavailable right now." });
			return;
		}
		const data = (await res.json()) as { conversations?: ConversationSummary[] };
		setListState({ status: "ready", conversations: data.conversations ?? [] });
	}, []);

	useEffect(() => {
		loadConversations();
	}, [loadConversations]);

	function openConversation(id: string) {
		setActiveId(id);
		setThreadsOpen(false);
	}

	async function createConversation(): Promise<void> {
		let res: Response;
		try {
			res = await apiFetch("/api/conversations", { method: "POST" });
		} catch (err) {
			console.error("chat: failed to create conversation", err);
			return;
		}
		if (!res.ok) {
			return;
		}
		const conversation = (await res.json()) as ConversationSummary;
		await loadConversations();
		openConversation(conversation.id);
	}

	const { items, sending, send, resolveConfirm } = useChatStream(activeId);

	// Flush the queued first message once its freshly created conversation is active.
	useEffect(() => {
		if (queued !== null && activeId !== null) {
			setQueued(null);
			send(queued);
		}
	}, [queued, activeId, send]);

	function handleSend(text: string) {
		if (activeId !== null) {
			send(text);
			return;
		}
		setQueued(text);
		void createConversation();
	}

	if (threadsOpen) {
		return (
			<div className="chat-view">
				<div className="chat-threads">
					<div className="chat-threads-header">
						<button type="button" className="back-link" onClick={() => setThreadsOpen(false)}>
							‹ Back
						</button>
						<span className="label">Threads</span>
						<span className="chat-threads-spacer" />
					</div>
					<ConversationList
						state={listState}
						activeId={activeId}
						hidden={false}
						onSelect={(id) => {
							// Drop any message queued for a conversation that never got created.
							setQueued(null);
							openConversation(id);
						}}
						onNew={() => void createConversation()}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="chat-view">
			<div className="chat-main">
				<div className="chat-top-row">
					<button
						type="button"
						className="icon-btn"
						aria-label="Threads"
						onClick={() => setThreadsOpen(true)}
					>
						<IconMenu width={16} height={16} />
					</button>
				</div>
				{activeId !== null ? (
					<MessageList items={items} activeId={activeId} onResolveConfirm={resolveConfirm} />
				) : (
					<div className="chat-idle">Ask Orla anything</div>
				)}
				<Composer onSend={handleSend} disabled={sending} />
			</div>
		</div>
	);
}
