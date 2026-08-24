import Badge from "./Badge";

interface ModeDotsProps {
	active: "capture" | "chat";
	/** Pending chat actions — shown over the chat dot when chat isn't the active mode. */
	badge?: number;
}

const DOTS = [
	{ tab: "capture", label: "Jot" },
	{ tab: "chat", label: "Chat" },
] as const;

/** Pill-dot mode indicator under the home screens: active mode is an ink pill, the other a dot. */
export default function ModeDots({ active, badge = 0 }: ModeDotsProps) {
	return (
		<nav className="mode-dots" aria-label="Modes">
			{DOTS.map(({ tab, label }) => (
				<a
					key={tab}
					href={`#${tab}`}
					className={["mode-dot", tab === active ? "active" : null].filter(Boolean).join(" ")}
					aria-label={`${label} mode`}
					aria-current={tab === active ? "page" : undefined}
				>
					{tab === "chat" && active !== "chat" && badge > 0 ? (
						<span className="mode-dot-badge">
							<Badge count={badge} />
						</span>
					) : null}
				</a>
			))}
		</nav>
	);
}
