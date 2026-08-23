/** Brief tab: today's morning brief, action items, and push notification setup (PRD F4). */

import { apiFetch } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { credentialToJSON, toCreationOptions } from "./webauthn.js";

/** Converts a base64url-encoded VAPID public key into the Uint8Array pushManager.subscribe wants. */
function base64UrlToUint8Array(base64Url) {
	const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) {
		output[i] = raw.charCodeAt(i);
	}
	return output;
}

function isIos() {
	return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function todayUtc() {
	return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr, deltaDays) {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + deltaDays);
	return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr) {
	try {
		return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});
	} catch {
		return dateStr;
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

function isOverdue(dueDate) {
	if (!dueDate) {
		return false;
	}
	return dueDate < todayUtc();
}

export function mountBrief(root, authStatus) {
	const view = document.createElement("div");
	view.className = "brief-view";
	view.innerHTML = `
		<div class="date-nav">
			<button type="button" id="brief-prev" aria-label="Previous day">&larr;</button>
			<span id="brief-date-label"></span>
			<button type="button" id="brief-next" aria-label="Next day">&rarr;</button>
		</div>
		<div id="brief-body"></div>
		<h3>Action items</h3>
		<div id="action-items-body"></div>
		<h3>Notifications</h3>
		<div id="push-body"></div>
		<h3>Maintenance</h3>
		<div id="maintenance-body"></div>
		<h3>Memory</h3>
		<div id="memory-body"></div>
	`;
	root.appendChild(view);

	const dateLabel = view.querySelector("#brief-date-label");
	const prevButton = view.querySelector("#brief-prev");
	const nextButton = view.querySelector("#brief-next");
	const briefBody = view.querySelector("#brief-body");
	const actionItemsBody = view.querySelector("#action-items-body");
	const pushBody = view.querySelector("#push-body");
	const maintenanceBody = view.querySelector("#maintenance-body");
	const memoryBody = view.querySelector("#memory-body");

	// Passkeys card only exists in passkey auth mode — created here (rather than in the
	// static template above) so it's simply absent from the DOM in access mode.
	let passkeysBody;
	if (authStatus?.mode === "passkey") {
		const heading = document.createElement("h3");
		heading.textContent = "Passkeys";
		view.appendChild(heading);
		passkeysBody = document.createElement("div");
		passkeysBody.id = "passkeys-body";
		view.appendChild(passkeysBody);
	}

	let destroyed = false;
	let currentDate = todayUtc();

	// --- Brief ---

	async function loadBrief() {
		dateLabel.textContent = formatDateLabel(currentDate);
		nextButton.disabled = currentDate >= todayUtc();
		briefBody.innerHTML = `<p class="hint">Loading…</p>`;

		let res;
		try {
			res = await apiFetch(`/api/brief?date=${currentDate}`);
		} catch (err) {
			console.error("brief: failed to load", err);
			if (!destroyed) {
				briefBody.innerHTML = `<p class="hint">Couldn't load the brief.</p>`;
			}
			return;
		}
		if (destroyed) {
			return;
		}

		if (res.status === 404) {
			briefBody.innerHTML = "";
			const card = document.createElement("div");
			card.className = "brief-card";
			const p = document.createElement("p");
			p.className = "hint";
			p.textContent =
				currentDate === todayUtc() ? "No brief yet for today." : "No brief for this day.";
			card.appendChild(p);
			if (currentDate === todayUtc()) {
				const buildButton = document.createElement("button");
				buildButton.type = "button";
				buildButton.className = "primary";
				buildButton.textContent = "Build now";
				buildButton.addEventListener("click", async () => {
					buildButton.disabled = true;
					buildButton.textContent = "Building…";
					try {
						const runRes = await apiFetch("/api/brief/run", { method: "POST" });
						if (!runRes.ok) {
							throw new Error(`http ${runRes.status}`);
						}
						await loadBrief();
					} catch (err) {
						console.error("brief: failed to build", err);
						if (!destroyed) {
							buildButton.disabled = false;
							buildButton.textContent = "Build now";
						}
					}
				});
				card.appendChild(buildButton);
			}
			briefBody.appendChild(card);
			return;
		}

		if (!res.ok) {
			briefBody.innerHTML = `<p class="hint">Couldn't load the brief.</p>`;
			return;
		}

		const data = await res.json();
		briefBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "brief-card md";
		// body_md is trusted, app-generated markdown (not user input) but still goes through the
		// same renderer as chat replies for consistent output.
		card.innerHTML = renderMarkdown(data.brief.body_md);
		briefBody.appendChild(card);
	}

	prevButton.addEventListener("click", () => {
		currentDate = shiftDate(currentDate, -1);
		loadBrief();
	});
	nextButton.addEventListener("click", () => {
		if (currentDate < todayUtc()) {
			currentDate = shiftDate(currentDate, 1);
			loadBrief();
		}
	});

	// --- Action items ---

	function actionItemRow(item) {
		const row = document.createElement("div");
		row.className = "action-item-row";

		const text = document.createElement("div");
		text.className = "action-item-text";
		text.textContent = item.text;
		row.appendChild(text);

		if (item.due_date) {
			const due = document.createElement("span");
			due.className = "action-item-due";
			if (isOverdue(item.due_date)) {
				due.classList.add("overdue");
			}
			due.textContent = formatDueDate(item.due_date);
			row.appendChild(due);
		}

		const actions = document.createElement("div");
		actions.className = "action-item-actions";

		const doneButton = document.createElement("button");
		doneButton.type = "button";
		doneButton.textContent = "✓ Done";
		doneButton.addEventListener("click", () => updateStatus(item.id, "done", row));
		actions.appendChild(doneButton);

		const dismissButton = document.createElement("button");
		dismissButton.type = "button";
		dismissButton.textContent = "✕ Dismiss";
		dismissButton.addEventListener("click", () => updateStatus(item.id, "dismissed", row));
		actions.appendChild(dismissButton);

		row.appendChild(actions);
		return row;
	}

	async function updateStatus(id, status, row) {
		const parent = row.parentElement;
		const nextSibling = row.nextSibling;
		row.remove();

		try {
			const res = await apiFetch(`/api/action-items/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			if (actionItemsBody.children.length === 0) {
				renderEmptyActionItems();
			}
		} catch (err) {
			console.error("brief: failed to update action item", err);
			if (!destroyed && parent) {
				parent.insertBefore(row, nextSibling);
			}
		}
	}

	function renderEmptyActionItems() {
		actionItemsBody.innerHTML = "";
		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = "No open action items.";
		actionItemsBody.appendChild(p);
	}

	async function loadActionItems() {
		actionItemsBody.innerHTML = `<p class="hint">Loading…</p>`;
		let res;
		try {
			res = await apiFetch("/api/action-items?status=open&due=all");
		} catch (err) {
			console.error("brief: failed to load action items", err);
			if (!destroyed) {
				actionItemsBody.innerHTML = `<p class="hint">Couldn't load action items.</p>`;
			}
			return;
		}
		if (destroyed) {
			return;
		}
		if (!res.ok) {
			actionItemsBody.innerHTML = `<p class="hint">Couldn't load action items.</p>`;
			return;
		}
		const data = await res.json();
		const items = data.items ?? [];
		actionItemsBody.innerHTML = "";
		if (items.length === 0) {
			renderEmptyActionItems();
			return;
		}
		for (const item of items) {
			actionItemsBody.appendChild(actionItemRow(item));
		}
	}

	// --- Notifications ---

	function pushSupported() {
		return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	}

	function iosHint() {
		if (isIos() && !navigator.standalone) {
			const p = document.createElement("p");
			p.className = "hint";
			p.textContent =
				"On iPhone/iPad, push notifications only work after adding Orla to your Home Screen (Share → Add to Home Screen).";
			return p;
		}
		return null;
	}

	function endpointHost(endpoint) {
		try {
			return new URL(endpoint).host;
		} catch {
			return endpoint;
		}
	}

	async function renderPushEnabled(subscription) {
		pushBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "notifications-card";

		const status = document.createElement("p");
		status.textContent = `Enabled — ${endpointHost(subscription.endpoint)}`;
		card.appendChild(status);

		const row = document.createElement("div");
		row.className = "notifications-actions";

		const testButton = document.createElement("button");
		testButton.type = "button";
		testButton.textContent = "Send test";
		testButton.addEventListener("click", async () => {
			testButton.disabled = true;
			try {
				const res = await apiFetch("/api/push/test", { method: "POST" });
				if (!res.ok) {
					throw new Error(`http ${res.status}`);
				}
			} catch (err) {
				console.error("brief: push test failed", err);
			} finally {
				if (!destroyed) {
					testButton.disabled = false;
				}
			}
		});
		row.appendChild(testButton);

		const disableButton = document.createElement("button");
		disableButton.type = "button";
		disableButton.textContent = "Disable";
		disableButton.addEventListener("click", async () => {
			disableButton.disabled = true;
			try {
				const endpoint = subscription.endpoint;
				await subscription.unsubscribe();
				await apiFetch("/api/push/subscribe", {
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ endpoint }),
				}).catch(() => undefined);
				if (!destroyed) {
					await loadPushState();
				}
			} catch (err) {
				console.error("brief: disable push failed", err);
				if (!destroyed) {
					disableButton.disabled = false;
				}
			}
		});
		row.appendChild(disableButton);

		card.appendChild(row);
		const hint = iosHint();
		if (hint) {
			card.appendChild(hint);
		}
		pushBody.appendChild(card);
	}

	function renderPushDisabled() {
		pushBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "notifications-card";

		const enableButton = document.createElement("button");
		enableButton.type = "button";
		enableButton.className = "primary";
		enableButton.textContent = "Enable morning push";
		enableButton.addEventListener("click", enablePush);
		card.appendChild(enableButton);

		const hint = iosHint();
		if (hint) {
			card.appendChild(hint);
		}
		pushBody.appendChild(card);
	}

	function renderPushUnsupported() {
		pushBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "notifications-card";
		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = "Push notifications aren't supported in this browser.";
		card.appendChild(p);
		const hint = iosHint();
		if (hint) {
			card.appendChild(hint);
		}
		pushBody.appendChild(card);
	}

	async function subscribeAndRegister() {
		const registration = await navigator.serviceWorker.ready;
		let subscription = await registration.pushManager.getSubscription();
		if (!subscription) {
			const keyRes = await apiFetch("/api/push/vapid-public-key");
			if (!keyRes.ok) {
				throw new Error(`http ${keyRes.status}`);
			}
			const { key } = await keyRes.json();
			subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: base64UrlToUint8Array(key),
			});
		}

		const subscribeRes = await apiFetch("/api/push/subscribe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(subscription.toJSON()),
		});
		if (!subscribeRes.ok) {
			throw new Error(`http ${subscribeRes.status}`);
		}
		return subscription;
	}

	async function enablePush() {
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				return;
			}
			const subscription = await subscribeAndRegister();
			if (!destroyed) {
				await renderPushEnabled(subscription);
			}
		} catch (err) {
			console.error("brief: enable push failed", err);
		}
	}

	async function loadPushState() {
		if (!pushSupported()) {
			renderPushUnsupported();
			return;
		}
		pushBody.innerHTML = `<p class="hint">Loading…</p>`;
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (destroyed) {
				return;
			}
			if (subscription) {
				// Re-POST on load so a key rotation or reinstalled service worker's subscription
				// stays registered server-side (idempotent upsert on the endpoint).
				try {
					await apiFetch("/api/push/subscribe", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(subscription.toJSON()),
					});
				} catch (err) {
					console.error("brief: re-registering push subscription failed", err);
				}
				if (!destroyed) {
					await renderPushEnabled(subscription);
				}
			} else if (!destroyed) {
				renderPushDisabled();
			}
		} catch (err) {
			console.error("brief: failed to read push state", err);
			if (!destroyed) {
				renderPushDisabled();
			}
		}
	}

	// --- Maintenance (F3 nightly reorganization, run on demand) ---

	function formatRunWhen(run) {
		const at = run.finished_at ?? run.started_at;
		try {
			return new Date(at).toLocaleString();
		} catch {
			return at;
		}
	}

	function formatRunResult(run) {
		if (run.status === "ok") {
			return `ok: ${run.notes_ok} notes organized`;
		}
		if (run.status === "partial") {
			return `partial: ${run.notes_ok} ok, ${run.notes_failed} quarantined`;
		}
		if (run.status === "failed") {
			return `failed: ${run.error ?? "unknown error"}`;
		}
		return run.status;
	}

	async function loadMaintenance() {
		maintenanceBody.innerHTML = `<p class="hint">Loading…</p>`;

		let lastRun;
		try {
			const res = await apiFetch("/api/reorganize/runs?limit=1");
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			const data = await res.json();
			lastRun = (data.runs ?? [])[0];
		} catch (err) {
			console.error("brief: failed to load reorganization runs", err);
			if (!destroyed) {
				maintenanceBody.innerHTML = `<p class="hint">Couldn't load reorganization status.</p>`;
			}
			return;
		}
		if (destroyed) {
			return;
		}

		maintenanceBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "maintenance-card";

		const lastRunLine = document.createElement("p");
		lastRunLine.className = "maintenance-last-run";
		lastRunLine.textContent = lastRun
			? `Last run: ${formatRunWhen(lastRun)} — ${formatRunResult(lastRun)}`
			: "No reorganization runs yet.";
		card.appendChild(lastRunLine);

		const runButton = document.createElement("button");
		runButton.type = "button";
		runButton.className = "primary";
		runButton.textContent = "Organize notes now";
		runButton.addEventListener("click", async () => {
			runButton.disabled = true;
			runButton.textContent = "Organizing…";
			try {
				const res = await apiFetch("/api/reorganize/run", { method: "POST" });
				if (!res.ok) {
					throw new Error(`http ${res.status}`);
				}
			} catch (err) {
				console.error("brief: failed to run reorganization", err);
			} finally {
				if (!destroyed) {
					await loadMaintenance();
				}
			}
		});
		card.appendChild(runButton);

		maintenanceBody.appendChild(card);
	}

	// --- Memory (PRD §8 Option A) ---

	function memoryProposedRow(fact) {
		const row = document.createElement("div");
		row.className = "memory-row";

		const text = document.createElement("div");
		text.className = "memory-text";
		text.textContent = fact.text;
		row.appendChild(text);

		const actions = document.createElement("div");
		actions.className = "memory-actions";

		const keepButton = document.createElement("button");
		keepButton.type = "button";
		keepButton.textContent = "✓ Keep";
		keepButton.addEventListener("click", () => updateMemoryStatus(fact.id, "active", row));
		actions.appendChild(keepButton);

		const discardButton = document.createElement("button");
		discardButton.type = "button";
		discardButton.textContent = "✕ Discard";
		discardButton.addEventListener("click", () => discardMemoryFact(fact.id, row));
		actions.appendChild(discardButton);

		row.appendChild(actions);
		return row;
	}

	function startEditingMemory(row, fact) {
		row.innerHTML = "";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "memory-edit-input";
		input.value = fact.text;
		input.maxLength = 200;
		row.appendChild(input);
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);

		let settled = false;

		async function save() {
			if (settled) {
				return;
			}
			settled = true;
			const newText = input.value.trim();
			if (newText.length === 0 || newText === fact.text) {
				if (!destroyed) {
					await loadMemory();
				}
				return;
			}
			try {
				const res = await apiFetch(`/api/memory/${fact.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: newText }),
				});
				if (!res.ok) {
					throw new Error(`http ${res.status}`);
				}
			} catch (err) {
				console.error("brief: failed to edit memory fact", err);
			} finally {
				if (!destroyed) {
					await loadMemory();
				}
			}
		}

		input.addEventListener("blur", save);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				input.blur();
			} else if (event.key === "Escape") {
				settled = true;
				if (!destroyed) {
					loadMemory();
				}
			}
		});
	}

	function memoryActiveRow(fact) {
		const row = document.createElement("div");
		row.className = "memory-row";

		const textButton = document.createElement("button");
		textButton.type = "button";
		textButton.className = "memory-text memory-text-editable";
		textButton.textContent = fact.text;
		textButton.addEventListener("click", () => startEditingMemory(row, fact));
		row.appendChild(textButton);

		const actions = document.createElement("div");
		actions.className = "memory-actions";

		const archiveButton = document.createElement("button");
		archiveButton.type = "button";
		archiveButton.textContent = "Archive";
		archiveButton.addEventListener("click", () => updateMemoryStatus(fact.id, "archived", row));
		actions.appendChild(archiveButton);

		row.appendChild(actions);
		return row;
	}

	async function updateMemoryStatus(id, status, row) {
		const parent = row.parentElement;
		const nextSibling = row.nextSibling;
		row.remove();
		try {
			const res = await apiFetch(`/api/memory/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status }),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyed) {
				await loadMemory();
			}
		} catch (err) {
			console.error("brief: failed to update memory fact", err);
			if (!destroyed && parent) {
				parent.insertBefore(row, nextSibling);
			}
		}
	}

	async function discardMemoryFact(id, row) {
		const parent = row.parentElement;
		const nextSibling = row.nextSibling;
		row.remove();
		try {
			const res = await apiFetch(`/api/memory/${id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyed) {
				await loadMemory();
			}
		} catch (err) {
			console.error("brief: failed to discard memory fact", err);
			if (!destroyed && parent) {
				parent.insertBefore(row, nextSibling);
			}
		}
	}

	async function loadMemoryPreviewInto(container) {
		container.innerHTML = `<p class="hint">Loading…</p>`;
		try {
			const res = await apiFetch("/api/memory/preview");
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			const data = await res.json();
			if (destroyed) {
				return;
			}
			container.innerHTML = "";
			const pre = document.createElement("pre");
			pre.className = "memory-preview-block";
			pre.textContent = data.block.length > 0 ? data.block : "(empty — no active facts)";
			container.appendChild(pre);
			const count = document.createElement("p");
			count.className = "hint";
			count.textContent = `${data.chars} characters`;
			container.appendChild(count);
		} catch (err) {
			console.error("brief: failed to load memory preview", err);
			if (!destroyed) {
				container.innerHTML = `<p class="hint">Couldn't load the preview.</p>`;
			}
		}
	}

	function memoryAddRow() {
		const row = document.createElement("div");
		row.className = "memory-add-row";

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Add a fact…";
		input.maxLength = 200;

		const button = document.createElement("button");
		button.type = "button";
		button.className = "primary";
		button.textContent = "Add";

		async function submit() {
			const text = input.value.trim();
			if (text.length === 0) {
				return;
			}
			button.disabled = true;
			try {
				const res = await apiFetch("/api/memory", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				});
				if (!res.ok) {
					throw new Error(`http ${res.status}`);
				}
				if (!destroyed) {
					await loadMemory();
				}
			} catch (err) {
				console.error("brief: failed to add memory fact", err);
				if (!destroyed) {
					button.disabled = false;
				}
			}
		}

		button.addEventListener("click", submit);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				submit();
			}
		});

		row.appendChild(input);
		row.appendChild(button);
		return row;
	}

	function memoryPreviewDetails() {
		const details = document.createElement("details");
		details.className = "memory-preview";

		const summary = document.createElement("summary");
		summary.textContent = "What Orla sees";
		details.appendChild(summary);

		const previewBody = document.createElement("div");
		previewBody.className = "memory-preview-body";
		details.appendChild(previewBody);

		details.addEventListener("toggle", () => {
			if (details.open) {
				loadMemoryPreviewInto(previewBody);
			}
		});

		return details;
	}

	async function loadMemory() {
		memoryBody.innerHTML = `<p class="hint">Loading…</p>`;
		let res;
		try {
			res = await apiFetch("/api/memory");
		} catch (err) {
			console.error("brief: failed to load memory", err);
			if (!destroyed) {
				memoryBody.innerHTML = `<p class="hint">Couldn't load memory.</p>`;
			}
			return;
		}
		if (destroyed) {
			return;
		}
		if (!res.ok) {
			memoryBody.innerHTML = `<p class="hint">Couldn't load memory.</p>`;
			return;
		}

		const data = await res.json();
		const facts = data.facts ?? [];
		const proposed = facts.filter((f) => f.status === "proposed");
		const active = facts.filter((f) => f.status === "active");

		memoryBody.innerHTML = "";

		if (proposed.length > 0) {
			const heading = document.createElement("div");
			heading.className = "memory-subheading";
			heading.textContent = "Proposed";
			memoryBody.appendChild(heading);
			for (const fact of proposed) {
				memoryBody.appendChild(memoryProposedRow(fact));
			}
		}

		const activeHeading = document.createElement("div");
		activeHeading.className = "memory-subheading";
		activeHeading.textContent = "Active";
		memoryBody.appendChild(activeHeading);
		if (active.length === 0) {
			const p = document.createElement("p");
			p.className = "hint";
			p.textContent = "No facts yet.";
			memoryBody.appendChild(p);
		} else {
			for (const fact of active) {
				memoryBody.appendChild(memoryActiveRow(fact));
			}
		}

		memoryBody.appendChild(memoryAddRow());
		memoryBody.appendChild(memoryPreviewDetails());
	}

	// --- Passkeys (Phase 3 step 1) ---

	function formatPasskeyWhen(iso) {
		if (!iso) {
			return "never";
		}
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function passkeyRow(credential, onRemoved, showPasskeysError) {
		const row = document.createElement("div");
		row.className = "passkey-row";

		const info = document.createElement("div");
		info.className = "passkey-info";

		const name = document.createElement("div");
		name.className = "passkey-name";
		name.textContent = credential.name || "Unnamed passkey";
		info.appendChild(name);

		const meta = document.createElement("div");
		meta.className = "passkey-meta hint";
		meta.textContent = `Added ${formatPasskeyWhen(credential.created_at)} · Last used ${formatPasskeyWhen(credential.last_used_at)}`;
		info.appendChild(meta);

		row.appendChild(info);

		const removeButton = document.createElement("button");
		removeButton.type = "button";
		removeButton.textContent = "Remove";
		removeButton.addEventListener("click", async () => {
			removeButton.disabled = true;
			try {
				const res = await apiFetch(`/api/auth/credentials/${credential.id}`, {
					method: "DELETE",
				});
				if (res.status === 409) {
					showPasskeysError("You can't remove your last passkey.");
					if (!destroyed) {
						removeButton.disabled = false;
					}
					return;
				}
				if (!res.ok && res.status !== 204) {
					throw new Error(`http ${res.status}`);
				}
				onRemoved();
			} catch (err) {
				console.error("brief: failed to remove passkey", err);
				showPasskeysError("Couldn't remove that passkey.");
				if (!destroyed) {
					removeButton.disabled = false;
				}
			}
		});
		row.appendChild(removeButton);

		return row;
	}

	function passkeyAddRow(errBox) {
		const row = document.createElement("div");
		row.className = "passkey-add-row";

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Name this passkey";
		input.value = navigator.userAgentData?.platform || "This device";
		input.maxLength = 60;

		const button = document.createElement("button");
		button.type = "button";
		button.className = "primary";
		button.textContent = "Add another passkey";

		async function submit() {
			button.disabled = true;
			errBox.hidden = true;
			try {
				const optionsRes = await apiFetch("/api/auth/register/options", { method: "POST" });
				if (!optionsRes.ok) {
					throw new Error(`http ${optionsRes.status}`);
				}
				const optionsJson = await optionsRes.json();
				const credential = await navigator.credentials.create({
					publicKey: toCreationOptions(optionsJson),
				});
				const verifyRes = await apiFetch("/api/auth/register/verify", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						response: credentialToJSON(credential),
						name: input.value.trim() || "This device",
					}),
				});
				if (!verifyRes.ok) {
					throw new Error(`http ${verifyRes.status}`);
				}
				if (!destroyed) {
					await loadPasskeys();
				}
			} catch (err) {
				console.error("brief: failed to add passkey", err);
				if (!destroyed) {
					errBox.textContent =
						err?.name === "NotAllowedError" ? "Cancelled." : "Couldn't add that passkey.";
					errBox.hidden = false;
					button.disabled = false;
				}
			}
		}

		button.addEventListener("click", submit);

		row.appendChild(input);
		row.appendChild(button);
		return row;
	}

	async function signOutOfPasskeys(button) {
		button.disabled = true;
		try {
			const res = await apiFetch("/api/auth/logout", { method: "POST" });
			if (!res.ok && res.status !== 204) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("brief: sign out failed", err);
		} finally {
			// Reload unconditionally: whether or not the request succeeded, the freshest
			// source of truth for whether we're still signed in is a fresh /api/auth/status.
			window.location.reload();
		}
	}

	async function loadPasskeys() {
		if (!passkeysBody) {
			return;
		}
		passkeysBody.innerHTML = `<p class="hint">Loading…</p>`;

		let res;
		try {
			res = await apiFetch("/api/auth/credentials");
		} catch (err) {
			console.error("brief: failed to load passkeys", err);
			if (!destroyed) {
				passkeysBody.innerHTML = `<p class="hint">Couldn't load passkeys.</p>`;
			}
			return;
		}
		if (destroyed) {
			return;
		}
		if (!res.ok) {
			passkeysBody.innerHTML = `<p class="hint">Couldn't load passkeys.</p>`;
			return;
		}

		const data = await res.json();
		const credentials = data.credentials ?? [];

		passkeysBody.innerHTML = "";
		const card = document.createElement("div");
		card.className = "passkeys-card";

		const errBox = document.createElement("p");
		errBox.className = "passkeys-error hint";
		errBox.hidden = true;

		function showPasskeysError(message) {
			errBox.textContent = message;
			errBox.hidden = false;
		}

		if (credentials.length === 0) {
			const p = document.createElement("p");
			p.className = "hint";
			p.textContent = "No passkeys yet.";
			card.appendChild(p);
		} else {
			for (const credential of credentials) {
				card.appendChild(passkeyRow(credential, loadPasskeys, showPasskeysError));
			}
		}

		card.appendChild(passkeyAddRow(errBox));
		card.appendChild(errBox);

		const signOutButton = document.createElement("button");
		signOutButton.type = "button";
		signOutButton.className = "passkeys-signout";
		signOutButton.textContent = "Sign out";
		signOutButton.addEventListener("click", () => signOutOfPasskeys(signOutButton));
		card.appendChild(signOutButton);

		passkeysBody.appendChild(card);
	}

	loadBrief();
	loadActionItems();
	loadPushState();
	loadMaintenance();
	loadMemory();
	loadPasskeys();

	return function unmount() {
		destroyed = true;
	};
}
