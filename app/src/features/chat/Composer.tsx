/**
 * Message input (PRD F1). Port of chat.js's `#chat-input`/`#chat-send`: a floating glass pill with
 * an auto-growing (1–4 row) textarea and a circular send Fab, Cmd/Ctrl+Enter to send.
 */

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import Fab from "../../ui/Fab";
import { IconSend } from "../../ui/icons";

const MAX_ROWS = 4;

interface ComposerProps {
	onSend: (text: string) => void;
	/** Mirrors chat.js's `sendButton.disabled` — true only while a send is in flight. */
	disabled: boolean;
}

export default function Composer({ onSend, disabled }: ComposerProps) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-grow the textarea from 1 to MAX_ROWS lines, then let it scroll internally.
	// biome-ignore lint/correctness/useExhaustiveDependencies: must re-run on every `value` change to re-measure scrollHeight, even though the effect body reads the DOM element, not `value`.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
		const maxHeight = lineHeight * MAX_ROWS;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [value]);

	function submit() {
		const text = value.trim();
		if (text.length === 0 || disabled) {
			return;
		}
		setValue("");
		onSend(text);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			submit();
		}
	}

	return (
		<div className="glass composer">
			<textarea
				ref={textareaRef}
				className="composer-input"
				placeholder="Message Orla…"
				rows={1}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={onKeyDown}
			/>
			<Fab aria-label="Send" disabled={disabled || value.trim().length === 0} onClick={submit}>
				<IconSend />
			</Fab>
		</div>
	);
}
