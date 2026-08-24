/** One user/assistant turn. Port of chat.js's `appendBubble` + `renderAssistantContent`. */

import type { MessageItem } from "../../hooks/useChatStream";
import { renderMarkdown } from "../../lib/markdown.js";

interface MessageBubbleProps {
	item: MessageItem;
}

export default function MessageBubble({ item }: MessageBubbleProps) {
	if (item.role === "user") {
		return <div className="glass bubble user">{item.text}</div>;
	}

	return (
		<div className="glass bubble assistant">
			<div
				className="md"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown (app/src/lib/markdown.js) escapes every text node and only ever emits http(s)/mailto link targets.
				dangerouslySetInnerHTML={{
					__html: renderMarkdown(item.text, { streaming: item.streaming }),
				}}
			/>
		</div>
	);
}
