/** Journal tab: browse/search organized notes, filter by type/tag/day, plus a Raw sub-view (PRD F7). */

import { apiFetch } from "./api.js";
import { mountNotes } from "./notes.js";

const TYPES = ["all", "journal", "meeting", "task", "idea", "reference"];
const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 50;

function formatDate(iso) {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatDueDate(dueDate) {
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

/** Renders `text` as plain paragraphs (split on blank lines) — this is user content, not markdown. */
function renderPlainParagraphs(container, text) {
	const paragraphs = String(text ?? "")
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (paragraphs.length === 0) {
		return;
	}
	for (const para of paragraphs) {
		const p = document.createElement("p");
		p.textContent = para;
		container.appendChild(p);
	}
}

export function mountJournal(root) {
	const view = document.createElement("div");
	view.className = "journal-view";
	view.innerHTML = `
		<div class="journal-subtabs">
			<button type="button" class="journal-subtab active" id="journal-subtab-organized">Organized</button>
			<button type="button" class="journal-subtab" id="journal-subtab-raw">Raw</button>
		</div>
		<div id="journal-organized">
			<div class="journal-controls">
				<input type="text" id="journal-search" placeholder="Search journal…" />
				<input type="date" id="journal-day" />
				<input type="text" id="journal-tag" placeholder="Tag" class="journal-tag-input" />
			</div>
			<div class="chip-row" id="journal-type-chips">
				${TYPES.map(
					(t) =>
						`<button type="button" class="chip${t === "all" ? " active" : ""}" data-type="${t}">${t}</button>`,
				).join("")}
			</div>
			<div id="journal-list"></div>
			<button type="button" class="load-more" id="journal-load-more" hidden>Load more</button>
			<p class="hint journal-export">
				<a href="/api/export">Export JSON</a>
				·
				<a href="/api/export?format=markdown">Export Markdown</a>
			</p>
		</div>
		<div id="journal-raw" hidden></div>
	`;
	root.appendChild(view);

	const subtabOrganized = view.querySelector("#journal-subtab-organized");
	const subtabRaw = view.querySelector("#journal-subtab-raw");
	const organizedPane = view.querySelector("#journal-organized");
	const rawPane = view.querySelector("#journal-raw");
	const searchInput = view.querySelector("#journal-search");
	const dayInput = view.querySelector("#journal-day");
	const tagInput = view.querySelector("#journal-tag");
	const typeChips = Array.from(view.querySelectorAll("#journal-type-chips .chip"));
	const list = view.querySelector("#journal-list");
	const loadMoreButton = view.querySelector("#journal-load-more");

	let destroyed = false;
	let activeType = "all";
	let activeTag = "";
	let activeDay = "";
	let activeQuery = "";
	let before;
	let loading = false;
	let searchDebounceHandle;
	let rawUnmount;
	let rawMounted = false;

	function actionItemsSection(items) {
		if (!items || items.length === 0) {
			return null;
		}
		const section = document.createElement("div");
		section.className = "journal-action-items";
		for (const item of items) {
			const row = document.createElement("div");
			row.className = "journal-action-item";
			const statusBadge = document.createElement("span");
			statusBadge.className = `action-item-status action-item-status-${item.status}`;
			statusBadge.textContent = item.status;
			row.appendChild(statusBadge);
			const text = document.createElement("span");
			text.textContent = item.text;
			row.appendChild(text);
			if (item.due_date) {
				const due = document.createElement("span");
				due.className = "action-item-due";
				due.textContent = formatDueDate(item.due_date);
				row.appendChild(due);
			}
			section.appendChild(row);
		}
		return section;
	}

	function listSection(title, items) {
		if (!items || items.length === 0) {
			return null;
		}
		const section = document.createElement("div");
		section.className = "journal-sublist";
		const heading = document.createElement("div");
		heading.className = "journal-sublist-heading";
		heading.textContent = title;
		section.appendChild(heading);
		const ul = document.createElement("ul");
		for (const value of items) {
			const li = document.createElement("li");
			li.textContent = value;
			ul.appendChild(li);
		}
		section.appendChild(ul);
		return section;
	}

	function renderEntry(entry) {
		const card = document.createElement("div");
		card.className = "journal-card";

		const header = document.createElement("div");
		header.className = "journal-card-header";
		const badge = document.createElement("span");
		badge.className = `type-badge type-badge-${entry.type}`;
		badge.textContent = entry.type;
		header.appendChild(badge);
		const captured = document.createElement("span");
		captured.className = "journal-card-date";
		captured.textContent = formatDate(entry.captured_at);
		header.appendChild(captured);
		card.appendChild(header);

		if (entry.summary) {
			const summary = document.createElement("p");
			summary.className = "journal-summary";
			const strong = document.createElement("strong");
			strong.textContent = entry.summary;
			summary.appendChild(strong);
			card.appendChild(summary);
		}

		const body = document.createElement("div");
		body.className = "journal-body";
		renderPlainParagraphs(body, entry.cleaned_text);
		card.appendChild(body);

		const attendees = listSection("Attendees", entry.attendees);
		if (attendees) {
			card.appendChild(attendees);
		}
		const decisions = listSection("Decisions", entry.decisions);
		if (decisions) {
			card.appendChild(decisions);
		}
		const actionItems = actionItemsSection(entry.action_items);
		if (actionItems) {
			card.appendChild(actionItems);
		}

		if (entry.tags && entry.tags.length > 0) {
			const tagsRow = document.createElement("div");
			tagsRow.className = "chip-row";
			for (const tag of entry.tags) {
				const chip = document.createElement("button");
				chip.type = "button";
				chip.className = "chip";
				chip.textContent = tag;
				chip.addEventListener("click", () => {
					activeTag = tag;
					tagInput.value = tag;
					reload();
				});
				tagsRow.appendChild(chip);
			}
			card.appendChild(tagsRow);
		}

		return card;
	}

	function buildUrl() {
		const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
		if (before) {
			params.set("before", before);
		}
		if (activeType !== "all") {
			params.set("type", activeType);
		}
		if (activeTag) {
			params.set("tag", activeTag);
		}
		if (activeDay) {
			params.set("day", activeDay);
		}

		if (activeQuery) {
			params.set("q", activeQuery);
			return `/api/journal/search?${params.toString()}`;
		}
		return `/api/journal?${params.toString()}`;
	}

	async function loadPage() {
		if (loading) {
			return;
		}
		loading = true;
		loadMoreButton.disabled = true;

		try {
			const res = await apiFetch(buildUrl());
			if (destroyed) {
				return;
			}
			if (!res.ok) {
				if (list.children.length === 0) {
					const errorEl = document.createElement("p");
					errorEl.className = "hint";
					errorEl.textContent = "Couldn't load the journal.";
					list.appendChild(errorEl);
				}
				loadMoreButton.hidden = true;
				return;
			}

			const data = await res.json();
			const entries = data.entries ?? [];
			for (const entry of entries) {
				list.appendChild(renderEntry(entry));
			}

			if (entries.length > 0) {
				before = entries[entries.length - 1].created_at;
			}
			loadMoreButton.hidden = entries.length < PAGE_LIMIT;

			if (entries.length === 0 && list.children.length === 0) {
				const emptyEl = document.createElement("p");
				emptyEl.className = "hint";
				emptyEl.textContent = "No journal entries yet.";
				list.appendChild(emptyEl);
			}
		} catch (err) {
			console.error("journal: failed to load", err);
		} finally {
			loading = false;
			loadMoreButton.disabled = false;
		}
	}

	function reload() {
		before = undefined;
		list.innerHTML = "";
		loadMoreButton.hidden = true;
		loadPage();
	}

	searchInput.addEventListener("input", () => {
		clearTimeout(searchDebounceHandle);
		searchDebounceHandle = setTimeout(() => {
			activeQuery = searchInput.value.trim();
			reload();
		}, SEARCH_DEBOUNCE_MS);
	});

	dayInput.addEventListener("change", () => {
		activeDay = dayInput.value;
		reload();
	});

	tagInput.addEventListener("change", () => {
		activeTag = tagInput.value.trim();
		reload();
	});

	for (const chip of typeChips) {
		chip.addEventListener("click", () => {
			activeType = chip.dataset.type;
			for (const c of typeChips) {
				c.classList.toggle("active", c === chip);
			}
			reload();
		});
	}

	loadMoreButton.addEventListener("click", loadPage);

	function showOrganized() {
		subtabOrganized.classList.add("active");
		subtabRaw.classList.remove("active");
		organizedPane.hidden = false;
		rawPane.hidden = true;
		if (rawMounted && typeof rawUnmount === "function") {
			rawUnmount();
			rawUnmount = undefined;
			rawMounted = false;
			rawPane.innerHTML = "";
		}
	}

	function showRaw() {
		subtabOrganized.classList.remove("active");
		subtabRaw.classList.add("active");
		organizedPane.hidden = true;
		rawPane.hidden = false;
		if (!rawMounted) {
			rawUnmount = mountNotes(rawPane);
			rawMounted = true;
		}
	}

	subtabOrganized.addEventListener("click", showOrganized);
	subtabRaw.addEventListener("click", showRaw);

	/** Opens straight to the Raw sub-view — used by the `#notes` hash alias. */
	function openRaw() {
		showRaw();
	}

	loadPage();

	const unmount = function unmount() {
		destroyed = true;
		clearTimeout(searchDebounceHandle);
		if (rawMounted && typeof rawUnmount === "function") {
			rawUnmount();
		}
	};
	unmount.openRaw = openRaw;
	return unmount;
}
