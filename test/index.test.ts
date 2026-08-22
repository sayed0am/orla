import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
	it("serves health", async () => {
		const res = await SELF.fetch("http://example.com/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, assistant: "Orla" });
	});
});
