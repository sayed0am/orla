/** Test-only helpers for signing Cloudflare Access JWTs and faking the JWKS endpoint. */

import type { AccessClaims } from "../src/auth";

export const TEST_TEAM_DOMAIN = "test.cloudflareaccess.com";
export const TEST_AUD = "test-aud";
export const TEST_KID = "test-kid";

let cachedKeyPair: CryptoKeyPair | undefined;

async function getKeyPair(): Promise<CryptoKeyPair> {
	if (!cachedKeyPair) {
		cachedKeyPair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
	}
	return cachedKeyPair;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(input: string): string {
	return base64UrlEncode(new TextEncoder().encode(input));
}

/** Signs a real RS256 Cloudflare Access JWT for tests. Claims fall back to sane defaults. */
export async function signAccessJwt(
	claims: Omit<Partial<AccessClaims>, "aud"> & { iss?: string; aud?: string | string[] } = {},
	kid = TEST_KID,
): Promise<string> {
	const { privateKey } = await getKeyPair();
	const now = Math.floor(Date.now() / 1000);

	const header = { alg: "RS256", typ: "JWT", kid };
	const payload = {
		email: claims.email ?? "user@example.com",
		sub: claims.sub ?? "test-sub",
		iat: claims.iat ?? now,
		exp: claims.exp ?? now + 3600,
		aud: claims.aud ?? TEST_AUD,
		iss: claims.iss ?? `https://${TEST_TEAM_DOMAIN}`,
	};

	const headerB64 = base64UrlEncodeString(JSON.stringify(header));
	const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
	const signingInput = `${headerB64}.${payloadB64}`;

	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** A `typeof fetch` that answers `/cdn-cgi/access/certs` with the test keypair's public JWK. */
export const fakeJwksFetch: typeof fetch = async () => {
	const { publicKey } = await getKeyPair();
	const jwk = await crypto.subtle.exportKey("jwk", publicKey);
	return new Response(JSON.stringify({ keys: [{ ...jwk, kid: TEST_KID }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};

/** Attaches a valid `Cf-Access-Jwt-Assertion` header to a fetch `RequestInit`. */
export async function withAccessHeader(init: RequestInit = {}): Promise<RequestInit> {
	const token = await signAccessJwt();
	const headers = new Headers(init.headers);
	headers.set("Cf-Access-Jwt-Assertion", token);
	return { ...init, headers };
}
