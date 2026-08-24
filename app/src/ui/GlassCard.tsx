import type { ReactNode } from "react";

interface GlassCardProps {
	title?: string;
	className?: string;
	/** Render as a <details> disclosure with the title as its summary row. */
	collapsible?: boolean;
	/** collapsible only: start expanded. */
	defaultOpen?: boolean;
	children?: ReactNode;
}

export default function GlassCard({
	title,
	className,
	collapsible,
	defaultOpen,
	children,
}: GlassCardProps) {
	const classes = ["glass", "card", className].filter(Boolean).join(" ");

	if (collapsible && title) {
		return (
			<details className={classes} open={defaultOpen}>
				<summary className="card-title">{title}</summary>
				<div className="card-body">{children}</div>
			</details>
		);
	}

	return (
		<section className={classes}>
			{title ? <h2 className="card-title">{title}</h2> : null}
			{children}
		</section>
	);
}
