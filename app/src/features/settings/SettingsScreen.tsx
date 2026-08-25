/** Settings screen: Appearance, then collapsible Notifications, Maintenance, Memory, Passkeys
 * (passkey mode only), MCP servers, and Costs sections. Everything but Appearance is a port of
 * sections that used to live in public/brief.js (F4) and public/costs.js. */

import type { Icon } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { useAuth } from "../../hooks/useAuth";
import { type Theme, useTheme } from "../../hooks/useTheme";
import BackButton from "../../ui/BackButton";
import GlassCard from "../../ui/GlassCard";
import { IconDeviceMobile, IconMoon, IconSunHigh } from "../../ui/icons";
import ScreenHeader from "../../ui/ScreenHeader";
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

const THEME_OPTIONS: { value: Theme; label: string; icon: Icon }[] = [
	{ value: "system", label: "System", icon: IconDeviceMobile },
	{ value: "light", label: "Light", icon: IconSunHigh },
	{ value: "dark", label: "Dark", icon: IconMoon },
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
			<ScreenHeader
				left={<BackButton href="#capture" />}
				center={<span className="label">Settings</span>}
			/>
			<div className="settings-sections">
				<GlassCard title="Appearance">
					<fieldset className="theme-swatches">
						<legend className="visually-hidden">Theme</legend>
						{THEME_OPTIONS.map(({ value, label, icon: ThemeIcon }) => (
							<label
								key={value}
								className={["theme-swatch", theme === value ? "theme-swatch-active" : null]
									.filter(Boolean)
									.join(" ")}
							>
								<input
									type="radio"
									name="theme"
									className="visually-hidden"
									checked={theme === value}
									onChange={() => setTheme(value)}
								/>
								<ThemeIcon width={20} height={20} />
								{label}
							</label>
						))}
					</fieldset>
				</GlassCard>
				<PushSettings />
				<Maintenance />
				<MemoryFacts />
				{status?.mode === "passkey" ? <Passkeys /> : null}
				<McpServers />
				<div ref={costsRef}>
					<Costs defaultOpen={sub === "costs"} />
				</div>
			</div>
		</div>
	);
}
