/** Settings tab: Appearance, Notifications, Maintenance, Memory, Passkeys (passkey mode only),
 * MCP servers, and Costs. Everything but Appearance is a port of sections that used to live in
 * public/brief.js (F4) and public/costs.js. */

import { useEffect, useRef } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";
import GlassCard from "../../ui/GlassCard";
import SegmentedTabs from "../../ui/SegmentedTabs";
import Costs from "./Costs";
import Maintenance from "./Maintenance";
import McpServers from "./McpServers";
import MemoryFacts from "./MemoryFacts";
import Passkeys from "./Passkeys";
import PushSettings from "./PushSettings";
import "./settings.css";

interface SettingsScreenProps {
	sub?: "raw" | "costs";
}

const THEME_OPTIONS = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export default function SettingsScreen({ sub }: SettingsScreenProps) {
	const { theme, setTheme } = useTheme();
	const { status } = useAuth();
	const costsRef = useRef<HTMLDivElement>(null);

	// Legacy `#costs` hash aliases here (see app/src/routes.ts) — scroll the Costs card into view.
	useEffect(() => {
		if (sub === "costs") {
			costsRef.current?.scrollIntoView({ block: "start" });
		}
	}, [sub]);

	return (
		<div className="screen">
			<div className="settings-sections">
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
				<PushSettings />
				<Maintenance />
				<MemoryFacts />
				{status?.mode === "passkey" ? <Passkeys /> : null}
				<McpServers />
				<div ref={costsRef}>
					<Costs />
				</div>
			</div>
		</div>
	);
}
