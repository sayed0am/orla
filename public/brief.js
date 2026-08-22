/** Brief tab: today's morning brief, action items, and push notification setup (PRD F4). */

import { apiFetch } from "./api.js";
import { renderMarkdown } from "./markdown.js";

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

export function mountBrief(root) {
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
	`;
	root.appendChild(view);

	const dateLabel = view.querySelector("#brief-date-label");
	const prevButton = view.querySelector("#brief-prev");
	const nextButton = view.querySelector("#brief-next");
	const briefBody = view.querySelector("#brief-body");
	const actionItemsBody = view.querySelector("#action-items-body");
	const pushBody = view.querySelector("#push-body");

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

	loadBrief();
	loadActionItems();
	loadPushState();

	return function unmount() {
		destroyed = true;
	};
}
