import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("static assets", () => {
	it("serves the PWA shell at /", async () => {
		const res = await SELF.fetch("http://example.com/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("manifest.webmanifest");
		expect(body).toContain("/assets/");
	});

	it("serves the built JS bundle referenced from /", async () => {
		const res = await SELF.fetch("http://example.com/");
		const body = await res.text();
		const match = body.match(/src="(\/assets\/[^"]+\.js)"/);
		expect(match).not.toBeNull();
		const bundleRes = await SELF.fetch(new URL(match?.[1] ?? "", "http://example.com"));
		expect(bundleRes.status).toBe(200);
		const contentType = bundleRes.headers.get("content-type") ?? "";
		expect(/application\/javascript|text\/javascript/.test(contentType)).toBe(true);
	});

	it("serves the manifest with the app name", async () => {
		const res = await SELF.fetch("http://example.com/manifest.webmanifest");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('"Orla"');
	});

	it("serves the service worker with the precache manifest injected", async () => {
		const res = await SELF.fetch("http://example.com/sw.js");
		expect(res.status).toBe(200);
		const contentType = res.headers.get("content-type") ?? "";
		expect(/application\/javascript|text\/javascript/.test(contentType)).toBe(true);
		const body = await res.text();
		expect(body).not.toContain("__PRECACHE_MANIFEST__");
		expect(body).toContain('"/assets/');
	});

	it("serves the outbox module", async () => {
		const res = await SELF.fetch("http://example.com/outbox.js");
		expect(res.status).toBe(200);
		const contentType = res.headers.get("content-type") ?? "";
		expect(/application\/javascript|text\/javascript/.test(contentType)).toBe(true);
	});
});
