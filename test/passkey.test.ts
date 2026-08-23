import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import worker from "../src/index";
import { PasskeyError, verifyAuthentication, verifyRegistration } from "../src/passkey";
import {
	clearSessionCookie,
	createSession,
	SESSION_COOKIE_NAME,
	sessionCookie,
	verifySession,
} from "../src/session";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";
import {
	base64UrlEncode,
	buildAuthenticationResponse,
	buildRegistrationResponse,
	createEs256Authenticator,
	createRs256Authenticator,
	storedCredentialFields,
} from "./passkey-helpers";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const CHALLENGE = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

// Some tests below authenticate via `withAccessHeader()` (Access mode, the pool default — see
// vitest.config.ts) to exercise the `requireAuth`-gated routes; that needs a fake JWKS fetch
// installed regardless of whether test/auth.test.ts's own beforeAll/afterAll has run yet, since
// vitest-pool-workers runs test files in one shared worker and file order isn't guaranteed.
beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

// The `credentials`/`auth_challenges` tables are only touched by these tests; storage persists
// across the whole vitest run (isolatedStorage: false — see vitest.config.ts), so each test starts
// from a clean slate regardless of file/test order.
beforeEach(async () => {
	await env.ORLA_DB.prepare("DELETE FROM auth_challenges").run();
	await env.ORLA_DB.prepare("DELETE FROM credentials").run();
});

/** Inserts a credential row directly, bypassing the registration ceremony, for tests that only
 * care about session/credential plumbing rather than WebAuthn verification itself. */
async function insertCredential(
	authenticator: Awaited<ReturnType<typeof createEs256Authenticator>>,
	name = "",
): Promise<string> {
	const id = base64UrlEncode(authenticator.credentialId);
	const stored = await storedCredentialFields(authenticator);
	await env.ORLA_DB.prepare(
		`INSERT INTO credentials (id, public_key_jwk, alg, sign_count, transports, name)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, JSON.stringify(stored.publicKeyJwk), stored.alg, 0, "[]", name)
		.run();
	return id;
}

describe("verifyRegistration", () => {
	it("verifies an ES256 registration and extracts the public key", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			transports: ["internal", "hybrid"],
		});

		const result = await verifyRegistration({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			rpId: RP_ID,
		});

		expect(result.credentialId).toBe(base64UrlEncode(authenticator.credentialId));
		expect(result.alg).toBe(-7);
		expect(result.signCount).toBe(0);
		expect(result.transports).toEqual(["internal", "hybrid"]);
		expect(result.publicKeyJwk.kty).toBe("EC");
		expect(result.publicKeyJwk.crv).toBe("P-256");
	});

	it("verifies an RS256 registration and extracts the public key", async () => {
		const authenticator = await createRs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
		});

		const result = await verifyRegistration({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			rpId: RP_ID,
		});

		expect(result.alg).toBe(-257);
		expect(result.publicKeyJwk.kty).toBe("RSA");
		expect(result.transports).toEqual([]);
	});

	it("rejects a wrong origin", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: "https://evil.example",
			rpId: RP_ID,
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects a wrong challenge", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: "not-the-challenge-the-server-issued",
			origin: ORIGIN,
			rpId: RP_ID,
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects a wrong rpIdHash", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			authDataRpId: `not-${RP_ID}`,
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects an unsupported attestation format", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			fmt: "packed",
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects the wrong clientData.type", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			type: "webauthn.get",
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects a non-empty attStmt for fmt none", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			attStmt: new Map([["sig", new Uint8Array([1, 2, 3])]]),
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects when the user-present flag is not set", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			flags: 0x40, // AT only, no UP
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects extension data", async () => {
		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			flags: 0x01 | 0x40 | 0x80, // UP + AT + ED
		});

		await expect(
			verifyRegistration({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
			}),
		).rejects.toThrow(PasskeyError);
	});
});

describe("verifyAuthentication", () => {
	it("verifies an ES256 assertion and returns the new sign count", async () => {
		const authenticator = await createEs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			signCount: 1,
		});

		const result = await verifyAuthentication({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			rpId: RP_ID,
			credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 0 },
		});

		expect(result.newSignCount).toBe(1);
	});

	it("verifies an RS256 assertion and returns the new sign count", async () => {
		const authenticator = await createRs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			signCount: 1,
		});

		const result = await verifyAuthentication({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			rpId: RP_ID,
			credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 0 },
		});

		expect(result.newSignCount).toBe(1);
	});

	it("allows a 0/0 sign count pair (authenticators with no counter support)", async () => {
		const authenticator = await createEs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			signCount: 0,
		});

		const result = await verifyAuthentication({
			response,
			expectedChallenge: CHALLENGE,
			expectedOrigin: ORIGIN,
			rpId: RP_ID,
			credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 0 },
		});

		expect(result.newSignCount).toBe(0);
	});

	it("rejects a replayed (non-increasing) sign count", async () => {
		const authenticator = await createEs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			signCount: 3,
		});

		await expect(
			verifyAuthentication({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
				credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 5 },
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects a tampered signature", async () => {
		const authenticator = await createEs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: ORIGIN,
			rpId: RP_ID,
			signCount: 1,
			tamperSignature: true,
		});

		await expect(
			verifyAuthentication({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
				credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 0 },
			}),
		).rejects.toThrow(PasskeyError);
	});

	it("rejects a wrong origin", async () => {
		const authenticator = await createEs256Authenticator();
		const stored = await storedCredentialFields(authenticator);
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: CHALLENGE,
			origin: "https://evil.example",
			rpId: RP_ID,
			signCount: 1,
		});

		await expect(
			verifyAuthentication({
				response,
				expectedChallenge: CHALLENGE,
				expectedOrigin: ORIGIN,
				rpId: RP_ID,
				credential: { publicKeyJwk: stored.publicKeyJwk, alg: stored.alg, signCount: 0 },
			}),
		).rejects.toThrow(PasskeyError);
	});
});

describe("session", () => {
	const SECRET = "test-session-secret-at-least-32-characters-long";
	const THIRTY_DAYS = 30 * 24 * 60 * 60;

	it("round-trips a session token", async () => {
		const token = await createSession(SECRET, { credentialId: "cred-1", now: 1000 });
		const payload = await verifySession(SECRET, token, 1500);
		expect(payload).toEqual({ cid: "cred-1", iat: 1000, exp: 1000 + THIRTY_DAYS });
	});

	it("rejects an expired token", async () => {
		const token = await createSession(SECRET, { credentialId: "cred-1", now: 1000 });
		const payload = await verifySession(SECRET, token, 1000 + THIRTY_DAYS + 1);
		expect(payload).toBeNull();
	});

	it("rejects a tampered payload", async () => {
		const token = await createSession(SECRET, { credentialId: "cred-1" });
		const [payloadB64, signatureB64] = token.split(".") as [string, string];
		const tampered = `${payloadB64}x.${signatureB64}`;
		expect(await verifySession(SECRET, tampered)).toBeNull();
	});

	it("rejects a token signed with a different secret", async () => {
		const token = await createSession(SECRET, { credentialId: "cred-1" });
		expect(await verifySession("a-completely-different-32-char-secret!!", token)).toBeNull();
	});

	it("rejects a malformed token", async () => {
		expect(await verifySession(SECRET, "not-a-valid-token")).toBeNull();
	});

	it("sessionCookie/clearSessionCookie carry the expected attributes", () => {
		const cookie = sessionCookie("abc.def");
		expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc.def`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");

		expect(clearSessionCookie()).toContain("Max-Age=0");
	});
});

describe("requireAuth in passkey mode (direct handler invocation)", () => {
	// SELF is a service binding to a worker whose env is fixed for the whole pool run (see
	// vitest.config.ts: AUTH_MODE is pinned to "access" so existing Access-mode tests are
	// unaffected) — it can't be overridden per test. Invoking the exported handler directly with a
	// constructed env exercises the exact same route table and `requireAuth` call in-process.
	it("401 without a cookie, 200 with a valid cookie on /api/notes", async () => {
		const testEnv: Env = { ...env, AUTH_MODE: "passkey" };

		const unauthedRes = await worker.fetch(new Request("http://example.com/api/notes"), testEnv);
		expect(unauthedRes.status).toBe(401);

		// The session must be bound to a credential that actually exists (audit fix 2).
		const credentialId = await insertCredential(await createEs256Authenticator());
		const token = await createSession(testEnv.SESSION_SECRET, { credentialId });
		const authedRes = await worker.fetch(
			new Request("http://example.com/api/notes", {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
			}),
			testEnv,
		);
		expect(authedRes.status).toBe(200);
	});

	it("fails closed with 500 when SESSION_SECRET is missing or too short", async () => {
		const testEnv: Env = { ...env, AUTH_MODE: "passkey", SESSION_SECRET: "too-short" };
		const res = await worker.fetch(new Request("http://example.com/api/notes"), testEnv);
		expect(res.status).toBe(500);
	});
});

describe("HTTP routes (via SELF)", () => {
	it("GET /api/auth/status reports mode, has_credentials, authenticated", async () => {
		const res = await SELF.fetch("http://example.com/api/auth/status");
		expect(res.status).toBe(200);
		const body = await res.json<{
			mode: string;
			has_credentials: boolean;
			authenticated: boolean;
		}>();
		expect(body.mode).toBe("access");
		expect(body.has_credentials).toBe(false);
		expect(body.authenticated).toBe(false);
	});

	it("bootstraps the first passkey without auth and sets a session cookie", async () => {
		const optionsRes = await SELF.fetch("http://example.com/api/auth/register/options", {
			method: "POST",
		});
		expect(optionsRes.status).toBe(200);
		const options = await optionsRes.json<{ challenge: string; attestation: string }>();
		expect(options.attestation).toBe("none");

		const authenticator = await createEs256Authenticator();
		const response = await buildRegistrationResponse({
			authenticator,
			challenge: options.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});

		const verifyRes = await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response, name: "Test device" }),
		});
		expect(verifyRes.status).toBe(201);
		const body = await verifyRes.json<{ id: string; name: string }>();
		expect(body.id).toBe(base64UrlEncode(authenticator.credentialId));
		expect(body.name).toBe("Test device");
		expect(verifyRes.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE_NAME}=`);

		const statusRes = await SELF.fetch("http://example.com/api/auth/status");
		expect((await statusRes.json<{ has_credentials: boolean }>()).has_credentials).toBe(true);
	});

	it("register/options requires a session once a credential exists (bootstrap rule)", async () => {
		const authenticator = await createEs256Authenticator();
		const bootstrapOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const bootstrapResponse = await buildRegistrationResponse({
			authenticator,
			challenge: bootstrapOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: bootstrapResponse }),
		});

		const unauthed = await SELF.fetch("http://example.com/api/auth/register/options", {
			method: "POST",
		});
		expect(unauthed.status).toBe(401);

		const authed = await SELF.fetch(
			"http://example.com/api/auth/register/options",
			await withAccessHeader({ method: "POST" }),
		);
		expect(authed.status).toBe(200);
	});

	it("challenges are single-use and expire", async () => {
		const authenticator = await createEs256Authenticator();

		const expiredOptions = await (
			await SELF.fetch("http://example.com/api/auth/login/options", { method: "POST" })
		).json<{ challenge: string }>();
		await env.ORLA_DB.prepare("UPDATE auth_challenges SET expires_at = ? WHERE id = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), expiredOptions.challenge)
			.run();

		const expiredResponse = await buildAuthenticationResponse({
			authenticator,
			challenge: expiredOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
			signCount: 1,
		});
		const expiredRes = await SELF.fetch("http://example.com/api/auth/login/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: expiredResponse }),
		});
		expect(expiredRes.status).toBe(400);
		expect((await expiredRes.json<{ error: string }>()).error).toMatch(/challenge/);

		const options = await (
			await SELF.fetch("http://example.com/api/auth/login/options", { method: "POST" })
		).json<{ challenge: string }>();
		const response = await buildAuthenticationResponse({
			authenticator,
			challenge: options.challenge,
			origin: "http://example.com",
			rpId: "example.com",
			signCount: 1,
		});

		// First use fails for an unrelated reason (no such credential is registered), but the
		// challenge must be consumed regardless.
		const firstUse = await SELF.fetch("http://example.com/api/auth/login/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response }),
		});
		expect(firstUse.status).toBe(400);

		const secondUse = await SELF.fetch("http://example.com/api/auth/login/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response }),
		});
		expect(secondUse.status).toBe(400);
		expect((await secondUse.json<{ error: string }>()).error).toMatch(/challenge/);
	});

	it("full login flow updates sign_count and sets a cookie", async () => {
		const authenticator = await createEs256Authenticator();
		const regOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const regResponse = await buildRegistrationResponse({
			authenticator,
			challenge: regOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: regResponse }),
		});

		const loginOptions = await (
			await SELF.fetch("http://example.com/api/auth/login/options", { method: "POST" })
		).json<{ challenge: string; allowCredentials: { id: string }[] }>();
		expect(loginOptions.allowCredentials.map((c) => c.id)).toContain(
			base64UrlEncode(authenticator.credentialId),
		);

		const loginResponse = await buildAuthenticationResponse({
			authenticator,
			challenge: loginOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
			signCount: 1,
		});
		const loginRes = await SELF.fetch("http://example.com/api/auth/login/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: loginResponse }),
		});
		expect(loginRes.status).toBe(200);
		expect((await loginRes.json<{ ok: boolean }>()).ok).toBe(true);
		expect(loginRes.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE_NAME}=`);

		const row = await env.ORLA_DB.prepare("SELECT sign_count FROM credentials WHERE id = ?")
			.bind(base64UrlEncode(authenticator.credentialId))
			.first<{ sign_count: number }>();
		expect(row?.sign_count).toBe(1);
	});

	it("lists and deletes credentials; refuses to delete the last one", async () => {
		const authA = await createEs256Authenticator();
		const authB = await createEs256Authenticator();

		const optsA = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const respA = await buildRegistrationResponse({
			authenticator: authA,
			challenge: optsA.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: respA, name: "A" }),
		});

		const optsB = await (
			await SELF.fetch(
				"http://example.com/api/auth/register/options",
				await withAccessHeader({ method: "POST" }),
			)
		).json<{ challenge: string }>();
		const respB = await buildRegistrationResponse({
			authenticator: authB,
			challenge: optsB.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch(
			"http://example.com/api/auth/register/verify",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ response: respB, name: "B" }),
			}),
		);

		const listRes = await SELF.fetch(
			"http://example.com/api/auth/credentials",
			await withAccessHeader(),
		);
		expect(listRes.status).toBe(200);
		const { credentials } = await listRes.json<{ credentials: { id: string; name: string }[] }>();
		expect(credentials).toHaveLength(2);

		const idA = base64UrlEncode(authA.credentialId);
		const idB = base64UrlEncode(authB.credentialId);

		const deleteA = await SELF.fetch(
			`http://example.com/api/auth/credentials/${idA}`,
			await withAccessHeader({ method: "DELETE" }),
		);
		expect(deleteA.status).toBe(204);

		const deleteB = await SELF.fetch(
			`http://example.com/api/auth/credentials/${idB}`,
			await withAccessHeader({ method: "DELETE" }),
		);
		expect(deleteB.status).toBe(409);

		const unauthedDelete = await SELF.fetch(`http://example.com/api/auth/credentials/${idB}`, {
			method: "DELETE",
		});
		expect(unauthedDelete.status).toBe(401);
	});

	it("logout clears the session cookie", async () => {
		const res = await SELF.fetch("http://example.com/api/auth/logout", { method: "POST" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
	});
});

describe("bootstrap race (audit fix 1)", () => {
	it("a bootstrap challenge minted before the owner registers is rejected once a credential exists", async () => {
		// Two callers each mint a bootstrap challenge while zero credentials exist.
		const staleOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const ownerOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();

		// The real owner registers first, using their own (different) challenge.
		const ownerAuthenticator = await createEs256Authenticator();
		const ownerResponse = await buildRegistrationResponse({
			authenticator: ownerAuthenticator,
			challenge: ownerOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		const ownerRes = await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: ownerResponse, name: "Owner" }),
		});
		expect(ownerRes.status).toBe(201);

		// The stale, still-unexpired bootstrap challenge is now unusable: no session was ever
		// presented, so `handleRegisterVerify`'s session gate rejects it before the challenge is
		// even consulted.
		const attacker = await createEs256Authenticator();
		const attackerResponse = await buildRegistrationResponse({
			authenticator: attacker,
			challenge: staleOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		const attackerRes = await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: attackerResponse }),
		});
		expect(attackerRes.status).toBe(401);
	});

	it("rejects a stale bootstrap challenge with 'bootstrap window closed' even with a valid session", async () => {
		// Mint a bootstrap challenge while zero credentials exist, but never consume it yet.
		const staleOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();

		// A credential now exists (via a separate, legitimate bootstrap registration).
		const ownerAuthenticator = await createEs256Authenticator();
		const ownerOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const ownerResponse = await buildRegistrationResponse({
			authenticator: ownerAuthenticator,
			challenge: ownerOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: ownerResponse }),
		});

		// Replaying the stale bootstrap challenge, this time presenting a valid session (Access
		// mode, the pool default), still fails — the `bootstrap` column makes the rejection
		// structural, not merely a side effect of the caller lacking a session.
		const attacker = await createEs256Authenticator();
		const attackerResponse = await buildRegistrationResponse({
			authenticator: attacker,
			challenge: staleOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		const res = await SELF.fetch(
			"http://example.com/api/auth/register/verify",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ response: attackerResponse }),
			}),
		);
		expect(res.status).toBe(401);
		expect((await res.json<{ error: string }>()).error).toBe("bootstrap window closed");
	});

	it("register/verify requires a session once a credential exists; a valid session succeeds", async () => {
		const ownerAuthenticator = await createEs256Authenticator();
		const ownerOptions = await (
			await SELF.fetch("http://example.com/api/auth/register/options", { method: "POST" })
		).json<{ challenge: string }>();
		const ownerResponse = await buildRegistrationResponse({
			authenticator: ownerAuthenticator,
			challenge: ownerOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});
		await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: ownerResponse }),
		});

		// A fresh challenge minted now (with credentials present) is not bootstrap — register/options
		// itself already requires a session to mint it.
		const secondOptions = await (
			await SELF.fetch(
				"http://example.com/api/auth/register/options",
				await withAccessHeader({ method: "POST" }),
			)
		).json<{ challenge: string }>();
		const secondAuthenticator = await createEs256Authenticator();
		const secondResponse = await buildRegistrationResponse({
			authenticator: secondAuthenticator,
			challenge: secondOptions.challenge,
			origin: "http://example.com",
			rpId: "example.com",
		});

		const unauthedVerify = await SELF.fetch("http://example.com/api/auth/register/verify", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response: secondResponse, name: "Second" }),
		});
		expect(unauthedVerify.status).toBe(401);

		const authedVerify = await SELF.fetch(
			"http://example.com/api/auth/register/verify",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ response: secondResponse, name: "Second" }),
			}),
		);
		expect(authedVerify.status).toBe(201);
	});
});

describe("session-credential binding (audit fix 2)", () => {
	it("requireAuth (passkey mode) rejects a session whose credential was deleted; other sessions stay valid", async () => {
		const authA = await createEs256Authenticator();
		const authB = await createEs256Authenticator();
		const idA = await insertCredential(authA, "A");
		await insertCredential(authB, "B");

		const testEnv: Env = { ...env, AUTH_MODE: "passkey" };
		const tokenA = await createSession(testEnv.SESSION_SECRET, { credentialId: idA });
		const tokenB = await createSession(testEnv.SESSION_SECRET, {
			credentialId: base64UrlEncode(authB.credentialId),
		});

		const requestWith = (token: string) =>
			worker.fetch(
				new Request("http://example.com/api/notes", {
					headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
				}),
				testEnv,
			);

		expect((await requestWith(tokenA)).status).toBe(200);
		expect((await requestWith(tokenB)).status).toBe(200);

		await env.ORLA_DB.prepare("DELETE FROM credentials WHERE id = ?").bind(idA).run();

		expect((await requestWith(tokenA)).status).toBe(401);
		expect((await requestWith(tokenB)).status).toBe(200);
	});

	it("deleting the credential behind your own session clears the session cookie", async () => {
		const authA = await createEs256Authenticator();
		const authB = await createEs256Authenticator();
		const idA = await insertCredential(authA, "A");
		await insertCredential(authB, "B");

		const testEnv: Env = { ...env, AUTH_MODE: "passkey" };
		const tokenA = await createSession(testEnv.SESSION_SECRET, { credentialId: idA });

		const res = await worker.fetch(
			new Request(`http://example.com/api/auth/credentials/${idA}`, {
				method: "DELETE",
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${tokenA}` },
			}),
			testEnv,
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
		expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
	});

	it("deleting a different credential than your own session's does not clear your cookie", async () => {
		const authA = await createEs256Authenticator();
		const authB = await createEs256Authenticator();
		const idA = await insertCredential(authA, "A");
		const idB = await insertCredential(authB, "B");

		const testEnv: Env = { ...env, AUTH_MODE: "passkey" };
		const tokenA = await createSession(testEnv.SESSION_SECRET, { credentialId: idA });

		const res = await worker.fetch(
			new Request(`http://example.com/api/auth/credentials/${idB}`, {
				method: "DELETE",
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${tokenA}` },
			}),
			testEnv,
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("Set-Cookie")).toBeNull();
	});
});
