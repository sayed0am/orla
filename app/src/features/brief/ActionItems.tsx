/** Open action items list: due-date pill + Done/Dismiss with optimistic remove. Port of brief.js's
 * action items section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import Chip from "../../ui/Chip";
import { formatDueDate, isOverdue } from "./format";

interface ActionItem {
	id: string;
	text: string;
	due_date: string | null;
}

export default function ActionItems() {
	const [items, setItems] = useState<ActionItem[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const itemsRef = useRef<ActionItem[] | null>(null);
	itemsRef.current = items;
	const destroyedRef = useRef(false);

	const load = useCallback(async () => {
		setLoadError(false);
		let res: Response;
		try {
			res = await apiFetch("/api/action-items?status=open&due=all");
		} catch (err) {
			console.error("brief: failed to load action items", err);
			if (!destroyedRef.current) {
				setItems(null);
				setLoadError(true);
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		if (!res.ok) {
			setItems(null);
			setLoadError(true);
			return;
		}
		const data = (await res.json()) as { items?: ActionItem[] };
		setItems(data.items ?? []);
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		load();
		return () => {
			destroyedRef.current = true;
		};
	}, [load]);

	async function updateStatus(id: string, status: "done" | "dismissed") {
		const current = itemsRef.current ?? [];
		const idx = current.findIndex((item) => item.id === id);
		const removed = idx === -1 ? undefined : current[idx];
		if (idx === -1 || !removed) {
			return;
		}
		setItems(current.filter((item) => item.id !== id));
		try {
			const res = await apiFetch(`/api/action-items/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("brief: failed to update action item", err);
			if (!destroyedRef.current) {
				setItems((prev) => {
					const next = [...(prev ?? [])];
					next.splice(idx, 0, removed);
					return next;
				});
			}
		}
	}

	return (
		<div className="brief-action-items">
			{items === null && !loadError ? <p className="hint">Loading…</p> : null}
			{loadError ? <p className="hint">Couldn't load action items.</p> : null}
			{items !== null && items.length === 0 ? <p className="hint">No open action items.</p> : null}
			{items !== null && items.length > 0
				? items.map((item) => (
						<div className="glass action-item-row" key={item.id}>
							<div className="action-item-text">{item.text}</div>
							{item.due_date ? (
								<Chip tone={isOverdue(item.due_date) ? "danger" : undefined}>
									{formatDueDate(item.due_date)}
								</Chip>
							) : null}
							<div className="action-item-actions">
								<Button variant="ghost" onClick={() => updateStatus(item.id, "done")}>
									✓ Done
								</Button>
								<Button variant="ghost" onClick={() => updateStatus(item.id, "dismissed")}>
									✕ Dismiss
								</Button>
							</div>
						</div>
					))
				: null}
		</div>
	);
}
