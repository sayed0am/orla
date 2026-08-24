/** Daily brief hero card: date navigation + markdown brief body. Port of brief.js's brief section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { renderMarkdown } from "../../lib/markdown.js";
import Button from "../../ui/Button";
import GlassCard from "../../ui/GlassCard";
import { IconChevronLeft, IconChevronRight } from "../../ui/icons";
import { formatDateLabel, shiftDate, todayUtc } from "./format";

type BriefView =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "not-found" }
	| { kind: "loaded"; bodyMd: string };

interface BriefResponse {
	brief: { body_md: string };
}

export default function BriefCard() {
	const [currentDate, setCurrentDate] = useState(todayUtc);
	const [view, setView] = useState<BriefView>({ kind: "loading" });
	const [buildBusy, setBuildBusy] = useState(false);
	const destroyedRef = useRef(false);

	const loadBrief = useCallback(async (date: string) => {
		setView({ kind: "loading" });
		let res: Response;
		try {
			res = await apiFetch(`/api/brief?date=${date}`);
		} catch (err) {
			console.error("brief: failed to load", err);
			if (!destroyedRef.current) {
				setView({ kind: "error" });
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		if (res.status === 404) {
			setView({ kind: "not-found" });
			return;
		}
		if (!res.ok) {
			setView({ kind: "error" });
			return;
		}
		const data = (await res.json()) as BriefResponse;
		if (!destroyedRef.current) {
			setView({ kind: "loaded", bodyMd: data.brief.body_md });
		}
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		loadBrief(currentDate);
		return () => {
			destroyedRef.current = true;
		};
	}, [currentDate, loadBrief]);

	async function buildNow() {
		setBuildBusy(true);
		try {
			const res = await apiFetch("/api/brief/run", { method: "POST" });
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyedRef.current) {
				await loadBrief(currentDate);
			}
		} catch (err) {
			console.error("brief: failed to build", err);
		} finally {
			if (!destroyedRef.current) {
				setBuildBusy(false);
			}
		}
	}

	const today = todayUtc();
	const isToday = currentDate === today;

	return (
		<GlassCard className="brief-hero">
			<div className="brief-date-nav">
				<Button
					variant="ghost"
					aria-label="Previous day"
					onClick={() => setCurrentDate((d) => shiftDate(d, -1))}
				>
					<IconChevronLeft />
				</Button>
				<span className="brief-date-label">{formatDateLabel(currentDate)}</span>
				<Button
					variant="ghost"
					aria-label="Next day"
					disabled={isToday}
					onClick={() => setCurrentDate((d) => (d < today ? shiftDate(d, 1) : d))}
				>
					<IconChevronRight />
				</Button>
			</div>
			{view.kind === "loading" ? <p className="hint">Loading…</p> : null}
			{view.kind === "error" ? <p className="hint">Couldn't load the brief.</p> : null}
			{view.kind === "not-found" ? (
				<>
					<p className="hint">{isToday ? "No brief yet for today." : "No brief for this day."}</p>
					{isToday ? (
						<Button variant="primary" disabled={buildBusy} onClick={buildNow}>
							{buildBusy ? "Building…" : "Build now"}
						</Button>
					) : null}
				</>
			) : null}
			{view.kind === "loaded" ? (
				<div
					className="md"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown (app/src/lib/markdown.js) escapes every text node; body_md is trusted, app-generated markdown, same renderer as chat replies.
					dangerouslySetInnerHTML={{ __html: renderMarkdown(view.bodyMd) }}
				/>
			) : null}
		</GlassCard>
	);
}
