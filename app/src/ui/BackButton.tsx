/** Back control for screen headers: a bordered icon square matching the other `.icon-btn` header controls. */

import { IconChevronLeft } from "./icons";

interface BackButtonProps {
	/** Navigate on click (renders an anchor). */
	href?: string;
	/** Handler (renders a button) — used when there's no hash navigation. */
	onClick?: () => void;
}

export default function BackButton({ href, onClick }: BackButtonProps) {
	if (href) {
		return (
			<a className="icon-btn" href={href} aria-label="Back">
				<IconChevronLeft width={18} height={18} />
			</a>
		);
	}

	return (
		<button type="button" className="icon-btn" aria-label="Back" onClick={onClick}>
			<IconChevronLeft width={18} height={18} />
		</button>
	);
}
