import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireAuth, setJwksFetchForTests, verifyAccessJwt } from "../src/auth";
import { fakeJwksFetch, signAccessJwt, TEST_AUD, TEST_KID, TEST_TEAM_DOMAIN } from "./auth-helpers";

function base64UrlEncodeString(input: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(input)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(input: string): string {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return atob(padded);
}

function countingFetch(base: typeof fetch): { fetch: typeof fetch; count: () => number } {
	let calls = 0;
	const wrapped: typeof fetch = async (input, init) => {
		calls++;
		return base(input, init);
	};
	return { fetch: wrapped, count: () => calls };
}

describe("verifyAccessJwt (unit)", () => {
	it("returns claims for a valid token", async () => {
		const token = await signAccessJwt();
		const claims = await verifyAccessJwt(token, {
			teamDomain: TEST_TEAM_DOMAIN,
			aud: TEST_AUD,
			fetchJwks: fakeJwksFetch,
		});
		expect(claims).toMatchObject({
			email: "user@example.com",
			sub: "test-sub",
			aud: [TEST_AUD],
		});
	});

	it("rejects an expired token", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await signAccessJwt({ iat: now - 7200, exp: now - 3600 });
		await expect(
			verifyAccessJwt(token, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("token expired");
	});

	it("rejects the wrong audience", async () => {
		const token = await signAccessJwt({ aud: "someone-elses-aud" });
		await expect(
			verifyAccessJwt(token, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("aud mismatch");
	});

	it("rejects the wrong issuer", async () => {
		const token = await signAccessJwt({ iss: "https://someone-else.cloudflareaccess.com" });
		await expect(
			verifyAccessJwt(token, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("iss mismatch");
	});

	it("rejects a tampered payload", async () => {
		const token = await signAccessJwt();
		const [headerB64, payloadB64, signatureB64] = token.split(".") as [string, string, string];
		const payload = JSON.parse(base64UrlDecodeToString(payloadB64));
		payload.sub = "attacker-sub";
		const tamperedPayloadB64 = base64UrlEncodeString(JSON.stringify(payload));
		const tampered = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

		await expect(
			verifyAccessJwt(tampered, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("invalid signature");
	});

	it("rejects alg: none", async () => {
		const header = base64UrlEncodeString(
			JSON.stringify({ alg: "none", typ: "JWT", kid: TEST_KID }),
		);
		const payload = base64UrlEncodeString(
			JSON.stringify({
				email: "user@example.com",
				sub: "test-sub",
				iat: 0,
				exp: 9_999_999_999,
				aud: TEST_AUD,
				iss: `https://${TEST_TEAM_DOMAIN}`,
			}),
		);
		const token = `${header}.${payload}.x`;

		await expect(
			verifyAccessJwt(token, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("unsupported alg");
	});

	it("rejects alg: HS256", async () => {
		const header = base64UrlEncodeString(
			JSON.stringify({ alg: "HS256", typ: "JWT", kid: TEST_KID }),
		);
		const payload = base64UrlEncodeString(
			JSON.stringify({
				email: "user@example.com",
				sub: "test-sub",
				iat: 0,
				exp: 9_999_999_999,
				aud: TEST_AUD,
				iss: `https://${TEST_TEAM_DOMAIN}`,
			}),
		);
		const token = `${header}.${payload}.x`;

		await expect(
			verifyAccessJwt(token, {
				teamDomain: TEST_TEAM_DOMAIN,
				aud: TEST_AUD,
				fetchJwks: fakeJwksFetch,
			}),
		).rejects.toThrow("unsupported alg");
	});

	it("refetches the JWKS once when the cache is absent, then fails on an unknown kid", async () => {
		const domain = "unknown-kid-absent-cache.cloudflareaccess.com";
		const { fetch: counted, count } = countingFetch(fakeJwksFetch);
		const token = await signAccessJwt({ iss: `https://${domain}` }, "some-other-kid");

		await expect(
			verifyAccessJwt(token, { teamDomain: domain, aud: TEST_AUD, fetchJwks: counted }),
		).rejects.toThrow("no matching key for kid");

		// Cache was empty, so the single lookup fetch doubles as the "unknown kid" attempt.
		expect(count()).toBe(1);
	});

	it("does not refetch on a second unknown kid within the cooldown window", async () => {
		// A domain unique to this test, so the cache starts empty regardless of test order.
		const domain = "unknown-kid-cooldown.cloudflareaccess.com";
		const { fetch: counted, count } = countingFetch(fakeJwksFetch);

		// Warm the cache (one fetch) with a token whose kid is genuinely unknown.
		const firstToken = await signAccessJwt({ iss: `https://${domain}` }, "some-other-kid");
		await expect(
			verifyAccessJwt(firstToken, { teamDomain: domain, aud: TEST_AUD, fetchJwks: counted }),
		).rejects.toThrow("no matching key for kid");
		expect(count()).toBe(1);

		// Immediately afterwards, a second unknown kid must not trigger another fetch —
		// the cache is fresh and within the 60s refetch cooldown.
		const secondToken = await signAccessJwt({ iss: `https://${domain}` }, "yet-another-kid");
		await expect(
			verifyAccessJwt(secondToken, { teamDomain: domain, aud: TEST_AUD, fetchJwks: counted }),
		).rejects.toThrow("no matching key for kid");
		expect(count()).toBe(1);
	});
});

describe("requireAuth / Access gate (integration)", () => {
	beforeAll(() => {
		setJwksFetchForTests(fakeJwksFetch);
	});

	afterAll(() => {
		setJwksFetchForTests(undefined);
	});

	it("GET /api/notes without a token returns 401", async () => {
		const res = await SELF.fetch("http://example.com/api/notes");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("GET /api/notes with a valid token returns 200", async () => {
		const token = await signAccessJwt();
		const res = await SELF.fetch("http://example.com/api/notes", {
			headers: { "Cf-Access-Jwt-Assertion": token },
		});
		expect(res.status).toBe(200);
	});

	it("GET /api/health without a token returns 200", async () => {
		const res = await SELF.fetch("http://example.com/api/health");
		expect(res.status).toBe(200);
	});

	it("returns 500 when ACCESS_AUD is not configured", async () => {
		const request = new Request("http://example.com/api/notes");
		const unconfiguredEnv: Env = { ...env, ACCESS_AUD: "" };
		const result = await requireAuth(request, unconfiguredEnv);
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(500);
		expect(await (result as Response).json()).toEqual({ error: "auth not configured" });
	});
});
