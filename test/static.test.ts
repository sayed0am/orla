import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("static assets", () => {
	it("serves the PWA shell at /", async () => {
		const res = await SELF.fetch("http://example.com/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("manifest.webmanifest");
	});

	it("serves the manifest with the app name", async () => {
		const res = await SELF.fetch("http://example.com/manifest.webmanifest");
		expect(res.status).toBe(200);
		const manifest = await res.json();
		expect(manifest).toMatchObject({ name: "Orla" });
	});

	it("serves the service worker as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/sw.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	it("serves the costs tab script as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/costs.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	it("serves the brief tab script as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/brief.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	it("serves the journal tab script as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/journal.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	it("serves the login view script as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/login.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});

	it("serves the webauthn helpers script as JavaScript", async () => {
		const res = await SELF.fetch("http://example.com/webauthn.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
	});
});
