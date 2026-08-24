import GlassCard from "../../ui/GlassCard";

interface SettingsScreenProps {
	sub?: "raw" | "costs";
}

// `sub` will drive the Costs view in a later step; unused here.
export default function SettingsScreen(_props: SettingsScreenProps) {
	return (
		<div className="screen">
			<GlassCard title="Settings">Coming soon</GlassCard>
		</div>
	);
}
