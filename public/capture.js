/** Instant capture box (PRD F2, G1: perceived save under 2s, works offline). */

import { addToOutbox, flushOutbox, listOutbox } from "./outbox.js";

let flushInFlight = null;

/** Runs a flush, coalescing concurrent callers into one in-flight request. */
function flushOnce() {
	if (!flushInFlight) {
		flushInFlight = flushOutbox().finally(() => {
			flushInFlight = null;
		});
	}
	return flushInFlight;
}

export function mountCapture(root) {
	const view = document.createElement("div");
	view.className = "capture-view";
	view.innerHTML = `
		<textarea
			id="capture-body"
			placeholder="Capture a thought…"
			autofocus
			rows="6"
		></textarea>
		<div class="capture-row">
			<label class="capture-private">
				<input type="checkbox" id="capture-private" />
				Private
			</label>
			<span class="pending-badge" id="capture-pending" hidden></span>
		</div>
		<div class="capture-row">
			<span class="hint">Cmd/Ctrl+Enter to save</span>
			<button type="button" class="primary" id="capture-save">Save</button>
		</div>
	`;
	root.appendChild(view);

	const textarea = view.querySelector("#capture-body");
	const privateCheckbox = view.querySelector("#capture-private");
	const saveButton = view.querySelector("#capture-save");
	const pendingBadge = view.querySelector("#capture-pending");

	let destroyed = false;

	async function updatePendingBadge() {
		const items = await listOutbox();
		if (destroyed) {
			return;
		}
		if (items.length > 0) {
			pendingBadge.hidden = false;
			pendingBadge.textContent = `${items.length} pending`;
		} else {
			pendingBadge.hidden = true;
		}
	}

	async function save() {
		const body = textarea.value.trim();
		if (body.length === 0) {
			return;
		}

		const item = {
			client_id: crypto.randomUUID(),
			body,
			private: privateCheckbox.checked,
			created_at: new Date().toISOString(),
		};

		// Clear immediately — the UI must never wait on the network (G1).
		textarea.value = "";
		privateCheckbox.checked = false;
		textarea.focus();

		await addToOutbox(item);
		await updatePendingBadge();

		flushOnce()
			.then(updatePendingBadge)
			.catch((err) => console.error("capture: flush failed", err));

		if ("serviceWorker" in navigator && "SyncManager" in window) {
			try {
				const registration = await navigator.serviceWorker.ready;
				await registration.sync.register("flush-notes");
			} catch (err) {
				console.error("capture: background sync registration failed", err);
			}
		}
	}

	saveButton.addEventListener("click", save);
	textarea.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			save();
		}
	});

	function onOnline() {
		flushOnce().then(updatePendingBadge);
	}
	function onVisible() {
		if (document.visibilityState === "visible") {
			flushOnce().then(updatePendingBadge);
		}
	}

	window.addEventListener("online", onOnline);
	document.addEventListener("visibilitychange", onVisible);

	textarea.focus();
	updatePendingBadge();
	flushOnce()
		.then(updatePendingBadge)
		.catch((err) => console.error("capture: initial flush failed", err));

	return function unmount() {
		destroyed = true;
		window.removeEventListener("online", onOnline);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
