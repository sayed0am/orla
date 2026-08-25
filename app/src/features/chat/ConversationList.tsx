/** Chat sidebar (PRD F1): "Recents" heading + conversation list. Port of chat.js's list pane. */

export interface ConversationSummary {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}

export type ConversationListState =
	| { status: "loading" }
	| { status: "unavailable"; message: string }
	| { status: "ready"; conversations: ConversationSummary[] };

interface ConversationListProps {
	state: ConversationListState;
	activeId: string | null;
	hidden: boolean;
	onSelect: (id: string) => void;
}

function formatTimestamp(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

export default function ConversationList({
	state,
	activeId,
	hidden,
	onSelect,
}: ConversationListProps) {
	const classes = ["chat-list", hidden ? "chat-list-hidden" : null].filter(Boolean).join(" ");

	return (
		<div className={classes}>
			<p className="label chat-list-heading">Recents</p>
			<div className="chat-list-items">
				{state.status === "unavailable" ? (
					<p className="hint chat-list-hint">{state.message}</p>
				) : state.status === "ready" && state.conversations.length === 0 ? (
					<p className="hint chat-list-hint">No conversations yet.</p>
				) : state.status === "ready" ? (
					state.conversations.map((conversation) => {
						const isActive = conversation.id === activeId;
						const classNames = ["chat-list-item", isActive ? "active" : null]
							.filter(Boolean)
							.join(" ");
						return (
							<button
								key={conversation.id}
								type="button"
								className={classNames}
								title={formatTimestamp(conversation.updated_at)}
								onClick={() => onSelect(conversation.id)}
							>
								{conversation.title || "Untitled"}
							</button>
						);
					})
				) : null}
			</div>
		</div>
	);
}
