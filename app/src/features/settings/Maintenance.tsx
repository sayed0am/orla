/** Maintenance section: last reorganization run + on-demand run. Port of brief.js's F3
 * maintenance section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import GlassCard from "../../ui/GlassCard";
import { formatDateTime } from "./format";

interface ReorganizeRun {
	status: string;
	started_at: string;
	finished_at?: string | null;
	notes_ok?: number;
	notes_failed?: number;
	error?: string | null;
}

function formatRunResult(run: ReorganizeRun): string {
	if (run.status === "ok") {
		return `ok: ${run.notes_ok ?? 0} notes organized`;
	}
	if (run.status === "partial") {
		return `partial: ${run.notes_ok ?? 0} ok, ${run.notes_failed ?? 0} quarantined`;
	}
	if (run.status === "failed") {
		return `failed: ${run.error ?? "unknown error"}`;
	}
	return run.status;
}

export default function Maintenance() {
	const [lastRun, setLastRun] = useState<ReorganizeRun | null | undefined>(undefined);
	const [loadError, setLoadError] = useState(false);
	const [runBusy, setRunBusy] = useState(false);
	const destroyedRef = useRef(false);

	const load = useCallback(async () => {
		setLastRun(undefined);
		setLoadError(false);
		let res: Response;
		try {
			res = await apiFetch("/api/reorganize/runs?limit=1");
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("settings: failed to load reorganization runs", err);
			if (!destroyedRef.current) {
				setLoadError(true);
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		const data = (await res.json()) as { runs?: ReorganizeRun[] };
		setLastRun((data.runs ?? [])[0] ?? null);
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		load();
		return () => {
			destroyedRef.current = true;
		};
	}, [load]);

	async function runNow() {
		setRunBusy(true);
		try {
			const res = await apiFetch("/api/reorganize/run", { method: "POST" });
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("settings: failed to run reorganization", err);
		} finally {
			if (!destroyedRef.current) {
				await load();
				setRunBusy(false);
			}
		}
	}

	return (
		<GlassCard title="Maintenance" collapsible>
			{lastRun === undefined && !loadError ? <p className="hint">Loading…</p> : null}
			{loadError ? <p className="hint">Couldn't load reorganization status.</p> : null}
			{!loadError && lastRun !== undefined ? (
				<>
					<p className="maintenance-last-run">
						{lastRun
							? `Last run: ${formatDateTime(lastRun.finished_at ?? lastRun.started_at)} — ${formatRunResult(lastRun)}`
							: "No reorganization runs yet."}
					</p>
					<Button variant="primary" disabled={runBusy} onClick={runNow}>
						{runBusy ? "Organizing…" : "Organize notes now"}
					</Button>
				</>
			) : null}
		</GlassCard>
	);
}
