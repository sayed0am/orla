/**
 * HTTP handlers for passkey (WebAuthn) authentication (Phase 3, docs/PLAN.md). Single-user
 * system: the `credentials` table holds every registered authenticator for the one owner, no
 * `users` table. These routes are wired in `src/index.ts` BEFORE the blanket `/api/*` auth gate —
 * they gate themselves, selectively, via `requireAuth` — since a caller with zero credentials has
 * no way to authenticate yet (bootstrap) and login/status must be reachable unauthenticated.
 */

import { requireAuth } from "../auth";
import {
	authenticationOptions,
	PasskeyError,
	registrationOptions,
	verifyAuthentication,
	verifyRegistration,
} from "../passkey";
import { clearSessionCookie, createSession, sessionCookie } from "../session";

/** Matches `/api/auth/credentials/:id` — credential ids are base64url strings. */
export const CREDENTIAL_PATH_RE = /^\/api\/auth\/credentials\/([A-Za-z0-9_-]+)$/;

const CHALLENGE_TTL_SECONDS = 5 * 60;
const MIN_SESSION_SECRET_LENGTH = 32;

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

function rpFromRequest(request: Request): { rpId: string; origin: string } {
	const url = new URL(request.url);
	return { rpId: url.hostname, origin: url.origin };
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}
	return payload as Record<string, unknown>;
}

/** Pulls `.challenge` out of a base64url `clientDataJSON`, before we know it's otherwise valid —
 * we need it to look up which single-use challenge row to consume. Full validation of the rest of
 * `clientDataJSON` happens inside `verifyRegistration`/`verifyAuthentication`. */
function extractChallenge(clientDataJsonB64: string): string {
	const bytes = base64UrlDecode(clientDataJsonB64);
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).challenge !== "string"
	) {
		throw new Error("clientDataJSON missing challenge");
	}
	return (parsed as { challenge: string }).challenge;
}

function extractClientDataChallenge(response: Record<string, unknown>): string | Response {
	const authenticatorResponse = response.response;
	if (typeof authenticatorResponse !== "object" || authenticatorResponse === null) {
		return Response.json({ error: "response.response missing" }, { status: 400 });
	}
	const clientDataJSON = (authenticatorResponse as Record<string, unknown>).clientDataJSON;
	if (typeof clientDataJSON !== "string") {
		return Response.json({ error: "response.response.clientDataJSON missing" }, { status: 400 });
	}
	try {
		return extractChallenge(clientDataJSON);
	} catch {
		return Response.json({ error: "malformed clientDataJSON" }, { status: 400 });
	}
}

async function countCredentials(db: D1Database): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) as count FROM credentials")
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function listCredentialIds(db: D1Database): Promise<string[]> {
	const result = await db.prepare("SELECT id FROM credentials").all<{ id: string }>();
	return result.results.map((r) => r.id);
}

type CredentialRow = {
	id: string;
	public_key_jwk: string;
	alg: number;
	sign_count: number;
	transports: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
};

async function getCredential(db: D1Database, id: string): Promise<CredentialRow | null> {
	const row = await db
		.prepare("SELECT * FROM credentials WHERE id = ?")
		.bind(id)
		.first<CredentialRow>();
	return row ?? null;
}

function parseTransports(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
	} catch {
		return [];
	}
}

async function insertChallenge(
	db: D1Database,
	kind: "register" | "login",
	bootstrap: boolean,
): Promise<string> {
	const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
	await db
		.prepare("INSERT INTO auth_challenges (id, kind, expires_at, bootstrap) VALUES (?, ?, ?, ?)")
		.bind(challenge, kind, expiresAt, bootstrap ? 1 : 0)
		.run();
	return challenge;
}

type ConsumedChallenge = { ok: true; bootstrap: boolean } | { ok: false };

/** Consumes (deletes) a single-use challenge; `ok: false` if missing, wrong kind, or expired.
 * Deletes unconditionally on lookup so a challenge is never reusable even when verification later
 * fails. `bootstrap` echoes back whether this challenge was issued while zero credentials existed,
 * so the caller can reject a stale bootstrap challenge once the bootstrap window has closed. */
async function consumeChallenge(
	db: D1Database,
	id: string,
	kind: "register" | "login",
): Promise<ConsumedChallenge> {
	const row = await db
		.prepare("SELECT kind, expires_at, bootstrap FROM auth_challenges WHERE id = ?")
		.bind(id)
		.first<{ kind: string; expires_at: string; bootstrap: number }>();

	await db.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(id).run();

	if (!row || row.kind !== kind) {
		return { ok: false };
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		return { ok: false };
	}
	return { ok: true, bootstrap: row.bootstrap === 1 };
}

/** `GET /api/auth/status` — unauthenticated. */
export async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
	const mode = env.AUTH_MODE === "passkey" ? "passkey" : "access";
	const hasCredentials = (await countCredentials(env.ORLA_DB)) > 0;
	const authResult = await requireAuth(request, env);
	const authenticated = !(authResult instanceof Response);

	return Response.json({ mode, has_credentials: hasCredentials, authenticated });
}

/** `POST /api/auth/register/options` — bootstrap (no credentials yet) needs no session. */
export async function handleRegisterOptions(request: Request, env: Env): Promise<Response> {
	const hasCredentials = (await countCredentials(env.ORLA_DB)) > 0;
	if (hasCredentials) {
		const authResult = await requireAuth(request, env);
		if (authResult instanceof Response) {
			return authResult;
		}
	}

	const { rpId } = rpFromRequest(request);
	const challenge = await insertChallenge(env.ORLA_DB, "register", !hasCredentials);
	const excludeCredentialIds = await listCredentialIds(env.ORLA_DB);

	const options = registrationOptions({
		rpId,
		rpName: env.ASSISTANT_NAME || "Orla",
		challenge,
		excludeCredentialIds,
	});
	return Response.json(options, { status: 200 });
}

/** `POST /api/auth/register/verify` `{ response, name? }` — 201; bootstrap also sets the cookie. */
export async function handleRegisterVerify(request: Request, env: Env): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) {
		return payload;
	}

	const { response, name } = payload;
	if (typeof response !== "object" || response === null) {
		return Response.json({ error: "response must be an object" }, { status: 400 });
	}
	if (name !== undefined && typeof name !== "string") {
		return Response.json({ error: "name must be a string" }, { status: 400 });
	}

	const hasCredentialsBefore = (await countCredentials(env.ORLA_DB)) > 0;

	if (hasCredentialsBefore) {
		// A credential already exists — this is no longer bootstrap, so a valid session is required.
		// Without this, a challenge minted during an earlier empty-credentials window (valid for the
		// full 5-minute TTL) could let a second party register after the real owner already has.
		const authResult = await requireAuth(request, env);
		if (authResult instanceof Response) {
			return authResult;
		}
	} else {
		// Bootstrapping mints a session cookie, so a misconfigured secret must fail closed here too —
		// before touching the (single-use) challenge or inserting anything.
		const secret = env.SESSION_SECRET;
		if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
			return Response.json({ error: "auth not configured" }, { status: 500 });
		}
	}

	const clientDataChallenge = extractClientDataChallenge(response as Record<string, unknown>);
	if (clientDataChallenge instanceof Response) {
		return clientDataChallenge;
	}

	const consumed = await consumeChallenge(env.ORLA_DB, clientDataChallenge, "register");
	if (!consumed.ok) {
		return Response.json({ error: "challenge invalid or expired" }, { status: 400 });
	}
	if (consumed.bootstrap && hasCredentialsBefore) {
		// Structural defense-in-depth on top of the session check above: a challenge issued while
		// zero credentials existed is permanently invalid once any credential exists, even presented
		// alongside an otherwise-valid session, so a stale bootstrap challenge can never be replayed.
		return Response.json({ error: "bootstrap window closed" }, { status: 401 });
	}

	const { rpId, origin } = rpFromRequest(request);

	let verified: Awaited<ReturnType<typeof verifyRegistration>>;
	try {
		verified = await verifyRegistration({
			response,
			expectedChallenge: clientDataChallenge,
			expectedOrigin: origin,
			rpId,
		});
	} catch (err) {
		if (err instanceof PasskeyError) {
			return Response.json({ error: err.reason }, { status: 400 });
		}
		throw err;
	}

	const credentialName = name ?? "";
	await env.ORLA_DB.prepare(
		`INSERT INTO credentials (id, public_key_jwk, alg, sign_count, transports, name)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			verified.credentialId,
			JSON.stringify(verified.publicKeyJwk),
			verified.alg,
			verified.signCount,
			JSON.stringify(verified.transports),
			credentialName,
		)
		.run();

	const headers = new Headers();
	if (!hasCredentialsBefore) {
		const secret = env.SESSION_SECRET as string; // validated above
		const token = await createSession(secret, { credentialId: verified.credentialId });
		headers.set("Set-Cookie", sessionCookie(token));
	}

	return Response.json(
		{ id: verified.credentialId, name: credentialName },
		{ status: 201, headers },
	);
}

/** `POST /api/auth/login/options` — unauthenticated. */
export async function handleLoginOptions(request: Request, env: Env): Promise<Response> {
	const { rpId } = rpFromRequest(request);
	const challenge = await insertChallenge(env.ORLA_DB, "login", false);
	const allowCredentialIds = await listCredentialIds(env.ORLA_DB);

	const options = authenticationOptions({ rpId, challenge, allowCredentialIds });
	return Response.json(options, { status: 200 });
}

/** `POST /api/auth/login/verify` `{ response }` — 200 `{ ok: true }`, sets the session cookie. */
export async function handleLoginVerify(request: Request, env: Env): Promise<Response> {
	const payload = await readJsonObject(request);
	if (payload instanceof Response) {
		return payload;
	}

	const { response } = payload;
	if (typeof response !== "object" || response === null) {
		return Response.json({ error: "response must be an object" }, { status: 400 });
	}

	const secret = env.SESSION_SECRET;
	if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
		return Response.json({ error: "auth not configured" }, { status: 500 });
	}

	const responseRecord = response as Record<string, unknown>;
	const credentialId = responseRecord.id;
	if (typeof credentialId !== "string" || credentialId.length === 0) {
		return Response.json({ error: "response.id missing" }, { status: 400 });
	}

	const clientDataChallenge = extractClientDataChallenge(responseRecord);
	if (clientDataChallenge instanceof Response) {
		return clientDataChallenge;
	}

	const consumed = await consumeChallenge(env.ORLA_DB, clientDataChallenge, "login");
	if (!consumed.ok) {
		return Response.json({ error: "challenge invalid or expired" }, { status: 400 });
	}

	const credentialRow = await getCredential(env.ORLA_DB, credentialId);
	if (!credentialRow) {
		return Response.json({ error: "unknown credential" }, { status: 400 });
	}

	const { rpId, origin } = rpFromRequest(request);

	let verified: { newSignCount: number };
	try {
		verified = await verifyAuthentication({
			response,
			expectedChallenge: clientDataChallenge,
			expectedOrigin: origin,
			rpId,
			credential: {
				publicKeyJwk: JSON.parse(credentialRow.public_key_jwk) as JsonWebKey,
				alg: credentialRow.alg,
				signCount: credentialRow.sign_count,
			},
		});
	} catch (err) {
		if (err instanceof PasskeyError) {
			return Response.json({ error: err.reason }, { status: 400 });
		}
		throw err;
	}

	await env.ORLA_DB.prepare("UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE id = ?")
		.bind(verified.newSignCount, new Date().toISOString(), credentialId)
		.run();

	const token = await createSession(secret, { credentialId });
	return Response.json(
		{ ok: true },
		{ status: 200, headers: { "Set-Cookie": sessionCookie(token) } },
	);
}

/** `POST /api/auth/logout` — unauthenticated (clearing an already-invalid cookie is harmless). */
export function handleLogout(): Response {
	return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie() } });
}

/** `GET /api/auth/credentials` — session required. */
export async function handleListCredentials(request: Request, env: Env): Promise<Response> {
	const authResult = await requireAuth(request, env);
	if (authResult instanceof Response) {
		return authResult;
	}

	const result = await env.ORLA_DB.prepare(
		"SELECT id, name, transports, created_at, last_used_at FROM credentials ORDER BY created_at ASC",
	).all<{
		id: string;
		name: string;
		transports: string;
		created_at: string;
		last_used_at: string | null;
	}>();

	const credentials = result.results.map((row) => ({
		id: row.id,
		name: row.name,
		transports: parseTransports(row.transports),
		created_at: row.created_at,
		last_used_at: row.last_used_at,
	}));

	return Response.json({ credentials });
}

/** `DELETE /api/auth/credentials/:id` — session required; refuses to delete the last credential. */
export async function handleDeleteCredential(
	request: Request,
	env: Env,
	id: string,
): Promise<Response> {
	const authResult = await requireAuth(request, env);
	if (authResult instanceof Response) {
		return authResult;
	}

	const existing = await getCredential(env.ORLA_DB, id);
	if (!existing) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	const total = await countCredentials(env.ORLA_DB);
	if (total <= 1) {
		return Response.json({ error: "cannot delete the last credential" }, { status: 409 });
	}

	await env.ORLA_DB.prepare("DELETE FROM credentials WHERE id = ?").bind(id).run();

	// Deleting the credential behind the caller's own passkey session invalidates that session —
	// clear its cookie so the client doesn't keep presenting a token requireAuth will now reject.
	if (authResult.via === "passkey" && authResult.sub === id) {
		return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie() } });
	}

	return new Response(null, { status: 204 });
}
