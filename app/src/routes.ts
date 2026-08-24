/** Hash-based route parsing for the Orla app shell (ports public/app.js#tabFromHash). */

export type Tab = "capture" | "chat" | "brief" | "journal" | "settings";

export interface Route {
	tab: Tab;
	sub?: "raw" | "costs";
}

const TABS: readonly Tab[] = ["capture", "chat", "brief", "journal", "settings"];

/** "#notes" is a legacy alias (old bookmarks, the service worker shell) for Journal's Raw view. */
const NOTES_ALIAS = "notes";

/** "#costs" is a legacy alias for the Costs sub-view, now folded into Settings. */
const COSTS_ALIAS = "costs";

export function routeFromHash(hash: string): Route {
	const bare = hash.replace(/^#/, "");
	if (bare === NOTES_ALIAS) {
		return { tab: "journal", sub: "raw" };
	}
	if (bare === COSTS_ALIAS) {
		return { tab: "settings", sub: "costs" };
	}
	if ((TABS as readonly string[]).includes(bare)) {
		return { tab: bare as Tab };
	}
	return { tab: "capture" };
}
