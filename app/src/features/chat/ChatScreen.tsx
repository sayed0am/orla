/**
 * Chat tab: conversation list + streaming message view (PRD F1). React port of `public/chat.js`'s
 * `mountChat` — see that file and `app/src/hooks/useChatStream.ts` for the behavior ported here.
 */

import { useCallback, useEffect, useState } from "react";
import { useChatStream } from "../../hooks/useChatStream";
import { apiFetch } from "../../lib/api";
import { IconChevronLeft } from "../../ui/icons";
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
	const [mobileOpen, setMobileOpen] = useState(false);

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
		setMobileOpen(true);
	}

	async function createConversation() {
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

	const mainClasses = ["chat-main", mobileOpen ? null : "chat-main-hidden"]
		.filter(Boolean)
		.join(" ");

	return (
		<div className="chat-view">
			<ConversationList
				state={listState}
				activeId={activeId}
				hidden={mobileOpen}
				onSelect={openConversation}
				onNew={createConversation}
			/>
			<div className={mainClasses}>
				<div className="chat-back-bar">
					<button type="button" className="chat-back-button" onClick={() => setMobileOpen(false)}>
						<IconChevronLeft width={18} height={18} />
						Conversations
					</button>
				</div>
				<MessageList items={items} activeId={activeId} onResolveConfirm={resolveConfirm} />
				<Composer onSend={send} disabled={sending} />
			</div>
		</div>
	);
}
