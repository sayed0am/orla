/**
 * Pending act-tier actions count, shown as a badge on the Chat tab (PRD §12 tap-to-confirm). Port
 * of chat.js's `loadActionsBadge`, lifted out of the Chat screen so the chat mode dot can show it
 * even when Chat isn't the active screen.
 *
 * Every mounted consumer fetches independently on mount, and all of them refetch together whenever
 * `notifyPendingActionsChanged` is called — a plain module-level listener set is the simplest thing
 * that works here: there's no shared state to keep in sync, just a "go recheck" signal, and the
 * app only ever has one `App` shell and one `ChatScreen` mounted at a time.
 */

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Listener = () => void;

const listeners = new Set<Listener>();

/** Tells every mounted `usePendingActions` consumer to refetch (e.g. after resolving a confirm). */
export function notifyPendingActionsChanged(): void {
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Fetches `GET /api/actions?status=pending` and returns the pending count, kept in sync. Pass
 * `enabled: false` to skip fetching (e.g. before auth resolves) without violating rules-of-hooks.
 */
export function usePendingActions(enabled = true): number {
	const [count, setCount] = useState(0);

	const refresh = useCallback(async () => {
		let res: Response;
		try {
			res = await apiFetch("/api/actions?status=pending");
		} catch (err) {
			console.error("chat: failed to load pending actions", err);
			return;
		}
		if (!res.ok) {
			return;
		}
		const data = (await res.json()) as { actions?: unknown[] };
		setCount(data.actions?.length ?? 0);
	}, []);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		listeners.add(refresh);
		refresh();
		return () => {
			listeners.delete(refresh);
		};
	}, [refresh, enabled]);

	return count;
}
