import type { MouseEventHandler, ReactNode } from "react";

interface ChipProps {
	tone?: "green" | "lilac" | "danger";
	children?: ReactNode;
	onClick?: MouseEventHandler<HTMLButtonElement | HTMLSpanElement>;
}

export default function Chip({ tone, children, onClick }: ChipProps) {
	const classes = ["chip", tone ? `chip-${tone}` : null].filter(Boolean).join(" ");
	if (onClick) {
		return (
			<button type="button" className={classes} onClick={onClick}>
				{children}
			</button>
		);
	}
	return <span className={classes}>{children}</span>;
}
