/** Journal's Raw sub-view: reverse-chronological raw notes. React port of `public/notes.js`. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import GlassCard from "../../ui/GlassCard";

const PAGE_LIMIT = 50;

interface RawNote {
	id: string;
	body: string;
	created_at: string;
	private: boolean;
	processed_at: string | null;
}

function formatTimestamp(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function NoteCard({ note }: { note: RawNote }) {
	return (
		<GlassCard className="note-card">
			<div className="note-body">{note.body}</div>
			<div className="note-meta">
				<span>{formatTimestamp(note.created_at)}</span>
				{note.private ? <span title="Private">{"\u{1F512}"}</span> : null}
			</div>
		</GlassCard>
	);
}

export default function RawNotes() {
	const [notes, setNotes] = useState<RawNote[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [empty, setEmpty] = useState(false);

	const notesRef = useRef<RawNote[]>([]);
	const beforeRef = useRef<string | undefined>(undefined);
	const loadingRef = useRef(false);
	const destroyedRef = useRef(false);

	const loadPage = useCallback(async () => {
		if (loadingRef.current) {
			return;
		}
		loadingRef.current = true;
		setLoading(true);

		try {
			const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
			if (beforeRef.current) {
				params.set("before", beforeRef.current);
			}
			const res = await apiFetch(`/api/notes?${params.toString()}`);
			if (destroyedRef.current) {
				return;
			}

			const priorCount = notesRef.current.length;
			if (!res.ok) {
				setHasMore(false);
				if (priorCount === 0) {
					setLoadError(true);
				}
				return;
			}

			const data = (await res.json()) as { notes?: RawNote[] };
			const newNotes = data.notes ?? [];
			const combined = [...notesRef.current, ...newNotes];
			notesRef.current = combined;
			setNotes(combined);

			const lastNote = newNotes[newNotes.length - 1];
			if (lastNote) {
				beforeRef.current = lastNote.created_at;
			}
			setHasMore(newNotes.length >= PAGE_LIMIT);

			if (newNotes.length === 0 && priorCount === 0) {
				setEmpty(true);
			}
		} catch (err) {
			console.error("notes: failed to load", err);
		} finally {
			loadingRef.current = false;
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		loadPage();
		return () => {
			destroyedRef.current = true;
		};
	}, [loadPage]);

	return (
		<div className="notes-view">
			<div className="notes-list">
				{notes.map((note) => (
					<NoteCard key={note.id} note={note} />
				))}
				{loadError ? <p className="hint">Couldn't load notes.</p> : null}
				{empty && !loadError ? <p className="hint">No notes yet.</p> : null}
			</div>
			{hasMore ? (
				<div className="journal-load-more-row">
					<Button variant="ghost" onClick={() => void loadPage()} disabled={loading}>
						Load more
					</Button>
				</div>
			) : null}
		</div>
	);
}
