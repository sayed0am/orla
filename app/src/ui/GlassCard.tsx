import type { ReactNode } from "react";

interface GlassCardProps {
	title?: string;
	className?: string;
	children?: ReactNode;
}

export default function GlassCard({ title, className, children }: GlassCardProps) {
	const classes = ["glass", "card", className].filter(Boolean).join(" ");
	return (
		<section className={classes}>
			{title ? <h2 className="card-title">{title}</h2> : null}
			{children}
		</section>
	);
}
