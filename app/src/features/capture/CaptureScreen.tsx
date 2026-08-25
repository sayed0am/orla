/** Instant capture box (PRD F2, G1: perceived save under 2s, works offline). Saved notes list on
 * top (Jot's analog of Chat's message transcript), tag chips + Private toggle above the shared
 * Composer pill. Port of public/capture.js. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	addToOutbox,
	type FlushResult,
	flushOutbox,
	listFailed,
	listOutbox,
	type OutboxItem,
} from "../../../sw/outbox.js";
import { apiFetch } from "../../lib/api";
import Chip from "../../ui/Chip";
import Composer from "../../ui/Composer";
import { IconChevronRight, IconLock } from "../../ui/icons";
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

interface JotNote {
	id: string; // server id or, for optimistic entries, the outbox client_id
	body: string;
	created_at: string;
	private: boolean;
}

function formatTimestamp(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

interface CaptureScreenProps {
	/** True when the route is #brief — Jot with the brief day-sheet open. */
	briefOpen?: boolean;
}

export default function CaptureScreen({ briefOpen = false }: CaptureScreenProps) {
	const [isPrivate, setIsPrivate] = useState(false);
	const [pendingItems, setPendingItems] = useState<OutboxItem[]>([]);
	const [failedCount, setFailedCount] = useState(0);
	const [serverNotes, setServerNotes] = useState<JotNote[]>([]);
	const mountedRef = useRef(true);

	const refreshCounts = useCallback(async () => {
		const [pending, failed] = await Promise.all([listOutbox(), listFailed()]);
		if (!mountedRef.current) {
			return;
		}
		setPendingItems(pending);
		setFailedCount(failed.length);
	}, []);

	// Fails silently (leaves the list as-is) — capture must stay usable offline.
	const loadNotes = useCallback(async () => {
		try {
			const res = await apiFetch("/api/notes?limit=50");
			if (!mountedRef.current || !res.ok) {
				return;
			}
			const data = (await res.json()) as { notes?: JotNote[] };
			if (!mountedRef.current) {
				return;
			}
			setServerNotes(data.notes ?? []);
		} catch (err) {
			console.error("capture: failed to load notes", err);
		}
	}, []);

	// After any flush, reload the server page BEFORE re-reading the outbox: flushed notes enter
	// `serverNotes` before they leave `pendingItems`, so they never blink out of the merged list.
	const flushAndReconcile = useCallback(() => {
		return flushOnce()
			.then(async () => {
				await loadNotes();
				await refreshCounts();
			})
			.catch((err) => console.error("capture: flush failed", err));
	}, [loadNotes, refreshCounts]);

	async function save(text: string) {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}

		const item: OutboxItem = {
			client_id: crypto.randomUUID(),
			body: trimmed,
			private: isPrivate,
			created_at: new Date().toISOString(),
		};

		setIsPrivate(false);

		await addToOutbox(item);
		await refreshCounts();

		flushAndReconcile();

		if ("serviceWorker" in navigator && "SyncManager" in window) {
			try {
				const registration = (await navigator.serviceWorker.ready) as SyncRegistration;
				await registration.sync.register("flush-notes");
			} catch (err) {
				console.error("capture: background sync registration failed", err);
			}
		}
	}

	useEffect(() => {
		mountedRef.current = true;

		function onOnline() {
			void flushAndReconcile();
		}
		function onVisible() {
			if (document.visibilityState === "visible") {
				void flushAndReconcile();
			}
		}

		window.addEventListener("online", onOnline);
		document.addEventListener("visibilitychange", onVisible);

		loadNotes();
		refreshCounts();
		flushAndReconcile();

		return () => {
			mountedRef.current = false;
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refreshCounts, loadNotes, flushAndReconcile]);

	// Pending outbox items are merged with the server page so queued/offline notes never drop out
	// of the list — `serverNotes` alone would clobber anything still in flight on a flush/reload.
	const pendingAsNotes: JotNote[] = pendingItems.map((item) => ({
		id: item.client_id,
		body: item.body,
		created_at: item.created_at,
		private: item.private,
	}));
	const notes = [...pendingAsNotes, ...serverNotes].sort((a, b) =>
		b.created_at.localeCompare(a.created_at),
	);

	return (
		<div className="capture-view">
			<button
				type="button"
				className="glass capture-brief-pill"
				onClick={() => {
					window.location.hash = "#brief";
				}}
			>
				Today's brief
				<IconChevronRight width={16} height={16} />
			</button>
			<div className="capture-notes">
				{notes.length === 0 ? (
					<div className="capture-empty">Jot something down…</div>
				) : (
					notes.map((note) => (
						<div key={note.id} className="capture-note">
							<div className="capture-note-body">{note.body}</div>
							<div className="capture-note-meta">
								<span>{formatTimestamp(note.created_at)}</span>
								{note.private ? (
									<span title="Private">
										<IconLock width={14} height={14} />
									</span>
								) : null}
							</div>
						</div>
					))
				)}
			</div>
			{/* Visual-only for now — the outbox schema has no tags field yet. */}
			<div className="capture-tags-row">
				<span className="chip">#idea</span>
				<span className="chip">#todo</span>
				<span className="chip chip-add">+ add tag</span>
				<span className="capture-spacer" />
				{pendingItems.length > 0 ? <Chip tone="green">{pendingItems.length} pending</Chip> : null}
				{failedCount > 0 ? <Chip tone="danger">{failedCount} failed</Chip> : null}
				<button
					type="button"
					className={`capture-private${isPrivate ? " active" : ""}`}
					aria-pressed={isPrivate}
					onClick={() => setIsPrivate((v) => !v)}
				>
					<IconLock width={16} height={16} />
					Private
				</button>
			</div>
			<Composer placeholder="type or paste anything…" onSend={save} disabled={false} />
			<BriefSheet
				open={briefOpen}
				onClose={() => {
					window.location.replace("#capture");
				}}
			/>
		</div>
	);
}
