/** Instant capture box (PRD F2, G1: perceived save under 2s, works offline). Port of public/capture.js. */

import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	addToOutbox,
	type FlushResult,
	flushOutbox,
	listFailed,
	listOutbox,
	type OutboxItem,
} from "../../../sw/outbox.js";
import Chip from "../../ui/Chip";
import Fab from "../../ui/Fab";
import { IconSend } from "../../ui/icons";
import BriefSheet from "../brief/BriefSheet";
import "./capture.css";

interface SyncRegistration extends ServiceWorkerRegistration {
	sync: { register(tag: string): Promise<void> };
}

let flushInFlight: Promise<FlushResult> | null = null;

/** Runs a flush, coalescing concurrent callers into one in-flight request. */
function flushOnce(): Promise<FlushResult> {
	if (!flushInFlight) {
		flushInFlight = flushOutbox().finally(() => {
			flushInFlight = null;
		});
	}
	return flushInFlight;
}

interface CaptureScreenProps {
	/** True when the route is #brief — Jot with the brief day-sheet open. */
	briefOpen?: boolean;
}

export default function CaptureScreen({ briefOpen = false }: CaptureScreenProps) {
	const [body, setBody] = useState("");
	const [isPrivate, setIsPrivate] = useState(false);
	const [pendingCount, setPendingCount] = useState(0);
	const [failedCount, setFailedCount] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const mountedRef = useRef(true);

	const refreshCounts = useCallback(async () => {
		const [pending, failed] = await Promise.all([listOutbox(), listFailed()]);
		if (!mountedRef.current) {
			return;
		}
		setPendingCount(pending.length);
		setFailedCount(failed.length);
	}, []);

	async function save() {
		const trimmed = body.trim();
		if (trimmed.length === 0) {
			return;
		}

		const item: OutboxItem = {
			client_id: crypto.randomUUID(),
			body: trimmed,
			private: isPrivate,
			created_at: new Date().toISOString(),
		};

		// Clear immediately — the UI must never wait on the network (G1).
		setBody("");
		setIsPrivate(false);
		textareaRef.current?.focus();

		await addToOutbox(item);
		await refreshCounts();

		flushOnce()
			.then(refreshCounts)
			.catch((err) => console.error("capture: flush failed", err));

		if ("serviceWorker" in navigator && "SyncManager" in window) {
			try {
				const registration = (await navigator.serviceWorker.ready) as SyncRegistration;
				await registration.sync.register("flush-notes");
			} catch (err) {
				console.error("capture: background sync registration failed", err);
			}
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			save();
		}
	}

	useEffect(() => {
		mountedRef.current = true;
		textareaRef.current?.focus();

		function onOnline() {
			flushOnce().then(refreshCounts);
		}
		function onVisible() {
			if (document.visibilityState === "visible") {
				flushOnce().then(refreshCounts);
			}
		}

		window.addEventListener("online", onOnline);
		document.addEventListener("visibilitychange", onVisible);

		refreshCounts();
		flushOnce()
			.then(refreshCounts)
			.catch((err) => console.error("capture: initial flush failed", err));

		return () => {
			mountedRef.current = false;
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refreshCounts]);

	return (
		<div className="capture-view">
			<button
				type="button"
				className="glass capture-brief-pill"
				onClick={() => {
					window.location.hash = "#brief";
				}}
			>
				Today's brief ›
			</button>
			<textarea
				ref={textareaRef}
				id="capture-body"
				className="glass capture-textarea"
				placeholder="type or paste anything…"
				rows={1}
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={onKeyDown}
			/>
			{/* Visual-only for now — the outbox schema has no tags field yet. */}
			<div className="capture-tags-row">
				<span className="chip">#idea</span>
				<span className="chip">#todo</span>
				<span className="chip chip-add">+ add tag</span>
			</div>
			<div className="capture-footer">
				<button
					type="button"
					className={`chip capture-private-toggle${isPrivate ? " chip-lilac" : ""}`}
					aria-pressed={isPrivate}
					onClick={() => setIsPrivate((v) => !v)}
				>
					Private
				</button>
				<span className="capture-hint hint">Cmd/Ctrl+Enter to save</span>
				{pendingCount > 0 ? <Chip tone="green">{pendingCount} pending</Chip> : null}
				{failedCount > 0 ? <Chip tone="danger">{failedCount} failed</Chip> : null}
				<span className="capture-spacer" />
				<Fab aria-label="Save" onClick={save}>
					<IconSend />
				</Fab>
			</div>
			<BriefSheet
				open={briefOpen}
				onClose={() => {
					window.location.replace("#capture");
				}}
			/>
		</div>
	);
}
