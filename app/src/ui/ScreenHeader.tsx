/** Shared screen header: a left slot, centered content, and a right slot — used by the home
 * shell's mode switcher, the Settings topbar, and the Chat threads header. */

import type { ReactNode } from "react";

interface ScreenHeaderProps {
	/** Top-left control (back link, icon button). */
	left?: ReactNode;
	/** Centered content (title label or mode switcher). */
	center?: ReactNode;
	/** Top-right control (settings gear, etc.). */
	right?: ReactNode;
}

export default function ScreenHeader({ left, center, right }: ScreenHeaderProps) {
	return (
		<header className="screen-header">
			<div className="screen-header-slot">{left}</div>
			<div className="screen-header-center">{center}</div>
			<div className="screen-header-slot screen-header-right">{right}</div>
		</header>
	);
}
