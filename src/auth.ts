/**
 * `requireAuth` gates every `/api/*` route (PRD §7 Security). It is mode-aware
 * (`env.AUTH_MODE`): `"access"` (default, unchanged) verifies a Cloudflare Access JWT; `"passkey"`
 * (Phase 3, docs/PLAN.md) verifies the `orla_session` cookie minted by `src/routes/auth.ts`. Both
 * modes resolve to the same `AuthPrincipal` shape so route handlers never need to know which one
 * is active.
 */

import { SESSION_COOKIE_NAME, verifySession } from "./session";

export type AccessClaims = {
	email: string;
	sub: string;
	exp: number;
	iat: number;
	aud: string[];
};

/** What every auth mode resolves to — deliberately narrow; no route reads more than `sub`. */
export type AuthPrincipal = {
	sub: string;
	via: "access" | "passkey";
};

export class AuthError extends Error {
	reason: string;

	constructor(reason: string) {
		super(reason);
		this.name = "AuthError";
		this.reason = reason;
	}
}

type Jwk = JsonWebKey & { kid?: string };

type JwksCacheEntry = {
	keys: Jwk[];
	fetchedAt: number;
};

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
// Rate-limits the unknown-kid refetch so an unauthenticated caller can't force a JWKS
// fetch per request by sending junk tokens with random kids.
const JWKS_REFETCH_COOLDOWN_MS = 60_000;
const jwksCache = new Map<string, JwksCacheEntry>();

// Test-only hook: the pool's worker can't intercept real `fetch` calls to
// cloudflareaccess.com, so tests install a fake JWKS fetch here instead.
let testJwksFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake JWKS fetch used by `requireAuth`. */
export function setJwksFetchForTests(f: typeof fetch | undefined): void {
	testJwksFetch = f;
}

function base64UrlDecode(input: string): Uint8Array {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - (normalized.length % 4)) % 4;
	const padded = normalized + "=".repeat(padLength);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function base64UrlDecodeToString(input: string): string {
	return new TextDecoder().decode(base64UrlDecode(input));
}

async function fetchJwks(teamDomain: string, fetchImpl: typeof fetch): Promise<Jwk[]> {
	const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) {
		throw new AuthError(`jwks fetch failed with status ${res.status}`);
	}

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new AuthError("jwks response was not valid JSON");
	}

	const keys =
		typeof data === "object" && data !== null && Array.isArray((data as { keys?: unknown }).keys)
			? (data as { keys: Jwk[] }).keys
			: [];

	jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
	return keys;
}

async function getSigningKey(
	teamDomain: string,
	kid: string,
	fetchImpl: typeof fetch,
): Promise<Jwk> {
	const cached = jwksCache.get(teamDomain);
	const isFresh = cached !== undefined && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS;

	let keys: Jwk[];
	let fetchedThisCall: boolean;
	if (isFresh) {
		keys = cached.keys;
		fetchedThisCall = false;
	} else {
		keys = await fetchJwks(teamDomain, fetchImpl);
		fetchedThisCall = true;
	}

	let key = keys.find((k) => k.kid === kid);

	if (!key && !fetchedThisCall) {
		// Unknown kid: the JWKS may have rotated. Refetch once before failing, but only if
		// the cache is absent or the last fetch is older than the cooldown — otherwise an
		// unauthenticated caller could force a JWKS fetch on every request by sending junk
		// tokens with random kids.
		const canRefetch =
			cached === undefined || Date.now() - cached.fetchedAt >= JWKS_REFETCH_COOLDOWN_MS;
		if (canRefetch) {
			keys = await fetchJwks(teamDomain, fetchImpl);
			key = keys.find((k) => k.kid === kid);
		}
	}

	if (!key) {
		throw new AuthError("no matching key for kid");
	}

	return key;
}

/** Verifies a Cloudflare Access JWT and returns its claims, or throws `AuthError`. */
export async function verifyAccessJwt(
	token: string,
	opts: { teamDomain: string; aud: string; fetchJwks?: typeof fetch; now?: number },
): Promise<AccessClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new AuthError("malformed token");
	}
	const [headerB64, payloadB64, signatureB64] = parts;
	if (!headerB64 || !payloadB64 || !signatureB64) {
		throw new AuthError("malformed token");
	}

	let header: { alg?: unknown; kid?: unknown };
	let payload: Record<string, unknown>;
	try {
		header = JSON.parse(base64UrlDecodeToString(headerB64));
		payload = JSON.parse(base64UrlDecodeToString(payloadB64));
	} catch {
		throw new AuthError("malformed token");
	}

	if (header.alg !== "RS256") {
		throw new AuthError("unsupported alg");
	}
	if (typeof header.kid !== "string" || header.kid.length === 0) {
		throw new AuthError("missing kid");
	}

	const fetchImpl = opts.fetchJwks ?? fetch;
	const jwk = await getSigningKey(opts.teamDomain, header.kid, fetchImpl);

	let cryptoKey: CryptoKey;
	try {
		cryptoKey = await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
	} catch {
		throw new AuthError("invalid signing key");
	}

	const signature = base64UrlDecode(signatureB64);
	const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
	if (!valid) {
		throw new AuthError("invalid signature");
	}

	const now = opts.now ?? Math.floor(Date.now() / 1000);

	const { exp, iat, aud, iss, email, sub } = payload;
	if (typeof exp !== "number" || typeof iat !== "number") {
		throw new AuthError("missing exp/iat claims");
	}
	if (!(exp > now)) {
		throw new AuthError("token expired");
	}
	if (!(iat <= now + 60)) {
		throw new AuthError("token issued in the future");
	}

	const audList = Array.isArray(aud)
		? aud.filter((a): a is string => typeof a === "string")
		: typeof aud === "string"
			? [aud]
			: [];
	if (!audList.includes(opts.aud)) {
		throw new AuthError("aud mismatch");
	}

	if (iss !== `https://${opts.teamDomain}`) {
		throw new AuthError("iss mismatch");
	}

	if (typeof email !== "string" || typeof sub !== "string") {
		throw new AuthError("missing email/sub claims");
	}

	return { email, sub, exp, iat, aud: audList };
}

function getCookie(request: Request, name: string): string | undefined {
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) {
		return undefined;
	}
	for (const part of cookieHeader.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) {
			continue;
		}
		if (part.slice(0, idx).trim() === name) {
			return decodeURIComponent(part.slice(idx + 1).trim());
		}
	}
	return undefined;
}

const MIN_SESSION_SECRET_LENGTH = 32;

async function requireAuthPasskey(request: Request, env: Env): Promise<AuthPrincipal | Response> {
	const secret = env.SESSION_SECRET;
	if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
		return Response.json({ error: "auth not configured" }, { status: 500 });
	}

	const token = getCookie(request, SESSION_COOKIE_NAME);
	if (!token) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const payload = await verifySession(secret, token);
	if (!payload) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	// The credential the session was minted for may since have been deleted (e.g. revoked from
	// another device) — a session surviving its credential would otherwise stay valid until it
	// naturally expires, up to 30 days later.
	const credentialRow = await env.ORLA_DB.prepare("SELECT 1 FROM credentials WHERE id = ?")
		.bind(payload.cid)
		.first();
	if (!credentialRow) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	return { sub: payload.cid, via: "passkey" };
}

async function requireAuthAccess(request: Request, env: Env): Promise<AuthPrincipal | Response> {
	const teamDomain = env.ACCESS_TEAM_DOMAIN;
	const aud = env.ACCESS_AUD;
	if (!teamDomain || !aud) {
		return Response.json({ error: "auth not configured" }, { status: 500 });
	}

	const token =
		request.headers.get("Cf-Access-Jwt-Assertion") ?? getCookie(request, "CF_Authorization");
	if (!token) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	try {
		const claims = await verifyAccessJwt(token, { teamDomain, aud, fetchJwks: testJwksFetch });
		return { sub: claims.sub, via: "access" };
	} catch {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
}

/**
 * Requires a valid principal on `request` per `env.AUTH_MODE` ("access", the default, or
 * "passkey"), returning `AuthPrincipal` or a 401/500 Response.
 */
export async function requireAuth(request: Request, env: Env): Promise<AuthPrincipal | Response> {
	if (env.AUTH_MODE === "passkey") {
		return requireAuthPasskey(request, env);
	}
	return requireAuthAccess(request, env);
}
