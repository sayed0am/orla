/** Brief tab: today's daily brief + open action items (PRD F4). Notifications/Maintenance/Memory/
 * Passkeys/MCP servers/Costs live in Settings — see app/src/features/settings/SettingsScreen.tsx. */

import "./brief.css";
import ActionItems from "./ActionItems";
import BriefCard from "./BriefCard";

export default function BriefScreen() {
	return (
		<div className="screen">
			<BriefCard />
			<h2 className="card-title brief-section-title">Action items</h2>
			<ActionItems />
		</div>
	);
}
