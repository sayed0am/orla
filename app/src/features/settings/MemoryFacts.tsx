/** Memory section (PRD §8 Option A): proposed/active facts, click-to-edit, "What Orla sees"
 * preview. Port of brief.js's memory section. */

import {
	type ChangeEvent,
	type KeyboardEvent,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import GlassCard from "../../ui/GlassCard";

interface MemoryFact {
	id: string;
	text: string;
	status: "proposed" | "active" | "archived";
}

function ProposedRow({
	fact,
	onKeep,
	onDiscard,
}: {
	fact: MemoryFact;
	onKeep: () => void;
	onDiscard: () => void;
}) {
	return (
		<div className="memory-row">
			<div className="memory-text">{fact.text}</div>
			<div className="memory-actions">
				<Button onClick={onKeep}>✓ Keep</Button>
				<Button onClick={onDiscard}>✕ Discard</Button>
			</div>
		</div>
	);
}

function ActiveRow({
	fact,
	onArchive,
	onSave,
	onCancel,
}: {
	fact: MemoryFact;
	onArchive: () => void;
	onSave: (newText: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(fact.text);
	const inputRef = useRef<HTMLInputElement>(null);
	const settledRef = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when entering edit mode, not on every keystroke that changes value.length
	useEffect(() => {
		if (editing) {
			settledRef.current = false;
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(value.length, value.length);
		}
	}, [editing]);

	function startEdit() {
		setValue(fact.text);
		setEditing(true);
	}

	async function commit() {
		if (settledRef.current) {
			return;
		}
		settledRef.current = true;
		setEditing(false);
		await onSave(value.trim());
	}

	function cancel() {
		settledRef.current = true;
		setEditing(false);
		onCancel();
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			event.currentTarget.blur();
		} else if (event.key === "Escape") {
			cancel();
		}
	}

	if (editing) {
		return (
			<div className="memory-row">
				{/* Plain <input>, not the TextInput wrapper — TextInput isn't forwardRef, so it can't
				    take the ref this row needs for focus + cursor placement on entering edit mode. */}
				<input
					ref={inputRef}
					type="text"
					className="field memory-edit-input"
					value={value}
					maxLength={200}
					onChange={(e) => setValue(e.target.value)}
					onBlur={commit}
					onKeyDown={onKeyDown}
				/>
			</div>
		);
	}

	return (
		<div className="memory-row">
			<button type="button" className="memory-text memory-text-editable" onClick={startEdit}>
				{fact.text}
			</button>
			<div className="memory-actions">
				<Button onClick={onArchive}>Archive</Button>
			</div>
		</div>
	);
}

function AddRow({ onSubmit }: { onSubmit: (text: string) => Promise<boolean> }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit() {
		const text = value.trim();
		if (text.length === 0) {
			return;
		}
		setBusy(true);
		const ok = await onSubmit(text);
		if (ok) {
			setValue("");
		}
		setBusy(false);
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			submit();
		}
	}

	return (
		<div className="memory-add-row">
			<TextInput
				type="text"
				placeholder="Add a fact…"
				maxLength={200}
				value={value}
				onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
				onKeyDown={onKeyDown}
			/>
			<Button variant="primary" disabled={busy} onClick={submit}>
				Add
			</Button>
		</div>
	);
}

type PreviewState = "idle" | "loading" | "error" | { block: string; chars: number };

function MemoryPreview() {
	const [preview, setPreview] = useState<PreviewState>("idle");
	const destroyedRef = useRef(false);
	useEffect(
		() => () => {
			destroyedRef.current = true;
		},
		[],
	);

	async function loadPreview() {
		setPreview("loading");
		try {
			const res = await apiFetch("/api/memory/preview");
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			const data = (await res.json()) as { block: string; chars: number };
			if (!destroyedRef.current) {
				setPreview(data);
			}
		} catch (err) {
			console.error("settings: failed to load memory preview", err);
			if (!destroyedRef.current) {
				setPreview("error");
			}
		}
	}

	function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
		if (event.currentTarget.open) {
			loadPreview();
		}
	}

	return (
		<details className="memory-preview" onToggle={onToggle}>
			<summary>What Orla sees</summary>
			<div className="memory-preview-body">
				{preview === "idle" || preview === "loading" ? <p className="hint">Loading…</p> : null}
				{preview === "error" ? <p className="hint">Couldn't load the preview.</p> : null}
				{typeof preview === "object" ? (
					<>
						<pre className="memory-preview-block">
							{preview.block.length > 0 ? preview.block : "(empty — no active facts)"}
						</pre>
						<p className="hint">{preview.chars} characters</p>
					</>
				) : null}
			</div>
		</details>
	);
}

export default function MemoryFacts() {
	const [facts, setFacts] = useState<MemoryFact[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const factsRef = useRef<MemoryFact[] | null>(null);
	factsRef.current = facts;
	const destroyedRef = useRef(false);

	const load = useCallback(async () => {
		setLoadError(false);
		let res: Response;
		try {
			res = await apiFetch("/api/memory");
		} catch (err) {
			console.error("settings: failed to load memory", err);
			if (!destroyedRef.current) {
				setFacts(null);
				setLoadError(true);
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		if (!res.ok) {
			setFacts(null);
			setLoadError(true);
			return;
		}
		const data = (await res.json()) as { facts?: MemoryFact[] };
		setFacts(data.facts ?? []);
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		load();
		return () => {
			destroyedRef.current = true;
		};
	}, [load]);

	function restore(restoreOrder: (current: MemoryFact[]) => MemoryFact[]) {
		if (destroyedRef.current) {
			return;
		}
		setFacts((prev) => (prev ? restoreOrder(prev) : prev));
	}

	async function updateStatus(id: string, status: "active" | "archived") {
		const current = factsRef.current ?? [];
		const idx = current.findIndex((f) => f.id === id);
		const removed = idx === -1 ? undefined : current[idx];
		if (idx === -1 || !removed) {
			return;
		}
		setFacts(current.filter((f) => f.id !== id));
		try {
			const res = await apiFetch(`/api/memory/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyedRef.current) {
				await load();
			}
		} catch (err) {
			console.error("settings: failed to update memory fact", err);
			restore((prev) => {
				const next = [...prev];
				next.splice(idx, 0, removed);
				return next;
			});
		}
	}

	async function discard(id: string) {
		const current = factsRef.current ?? [];
		const idx = current.findIndex((f) => f.id === id);
		const removed = idx === -1 ? undefined : current[idx];
		if (idx === -1 || !removed) {
			return;
		}
		setFacts(current.filter((f) => f.id !== id));
		try {
			const res = await apiFetch(`/api/memory/${id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyedRef.current) {
				await load();
			}
		} catch (err) {
			console.error("settings: failed to discard memory fact", err);
			restore((prev) => {
				const next = [...prev];
				next.splice(idx, 0, removed);
				return next;
			});
		}
	}

	async function saveEdit(id: string, newText: string, original: string) {
		if (newText.length === 0 || newText === original) {
			if (!destroyedRef.current) {
				await load();
			}
			return;
		}
		try {
			const res = await apiFetch(`/api/memory/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: newText }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("settings: failed to edit memory fact", err);
		} finally {
			if (!destroyedRef.current) {
				await load();
			}
		}
	}

	async function addFact(text: string): Promise<boolean> {
		try {
			const res = await apiFetch("/api/memory", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyedRef.current) {
				await load();
			}
			return true;
		} catch (err) {
			console.error("settings: failed to add memory fact", err);
			return false;
		}
	}

	const proposed = (facts ?? []).filter((f) => f.status === "proposed");
	const active = (facts ?? []).filter((f) => f.status === "active");

	return (
		<GlassCard title="Memory">
			{facts === null && !loadError ? <p className="hint">Loading…</p> : null}
			{loadError ? <p className="hint">Couldn't load memory.</p> : null}
			{facts !== null ? (
				<>
					{proposed.length > 0 ? (
						<>
							<div className="settings-subheading">Proposed</div>
							{proposed.map((fact) => (
								<ProposedRow
									key={fact.id}
									fact={fact}
									onKeep={() => updateStatus(fact.id, "active")}
									onDiscard={() => discard(fact.id)}
								/>
							))}
						</>
					) : null}
					<div className="settings-subheading">Active</div>
					{active.length === 0 ? (
						<p className="hint">No facts yet.</p>
					) : (
						active.map((fact) => (
							<ActiveRow
								key={fact.id}
								fact={fact}
								onArchive={() => updateStatus(fact.id, "archived")}
								onSave={(newText) => saveEdit(fact.id, newText, fact.text)}
								onCancel={load}
							/>
						))
					)}
					<AddRow onSubmit={addFact} />
					<MemoryPreview />
				</>
			) : null}
		</GlassCard>
	);
}
