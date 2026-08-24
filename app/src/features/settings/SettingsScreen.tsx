import { useTheme } from "../../hooks/useTheme";
import GlassCard from "../../ui/GlassCard";
import SegmentedTabs from "../../ui/SegmentedTabs";

interface SettingsScreenProps {
	sub?: "raw" | "costs";
}

const THEME_OPTIONS = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

// `sub` will drive the Costs view in a later step; unused here.
export default function SettingsScreen(_props: SettingsScreenProps) {
	const { theme, setTheme } = useTheme();

	return (
		<div className="screen">
			<GlassCard title="Appearance">
				<div className="settings-row">
					<span>Theme</span>
					<SegmentedTabs
						options={THEME_OPTIONS}
						value={theme}
						onChange={(value) => setTheme(value === "dark" ? "dark" : "light")}
					/>
				</div>
			</GlassCard>
			<GlassCard>More settings coming soon</GlassCard>
		</div>
	);
}
