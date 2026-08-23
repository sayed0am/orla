/** Hash-based tab router for the Orla PWA shell (PRD F1, F2). */

import { mountBrief } from "./brief.js";
import { mountCapture } from "./capture.js";
import { mountChat } from "./chat.js";
import { mountCosts } from "./costs.js";
import { mountJournal } from "./journal.js";
import { mountLogin } from "./login.js";

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
const tabbar = document.querySelector(".tabbar");
const tabs = Array.from(document.querySelectorAll(".tab"));

let currentUnmount;

// Cached result of GET /api/auth/status, fetched once at boot. Unreachable or non-JSON
// responses (e.g. no server-side auth route yet, or Access already handled auth) degrade
// to "access" mode so the app behaves exactly as it always has. Passed to every tab mounter
// so the Brief tab's Passkeys card can tell whether to render itself.
let authStatus = { mode: "access", has_credentials: false, authenticated: true };

async function fetchAuthStatus() {
	try {
		const res = await fetch("/api/auth/status");
		if (!res.ok) {
			return { mode: "access", has_credentials: false, authenticated: true };
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return { mode: "access", has_credentials: false, authenticated: true };
		}
		const data = await res.json();
		if (data && (data.mode === "passkey" || data.mode === "access")) {
			return data;
		}
		return { mode: "access", has_credentials: false, authenticated: true };
	} catch (err) {
		console.error("app: failed to fetch auth status, defaulting to access mode", err);
		return { mode: "access", has_credentials: false, authenticated: true };
	}
}

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
	currentUnmount = mount(main, authStatus);

	if (rawHash === NOTES_ALIAS && typeof currentUnmount.openRaw === "function") {
		currentUnmount.openRaw();
	}
}

let appMode = false;

window.addEventListener("hashchange", () => {
	if (appMode) {
		render();
	}
});

function showApp() {
	appMode = true;
	if (typeof currentUnmount === "function") {
		currentUnmount();
		currentUnmount = undefined;
	}
	tabbar.hidden = false;
	if (!window.location.hash) {
		window.location.hash = `#${DEFAULT_TAB}`;
	} else {
		render();
	}
}

function showLogin() {
	appMode = false;
	if (typeof currentUnmount === "function") {
		currentUnmount();
		currentUnmount = undefined;
	}
	tabbar.hidden = true;
	main.replaceChildren();
	currentUnmount = mountLogin(main, authStatus, () => {
		authStatus = { ...authStatus, authenticated: true };
		showApp();
	});
}

async function boot() {
	authStatus = await fetchAuthStatus();
	if (authStatus.mode === "passkey" && !authStatus.authenticated) {
		showLogin();
	} else {
		showApp();
	}
}

// Hide the tab bar until boot() decides whether to show the app or the login view, so
// there's no flash of tabs over an empty (not-yet-mounted) main area.
tabbar.hidden = true;
boot();

/**
 * Reports an API auth failure (401/403). In passkey mode this swaps to the login view
 * (the session cookie expired or was revoked); in access mode it shows the signed-out
 * banner, since Access already redirected before any JS ran.
 */
export function reportAuthFailure() {
	if (authStatus.mode === "passkey") {
		if (appMode) {
			authStatus = { ...authStatus, authenticated: false };
			showLogin();
		}
		return;
	}
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
