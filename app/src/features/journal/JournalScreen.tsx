/**
 * Journal tab: Organized/Raw sub-tabs. React port of `public/journal.js`'s `mountJournal` shell —
 * the two panes themselves live in `OrganizedView.tsx` and `RawNotes.tsx` (the latter a port of
 * `public/notes.js`).
 */

import { useEffect, useState } from "react";
import SegmentedTabs from "../../ui/SegmentedTabs";
import "./journal.css";
import OrganizedView from "./OrganizedView";
import RawNotes from "./RawNotes";

interface JournalScreenProps {
	sub?: "raw" | "costs";
}

type SubTab = "organized" | "raw";

export default function JournalScreen({ sub }: JournalScreenProps) {
	const [tab, setTab] = useState<SubTab>(sub === "raw" ? "raw" : "organized");

	// The `#notes` hash alias (legacy bookmarks, the service worker shell) drives `sub` from
	// outside — react to it changing while this screen stays mounted.
	useEffect(() => {
		setTab(sub === "raw" ? "raw" : "organized");
	}, [sub]);

	return (
		<div className="screen">
			<SegmentedTabs
				options={[
					{ value: "organized", label: "Organized" },
					{ value: "raw", label: "Raw" },
				]}
				value={tab}
				onChange={(value) => setTab(value === "raw" ? "raw" : "organized")}
			/>
			{/* Organized stays mounted (its filters/pagination shouldn't reset on a sub-tab flip);
			    Raw remounts each time it's shown, matching public/journal.js's lazy mount/unmount. */}
			<div hidden={tab !== "organized"}>
				<OrganizedView />
			</div>
			{tab === "raw" ? <RawNotes /> : null}
		</div>
	);
}
