/** Hash-based tab router for the Orla PWA shell (PRD F1, F2). */

import { mountBrief } from "./brief.js";
import { mountCapture } from "./capture.js";
import { mountChat } from "./chat.js";
import { mountCosts } from "./costs.js";
import { mountJournal } from "./journal.js";

const DEFAULT_TAB = "capture";
const MOUNTERS = {
	capture: mountCapture,
	chat: mountChat,
	brief: mountBrief,
	journal: mountJournal,
	costs: mountCosts,
};

// "#notes" is a legacy alias (old bookmarks, the service worker shell) for Journal's Raw view.
const NOTES_ALIAS = "notes";

const main = document.getElementById("main");
const signedOutBanner = document.getElementById("signed-out");
const updateBanner = document.getElementById("update-banner");
const updateReloadButton = document.getElementById("update-reload");
const tabs = Array.from(document.querySelectorAll(".tab"));

let currentUnmount;

function tabFromHash() {
	const hash = window.location.hash.replace(/^#/, "");
	if (hash === NOTES_ALIAS) {
		return "journal";
	}
	return hash in MOUNTERS ? hash : DEFAULT_TAB;
}

function setActiveTab(tab) {
	for (const el of tabs) {
		el.classList.toggle("active", el.dataset.tab === tab);
	}
}

function render() {
	const rawHash = window.location.hash.replace(/^#/, "");
	const tab = tabFromHash();
	setActiveTab(tab);

	if (typeof currentUnmount === "function") {
		currentUnmount();
		currentUnmount = undefined;
	}

	main.replaceChildren();
	const mount = MOUNTERS[tab];
	currentUnmount = mount(main);

	if (rawHash === NOTES_ALIAS && typeof currentUnmount.openRaw === "function") {
		currentUnmount.openRaw();
	}
}

window.addEventListener("hashchange", render);

if (!window.location.hash) {
	window.location.hash = `#${DEFAULT_TAB}`;
} else {
	render();
}

/** Reports an API auth failure (401/403) by showing the signed-out banner. */
export function reportAuthFailure() {
	signedOutBanner.hidden = false;
}

if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("sw.js", { type: "module" }).catch((err) => {
			console.error("service worker registration failed", err);
		});
	});

	// A new service worker just took control (i.e. a fresh deploy was installed).
	// Show a small, dismissible banner rather than reloading mid-capture.
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		updateBanner.hidden = false;
	});

	updateReloadButton.addEventListener("click", () => {
		window.location.reload();
	});
}
