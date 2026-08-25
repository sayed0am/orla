/**
 * Journal's Organized sub-view: browse/search organized notes, filter by type/day — search covers
 * both text and tags. React port of `public/journal.js`'s organized pane.
 */

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import Chip from "../../ui/Chip";
import { TextInput } from "../../ui/Field";
import GlassCard from "../../ui/GlassCard";

type NoteType = "journal" | "meeting" | "task" | "idea" | "reference";
type ActionItemStatus = "open" | "done" | "dismissed";

interface JournalActionItem {
	id: string;
	text: string;
	due_date: string | null;
	status: ActionItemStatus;
}

interface JournalEntry {
	id: string;
	raw_note_id: string;
	type: NoteType;
	cleaned_text: string;
	summary: string;
	tags: string[];
	attendees: string[];
	decisions: string[];
	created_at: string;
	captured_at: string;
	action_items: JournalActionItem[];
}

const TYPES: readonly (NoteType | "all")[] = [
	"all",
	"journal",
	"meeting",
	"task",
	"idea",
	"reference",
];
const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 50;

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatDueDate(dueDate: string | null): string {
	if (!dueDate) {
		return "";
	}
	try {
		return new Date(`${dueDate}T00:00:00Z`).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});
	} catch {
		return dueDate;
	}
}

/** Splits `text` into plain paragraphs (blank-line separated) — user content, not markdown. */
function splitParagraphs(text: string): string[] {
	return String(text ?? "")
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

function typeTone(type: NoteType): "lilac" | "green" | undefined {
	if (type === "meeting") {
		return "lilac";
	}
	if (type === "task") {
		return "green";
	}
	return undefined;
}

function statusTone(status: ActionItemStatus): "green" | "danger" | undefined {
	if (status === "done") {
		return "green";
	}
	if (status === "dismissed") {
		return "danger";
	}
	return undefined;
}

function SubList({ title, items }: { title: string; items: string[] }) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div className="journal-sublist">
			<div className="journal-sublist-heading">{title}</div>
			<ul>
				{items.map((value) => (
					<li key={value}>{value}</li>
				))}
			</ul>
		</div>
	);
}

function ActionItemsSection({ items }: { items: JournalActionItem[] }) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div className="journal-action-items">
			{items.map((item) => (
				<div className="journal-action-item" key={item.id}>
					<Chip tone={statusTone(item.status)}>{item.status}</Chip>
					<span>{item.text}</span>
					{item.due_date ? (
						<span className="journal-action-item-due">{formatDueDate(item.due_date)}</span>
					) : null}
				</div>
			))}
		</div>
	);
}

function EntryCard({
	entry,
	onTagClick,
}: {
	entry: JournalEntry;
	onTagClick: (tag: string) => void;
}) {
	const paragraphs = splitParagraphs(entry.cleaned_text);
	return (
		<GlassCard className="journal-card">
			<div className="journal-card-header">
				<Chip tone={typeTone(entry.type)}>{entry.type}</Chip>
				<span className="journal-card-date hint">{formatDate(entry.captured_at)}</span>
			</div>
			{entry.summary ? (
				<p className="journal-summary">
					<strong>{entry.summary}</strong>
				</p>
			) : null}
			{paragraphs.length > 0 ? (
				<div className="journal-body">
					{paragraphs.map((para) => (
						<p key={para}>{para}</p>
					))}
				</div>
			) : null}
			<SubList title="Attendees" items={entry.attendees} />
			<SubList title="Decisions" items={entry.decisions} />
			<ActionItemsSection items={entry.action_items} />
			{entry.tags.length > 0 ? (
				<div className="chip-row">
					{entry.tags.map((tag) => (
						<Chip key={tag} onClick={() => onTagClick(tag)}>
							{tag}
						</Chip>
					))}
				</div>
			) : null}
		</GlassCard>
	);
}

export default function OrganizedView() {
	const [entries, setEntries] = useState<JournalEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [empty, setEmpty] = useState(false);

	const [searchValue, setSearchValue] = useState("");
	const [dayValue, setDayValue] = useState("");
	const [activeType, setActiveType] = useState<NoteType | "all">("all");

	const entriesRef = useRef<JournalEntry[]>([]);
	const beforeRef = useRef<string | undefined>(undefined);
	const loadingRef = useRef(false);
	const destroyedRef = useRef(false);
	const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const activeTypeRef = useRef<NoteType | "all">("all");
	const activeDayRef = useRef("");
	const activeQueryRef = useRef("");

	const buildUrl = useCallback((): string => {
		const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
		if (beforeRef.current) {
			params.set("before", beforeRef.current);
		}
		if (activeTypeRef.current !== "all") {
			params.set("type", activeTypeRef.current);
		}
		if (activeDayRef.current) {
			params.set("day", activeDayRef.current);
		}
		if (activeQueryRef.current) {
			params.set("q", activeQueryRef.current);
			return `/api/journal/search?${params.toString()}`;
		}
		return `/api/journal?${params.toString()}`;
	}, []);

	const loadPage = useCallback(async () => {
		if (loadingRef.current) {
			return;
		}
		loadingRef.current = true;
		setLoading(true);

		try {
			const res = await apiFetch(buildUrl());
			if (destroyedRef.current) {
				return;
			}

			const priorCount = entriesRef.current.length;
			if (!res.ok) {
				setHasMore(false);
				if (priorCount === 0) {
					setLoadError(true);
				}
				return;
			}

			const data = (await res.json()) as { entries?: JournalEntry[] };
			const newEntries = data.entries ?? [];
			const combined = [...entriesRef.current, ...newEntries];
			entriesRef.current = combined;
			setEntries(combined);

			const lastEntry = newEntries[newEntries.length - 1];
			if (lastEntry) {
				beforeRef.current = lastEntry.created_at;
			}
			setHasMore(newEntries.length >= PAGE_LIMIT);

			if (newEntries.length === 0 && priorCount === 0) {
				setEmpty(true);
			}
		} catch (err) {
			console.error("journal: failed to load", err);
		} finally {
			loadingRef.current = false;
			setLoading(false);
		}
	}, [buildUrl]);

	const reload = useCallback(() => {
		beforeRef.current = undefined;
		entriesRef.current = [];
		setEntries([]);
		setHasMore(false);
		setLoadError(false);
		setEmpty(false);
		void loadPage();
	}, [loadPage]);

	useEffect(() => {
		destroyedRef.current = false;
		loadPage();
		return () => {
			destroyedRef.current = true;
			clearTimeout(searchDebounceRef.current);
		};
	}, [loadPage]);

	function onSearchChange(event: ChangeEvent<HTMLInputElement>) {
		const value = event.target.value;
		setSearchValue(value);
		clearTimeout(searchDebounceRef.current);
		searchDebounceRef.current = setTimeout(() => {
			activeQueryRef.current = value.trim();
			reload();
		}, SEARCH_DEBOUNCE_MS);
	}

	function onDayChange(event: ChangeEvent<HTMLInputElement>) {
		const value = event.target.value;
		setDayValue(value);
		activeDayRef.current = value;
		reload();
	}

	function onTagClickFromEntry(tag: string) {
		clearTimeout(searchDebounceRef.current);
		setSearchValue(tag);
		activeQueryRef.current = tag;
		reload();
	}

	function onTypeClick(type: NoteType | "all") {
		setActiveType(type);
		activeTypeRef.current = type;
		reload();
	}

	return (
		<div className="journal-organized">
			<div className="journal-filters">
				<TextInput
					type="text"
					className="journal-filter-search"
					placeholder="Search journal…"
					value={searchValue}
					onChange={onSearchChange}
				/>
				<TextInput
					type="date"
					className="journal-filter-day"
					value={dayValue}
					onChange={onDayChange}
				/>
			</div>
			<div className="chip-row journal-type-chips">
				{TYPES.map((type) => (
					<button
						key={type}
						type="button"
						className={`chip journal-type-chip${type === activeType ? " active" : ""}`}
						onClick={() => onTypeClick(type)}
					>
						{type}
					</button>
				))}
			</div>
			<div className="journal-list">
				{entries.map((entry) => (
					<EntryCard key={entry.id} entry={entry} onTagClick={onTagClickFromEntry} />
				))}
				{loadError ? <p className="hint">Couldn't load the journal.</p> : null}
				{empty && !loadError ? <p className="hint">No journal entries yet.</p> : null}
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
