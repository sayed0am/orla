/** Reverse-chronological raw notes list (PRD F2 / F7 groundwork). */

import { apiFetch } from "./api.js";

function formatTimestamp(iso) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function renderNote(note) {
	const card = document.createElement("div");
	card.className = "note-card";

	const body = document.createElement("div");
	body.textContent = note.body;
	card.appendChild(body);

	const meta = document.createElement("div");
	meta.className = "note-meta";
	const time = document.createElement("span");
	time.textContent = formatTimestamp(note.created_at);
	meta.appendChild(time);
	if (note.private) {
		const lock = document.createElement("span");
		lock.textContent = "\u{1F512}";
		lock.title = "Private";
		meta.appendChild(lock);
	}
	card.appendChild(meta);

	return card;
}

export function mountNotes(root) {
	const view = document.createElement("div");
	view.className = "notes-view";
	view.innerHTML = `
		<div id="notes-list"></div>
		<button type="button" class="load-more" id="notes-load-more" hidden>Load more</button>
	`;
	root.appendChild(view);

	const list = view.querySelector("#notes-list");
	const loadMoreButton = view.querySelector("#notes-load-more");

	let before;
	let loading = false;
	let destroyed = false;

	async function loadPage() {
		if (loading) {
			return;
		}
		loading = true;
		loadMoreButton.disabled = true;

		try {
			const params = new URLSearchParams({ limit: "50" });
			if (before) {
				params.set("before", before);
			}
			const res = await apiFetch(`/api/notes?${params.toString()}`);
			if (destroyed) {
				return;
			}
			if (!res.ok) {
				if (list.children.length === 0) {
					const errorEl = document.createElement("p");
					errorEl.className = "hint";
					errorEl.textContent = "Couldn't load notes.";
					list.appendChild(errorEl);
				}
				loadMoreButton.hidden = true;
				return;
			}

			const data = await res.json();
			const notes = data.notes ?? [];
			for (const note of notes) {
				list.appendChild(renderNote(note));
			}

			if (notes.length > 0) {
				before = notes[notes.length - 1].created_at;
			}
			loadMoreButton.hidden = notes.length < 50;

			if (notes.length === 0 && list.children.length === 0) {
				const emptyEl = document.createElement("p");
				emptyEl.className = "hint";
				emptyEl.textContent = "No notes yet.";
				list.appendChild(emptyEl);
			}
		} catch (err) {
			console.error("notes: failed to load", err);
		} finally {
			loading = false;
			loadMoreButton.disabled = false;
		}
	}

	loadMoreButton.addEventListener("click", loadPage);
	loadPage();

	return function unmount() {
		destroyed = true;
	};
}
