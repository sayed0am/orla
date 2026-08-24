/** Chat sidebar (PRD F1): conversation list + "New" button. Port of chat.js's list pane. */

import Button from "../../ui/Button";

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
	onNew: () => void;
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
	onNew,
}: ConversationListProps) {
	const classes = ["chat-list", hidden ? "chat-list-hidden" : null].filter(Boolean).join(" ");

	return (
		<div className={classes}>
			<Button
				variant="primary"
				className="chat-list-new"
				disabled={state.status === "unavailable"}
				onClick={onNew}
			>
				New
			</Button>
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
