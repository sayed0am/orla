/** Costs tab: spend/cache dashboard, the tuning instrument for G4 and the §10 cache-hit metric. */

import { apiFetch } from "./api.js";

const DAY_OPTIONS = [7, 30, 90];
const DEFAULT_DAYS = 30;
const CACHE_HIT_GOOD = 0.8;

function formatUsd(value) {
	return `$${Number(value ?? 0).toFixed(2)}`;
}

function formatPct(value) {
	return `${Math.round(Number(value ?? 0) * 1000) / 10}%`;
}

function formatInt(value) {
	return Number(value ?? 0).toLocaleString();
}

function statTile(label, value, { accent } = {}) {
	const tile = document.createElement("div");
	tile.className = "stat-tile";
	if (accent) {
		tile.classList.add("stat-tile-accent");
	}
	const valueEl = document.createElement("div");
	valueEl.className = "stat-tile-value";
	valueEl.textContent = value;
	const labelEl = document.createElement("div");
	labelEl.className = "stat-tile-label";
	labelEl.textContent = label;
	tile.appendChild(valueEl);
	tile.appendChild(labelEl);
	return tile;
}

function jobTypeTable(byJobType) {
	const wrapper = document.createElement("div");
	wrapper.className = "table-scroll";
	const table = document.createElement("table");
	table.className = "costs-table";
	table.innerHTML = `
		<thead>
			<tr>
				<th>Job</th>
				<th>Calls</th>
				<th>Prompt</th>
				<th>Cached</th>
				<th>Completion</th>
				<th>Cost</th>
			</tr>
		</thead>
	`;
	const tbody = document.createElement("tbody");
	const jobTypes = Object.keys(byJobType).sort();
	if (jobTypes.length === 0) {
		const row = document.createElement("tr");
		row.innerHTML = `<td colspan="6" class="hint">No calls in this window.</td>`;
		tbody.appendChild(row);
	}
	for (const jobType of jobTypes) {
		const totals = byJobType[jobType];
		const row = document.createElement("tr");
		row.innerHTML = `
			<td>${jobType}</td>
			<td>${formatInt(totals.calls)}</td>
			<td>${formatInt(totals.prompt_tokens)}</td>
			<td>${formatInt(totals.cached_tokens)}</td>
			<td>${formatInt(totals.completion_tokens)}</td>
			<td>${formatUsd(totals.cost_usd)}</td>
		`;
		tbody.appendChild(row);
	}
	table.appendChild(tbody);
	wrapper.appendChild(table);
	return wrapper;
}

function dailyTable(rows) {
	const wrapper = document.createElement("div");
	wrapper.className = "table-scroll";
	const table = document.createElement("table");
	table.className = "costs-table";
	table.innerHTML = `
		<thead>
			<tr>
				<th>Day</th>
				<th>Job</th>
				<th>Calls</th>
				<th>Cache</th>
				<th>Cost</th>
			</tr>
		</thead>
	`;
	const tbody = document.createElement("tbody");
	if (rows.length === 0) {
		const row = document.createElement("tr");
		row.innerHTML = `<td colspan="5" class="hint">No calls in this window.</td>`;
		tbody.appendChild(row);
	}
	const sorted = [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
	for (const row of sorted) {
		const rate = row.prompt_tokens === 0 ? 0 : row.cached_tokens / row.prompt_tokens;
		const tr = document.createElement("tr");
		tr.innerHTML = `
			<td>${row.day}</td>
			<td>${row.job_type}</td>
			<td>${formatInt(row.calls)}</td>
			<td>${formatPct(rate)}</td>
			<td>${formatUsd(row.cost_usd)}</td>
		`;
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	wrapper.appendChild(table);
	return wrapper;
}

export function mountCosts(root) {
	const view = document.createElement("div");
	view.className = "costs-view";
	view.innerHTML = `
		<div class="costs-controls">
			<label for="costs-days">Window</label>
			<select id="costs-days">
				${DAY_OPTIONS.map((d) => `<option value="${d}">${d} days</option>`).join("")}
			</select>
		</div>
		<div id="costs-body"></div>
	`;
	root.appendChild(view);

	const daysSelect = view.querySelector("#costs-days");
	daysSelect.value = String(DEFAULT_DAYS);
	const body = view.querySelector("#costs-body");

	let destroyed = false;

	function renderLoading() {
		body.innerHTML = `<p class="hint">Loading…</p>`;
	}

	function renderError(message) {
		body.innerHTML = "";
		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = message;
		body.appendChild(p);
	}

	function renderData(data) {
		body.innerHTML = "";

		const stats = document.createElement("div");
		stats.className = "stat-tiles";
		stats.appendChild(statTile("Month-to-date", formatUsd(data.month_to_date_usd)));
		stats.appendChild(statTile("Projected", formatUsd(data.projected_month_usd)));
		stats.appendChild(
			statTile("Cache hit rate", formatPct(data.totals.cache_hit_rate), {
				accent: data.totals.cache_hit_rate >= CACHE_HIT_GOOD,
			}),
		);
		stats.appendChild(statTile("Calls", formatInt(data.totals.calls)));
		body.appendChild(stats);

		const jobHeading = document.createElement("h3");
		jobHeading.textContent = "By job type";
		body.appendChild(jobHeading);
		body.appendChild(jobTypeTable(data.by_job_type));

		const dayHeading = document.createElement("h3");
		dayHeading.textContent = "By day";
		body.appendChild(dayHeading);
		body.appendChild(dailyTable(data.rows));
	}

	async function load() {
		renderLoading();
		const days = daysSelect.value;
		let res;
		try {
			res = await apiFetch(`/api/costs?days=${days}`);
		} catch (err) {
			console.error("costs: failed to load", err);
			if (!destroyed) {
				renderError("Couldn't load the cost dashboard.");
			}
			return;
		}
		if (destroyed) {
			return;
		}
		if (!res.ok) {
			renderError("Couldn't load the cost dashboard.");
			return;
		}
		const data = await res.json();
		if (destroyed) {
			return;
		}
		renderData(data);
	}

	daysSelect.addEventListener("change", load);
	load();

	return function unmount() {
		destroyed = true;
	};
}
