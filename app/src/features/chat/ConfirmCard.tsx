/**
 * `event: confirm` from the stream (PRD §12): an act-tier tool call awaiting tap-to-confirm. Port
 * of chat.js's `appendConfirmCard` — the card stays in place and swaps its action row for the
 * inline result line once resolved, rather than being replaced.
 */

import type { ConfirmItem } from "../../hooks/useChatStream";
import Button from "../../ui/Button";

interface ConfirmCardProps {
	item: ConfirmItem;
	onResolve: (item: ConfirmItem, allow: boolean) => void;
}

export default function ConfirmCard({ item, onResolve }: ConfirmCardProps) {
	return (
		<div className="glass confirm-card">
			<div className="confirm-card-name">🔧 {item.name}</div>
			<pre className="confirm-card-args">{JSON.stringify(item.arguments, null, 2)}</pre>
			{item.result ? (
				<div className="confirm-card-result">
					{item.result.text === "Not allowed." ? "✕" : "✓"} {item.result.text}
				</div>
			) : (
				<div className="confirm-card-actions">
					<Button variant="primary" disabled={item.resolving} onClick={() => onResolve(item, true)}>
						Allow
					</Button>
					<Button variant="ghost" disabled={item.resolving} onClick={() => onResolve(item, false)}>
						Don&apos;t allow
					</Button>
				</div>
			)}
		</div>
	);
}
