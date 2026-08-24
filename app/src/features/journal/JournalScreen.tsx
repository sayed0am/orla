import GlassCard from "../../ui/GlassCard";

interface JournalScreenProps {
	sub?: "raw" | "costs";
}

// `sub` will drive the Raw view in a later step; unused here.
export default function JournalScreen(_props: JournalScreenProps) {
	return (
		<div className="screen">
			<GlassCard title="Journal">Coming soon</GlassCard>
		</div>
	);
}
