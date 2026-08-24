/** Home shell for the three modes (Jot/Chat/Journal): ‹ › mode-cycling header with a settings
 * gear, the mode screen body, and the pill-dot indicator. Replaces the old bottom tab bar. */

import { type ReactNode, useEffect } from "react";
import { IconChevronLeft, IconChevronRight, IconSettings } from "./icons";
import ModeDots from "./ModeDots";

type Mode = "capture" | "chat" | "journal";

interface HomeShellProps {
	mode: Mode;
	/** Pending chat actions, surfaced on the chat mode dot. */
	badge?: number;
	/** Header top-left control (book icon on Jot, back link on Journal). */
	leftSlot?: ReactNode;
	children?: ReactNode;
}

const MODES = [
	{ tab: "capture", label: "Jot" },
	{ tab: "chat", label: "Chat" },
	{ tab: "journal", label: "Journal" },
] as const;

export default function HomeShell({ mode, badge = 0, leftSlot, children }: HomeShellProps) {
	const index = Math.max(
		0,
		MODES.findIndex((m) => m.tab === mode),
	);
	const current = MODES[index] ?? MODES[0];
	const prev = MODES[(index + MODES.length - 1) % MODES.length] ?? MODES[0];
	const next = MODES[(index + 1) % MODES.length] ?? MODES[0];

	// Drives the mode-tinted page background (base.css's body[data-mode] rules).
	useEffect(() => {
		document.body.dataset.mode = mode;
		return () => {
			delete document.body.dataset.mode;
		};
	}, [mode]);

	// Journal is the end of the cycle in the prototype: back link instead of arrows, no dots.
	const showArrows = mode !== "journal";

	return (
		<div className="home-shell">
			<header className="home-header">
				<div className="home-header-slot">{leftSlot}</div>
				<div className="mode-switcher">
					{showArrows ? (
						<a className="mode-arrow" href={`#${prev.tab}`} aria-label={`${prev.label} mode`}>
							<IconChevronLeft width={18} height={18} />
						</a>
					) : null}
					<span className="mode-label">{current.label}</span>
					{showArrows ? (
						<a className="mode-arrow" href={`#${next.tab}`} aria-label={`${next.label} mode`}>
							<IconChevronRight width={18} height={18} />
						</a>
					) : null}
				</div>
				<div className="home-header-slot home-header-right">
					<a className="icon-btn" href="#settings" aria-label="Settings">
						<IconSettings width={16} height={16} />
					</a>
				</div>
			</header>
			<div className="home-body">{children}</div>
			{showArrows ? <ModeDots active={mode === "chat" ? "chat" : "capture"} badge={badge} /> : null}
		</div>
	);
}
