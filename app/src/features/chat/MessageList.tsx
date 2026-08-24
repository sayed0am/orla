/**
 * Scrollable transcript. Port of chat.js's `#chat-messages` scroll behavior: auto-scrolls to the
 * bottom on new content unless the user has scrolled up more than 40px, and always snaps to the
 * bottom when switching conversations.
 */

import { useEffect, useRef } from "react";
import type { ConfirmItem, TranscriptItem } from "../../hooks/useChatStream";
import ConfirmCard from "./ConfirmCard";
import MessageBubble from "./MessageBubble";
import ToolChip from "./ToolChip";

interface MessageListProps {
	items: TranscriptItem[];
	activeId: string | null;
	onResolveConfirm: (item: ConfirmItem, allow: boolean) => void;
}

export default function MessageList({ items, activeId, onResolveConfirm }: MessageListProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const userScrolledUpRef = useRef(false);

	// Switching conversations resets the "user scrolled up" state, matching chat.js's
	// `openConversation` (`userScrolledUp = false`) so the newly loaded history is force-scrolled
	// to the bottom below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: must reset the ref on every `activeId` change, even though the effect body doesn't read `activeId` itself.
	useEffect(() => {
		userScrolledUpRef.current = false;
	}, [activeId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: must re-run on every `items` change to re-check scroll position, even though the effect body reads the DOM, not `items`.
	useEffect(() => {
		const el = containerRef.current;
		if (!el || userScrolledUpRef.current) {
			return;
		}
		el.scrollTop = el.scrollHeight;
	}, [items]);

	function handleScroll() {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		userScrolledUpRef.current = distanceFromBottom > 40;
	}

	return (
		<div className="messages" ref={containerRef} onScroll={handleScroll}>
			{items.map((item) => {
				switch (item.kind) {
					case "message":
						return <MessageBubble key={item.id} item={item} />;
					case "tool":
						return <ToolChip key={item.id} item={item} />;
					case "confirm":
						return <ConfirmCard key={item.id} item={item} onResolve={onResolveConfirm} />;
					case "error":
						return (
							<div key={item.id} className="bubble error">
								{item.text}
							</div>
						);
					default:
						return null;
				}
			})}
		</div>
	);
}
