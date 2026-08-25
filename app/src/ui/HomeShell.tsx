/** Home shell for the three modes (Jot/Chat/Journal): a ‹ › header that cycles between Jot and
 * Chat, with Journal reached separately (book icon in, back link out); the mode screen body; and
 * the pill-dot indicator. Replaces the old bottom tab bar. */

import { type ReactNode, useEffect } from "react";
import { IconChevronLeft, IconChevronRight, IconSettings } from "./icons";
import ModeDots from "./ModeDots";
import ScreenHeader from "./ScreenHeader";

type Mode = "capture" | "chat" | "journal";

interface HomeShellProps {
	mode: Mode;
	/** Pending chat actions, surfaced on the chat mode dot. */
	badge?: number;
	/** Header top-left control (book icon on Jot, back link on Journal). */
	leftSlot?: ReactNode;
	/** Extra header control rendered before the settings gear (e.g. Journal's export menu). */
	rightSlot?: ReactNode;
	children?: ReactNode;
}

const MODES = [
	{ tab: "capture", label: "Jot" },
	{ tab: "chat", label: "Chat" },
] as const;

const MODE_LABELS: Record<Mode, string> = { capture: "Jot", chat: "Chat", journal: "Journal" };

export default function HomeShell({
	mode,
	badge = 0,
	leftSlot,
	rightSlot,
	children,
}: HomeShellProps) {
	const index = Math.max(
		0,
		MODES.findIndex((m) => m.tab === mode),
	);
	const prev = MODES[(index + MODES.length - 1) % MODES.length] ?? MODES[0];
	const next = MODES[(index + 1) % MODES.length] ?? MODES[0];

	// Drives the mode-tinted page background (base.css's body[data-mode] rules).
	useEffect(() => {
		document.body.dataset.mode = mode;
		return () => {
			delete document.body.dataset.mode;
		};
	}, [mode]);

	// Journal sits outside the Jot ↔ Chat cycle (book icon in, back button out): no arrows, no dots.
	const showArrows = mode !== "journal";

	return (
		<div className="home-shell">
			<ScreenHeader
				left={leftSlot}
				center={
					<div className="mode-switcher">
						{showArrows ? (
							<a className="mode-arrow" href={`#${prev.tab}`} aria-label={`${prev.label} mode`}>
								<IconChevronLeft width={18} height={18} />
							</a>
						) : null}
						<span className="mode-label">{MODE_LABELS[mode]}</span>
						{showArrows ? (
							<a className="mode-arrow" href={`#${next.tab}`} aria-label={`${next.label} mode`}>
								<IconChevronRight width={18} height={18} />
							</a>
						) : null}
					</div>
				}
				right={
					<>
						{rightSlot}
						<a className="icon-btn" href="#settings" aria-label="Settings">
							<IconSettings width={16} height={16} />
						</a>
					</>
				}
			/>
			<div className="home-body">{children}</div>
			{showArrows ? <ModeDots active={mode === "chat" ? "chat" : "capture"} badge={badge} /> : null}
		</div>
	);
}
