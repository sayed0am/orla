/** Service worker registration. See app/src/hooks/useSwUpdate.ts for the update banner. */

export function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) {
		return;
	}

	window.addEventListener("load", () => {
		navigator.serviceWorker.register("sw.js", { type: "module" }).catch((err) => {
			console.error("service worker registration failed", err);
		});
	});
}
