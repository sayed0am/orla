import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Emits the service worker and outbox module to the dist root (unhashed, so `sw.js`'s static
 * import of `./outbox.js` resolves in production), injecting the precache manifest — the static
 * shell paths plus every hashed asset from this build — in place of the `__PRECACHE_MANIFEST__`
 * placeholder in app/sw/sw.js.
 */
function orlaSw(): Plugin {
	return {
		name: "orla-sw",
		apply: "build",
		generateBundle(_opts, bundle) {
			const hashed = Object.keys(bundle).map((f) => `/${f}`);
			const precache = [
				"/",
				"/index.html",
				"/manifest.webmanifest",
				"/fonts/outfit-var.woff2",
				"/icons/icon-192.png",
				"/icons/icon-512.png",
				"/icons/maskable-512.png",
				"/icons/favicon.png",
				"/outbox.js",
				...hashed,
			];
			const swSource = readFileSync(new URL("./sw/sw.js", import.meta.url), "utf8").replace(
				"self.__PRECACHE_MANIFEST__",
				JSON.stringify(precache),
			);
			this.emitFile({ type: "asset", fileName: "sw.js", source: swSource });
			this.emitFile({
				type: "asset",
				fileName: "outbox.js",
				source: readFileSync(new URL("./sw/outbox.js", import.meta.url), "utf8"),
			});
		},
	};
}

export default defineConfig({
	plugins: [react(), orlaSw()],
	build: { outDir: "../dist", emptyOutDir: true },
});
