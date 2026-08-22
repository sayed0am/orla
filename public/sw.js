/** Service worker: stale-while-revalidate app shell, network-only API, outbox flush on sync. */

import { flushOutbox } from "./outbox.js";

// Bumping CACHE_NAME only purges old caches on activate; it is never required to ship an
// update — the fetch handler below revalidates every shell file against the network on
// each request, so a new deploy is visible on the very next load.
const CACHE_NAME = "orla-shell-v1";
const SHELL_FILES = [
	"/",
	"/index.html",
	"/manifest.webmanifest",
	"/styles.css",
	"/app.js",
	"/capture.js",
	"/chat.js",
	"/markdown.js",
	"/notes.js",
	"/costs.js",
	"/api.js",
	"/outbox.js",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
	"/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(SHELL_FILES);
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
			);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);

	if (url.pathname.startsWith("/api/")) {
		// Network-only: never cache API responses.
		return;
	}

	if (event.request.mode === "navigate") {
		// Network-first so a new deploy is picked up immediately; fall back to the
		// cached shell when offline, and refresh that fallback on every success.
		event.respondWith(
			(async () => {
				try {
					const res = await fetch(event.request);
					if (res.ok) {
						const cache = await caches.open(CACHE_NAME);
						await cache.put("/index.html", res.clone());
					}
					return res;
				} catch (err) {
					console.error("sw: navigation fetch failed, falling back to cached shell", err);
					const cached = await caches.match("/index.html");
					return cached ?? Response.error();
				}
			})(),
		);
		return;
	}

	// Stale-while-revalidate: serve the cached copy immediately when present (fast,
	// works offline), while refreshing the cache from the network in the background
	// so the *next* load already has the new version — no CACHE_NAME bump needed.
	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			const cached = await cache.match(event.request);

			const networkFetch = fetch(event.request)
				.then((res) => {
					if (res.ok) {
						cache.put(event.request, res.clone());
					}
					return res;
				})
				.catch((err) => {
					console.error("sw: background revalidate fetch failed", err);
					return undefined;
				});

			event.waitUntil(networkFetch);

			if (cached) {
				return cached;
			}

			const networkResponse = await networkFetch;
			if (networkResponse) {
				return networkResponse;
			}
			throw new Error("sw: fetch failed with no cache entry");
		})(),
	);
});

self.addEventListener("sync", (event) => {
	if (event.tag === "flush-notes") {
		event.waitUntil(flushOutbox());
	}
});
