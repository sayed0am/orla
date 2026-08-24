interface StatTileProps {
	label: string;
	value: string;
	tone?: "lilac" | "green";
}

export default function StatTile({ label, value, tone }: StatTileProps) {
	const classes = ["stat-tile", tone ? `stat-${tone}` : null].filter(Boolean).join(" ");
	return (
		<div className={classes}>
			<span className="stat-value">{value}</span>
			<span className="stat-label">{label}</span>
		</div>
	);
}
