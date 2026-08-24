/** The daily brief as a bottom day-sheet over Jot (PRD F4) — replaces the old Brief tab.
 * Reuses BriefCard (day ‹ › nav + markdown body) and ActionItems unchanged. */

import Sheet from "../../ui/Sheet";
import "./brief.css";
import ActionItems from "./ActionItems";
import BriefCard from "./BriefCard";

interface BriefSheetProps {
	open: boolean;
	onClose: () => void;
}

export default function BriefSheet({ open, onClose }: BriefSheetProps) {
	return (
		<Sheet open={open} onClose={onClose}>
			<BriefCard />
			<p className="label brief-section-title">Open action items</p>
			<ActionItems />
		</Sheet>
	);
}
