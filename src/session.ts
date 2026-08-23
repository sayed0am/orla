/**
 * Stateless signed session cookie for passkey auth (Phase 3, docs/PLAN.md). No server-side
 * session store: the cookie carries its own claims, HMAC-signed so they can't be forged, and
 * `verifySession` is the only way back to a `SessionPayload`.
 */

export type SessionPayload = {
	cid: string;
	iat: number;
	exp: number;
};

export const SESSION_COOKIE_NAME = "orla_session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

async function importHmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usages,
	);
}

/** Creates `base64url(payload) + "." + base64url(HMAC-SHA256(secret, payloadB64))`. */
export async function createSession(
	secret: string,
	opts: { credentialId: string; now?: number },
): Promise<string> {
	const iat = opts.now ?? Math.floor(Date.now() / 1000);
	const exp = iat + SESSION_TTL_SECONDS;
	const payload: SessionPayload = { cid: opts.credentialId, iat, exp };

	const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await importHmacKey(secret, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));

	return `${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a session token's HMAC (constant-time via `crypto.subtle.verify`) and expiry. Returns
 * `null` on any malformed, tampered, or expired token rather than throwing — callers only need a
 * yes/no answer.
 */
export async function verifySession(
	secret: string,
	token: string,
	now?: number,
): Promise<SessionPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return null;
	}
	const [payloadB64, signatureB64] = parts;
	if (!payloadB64 || !signatureB64) {
		return null;
	}

	let signature: Uint8Array;
	try {
		signature = base64UrlDecode(signatureB64);
	} catch {
		return null;
	}

	const key = await importHmacKey(secret, ["verify"]);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		new TextEncoder().encode(payloadB64),
	);
	if (!valid) {
		return null;
	}

	let payload: SessionPayload;
	try {
		const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
		if (
			typeof decoded !== "object" ||
			decoded === null ||
			typeof (decoded as Record<string, unknown>).cid !== "string" ||
			typeof (decoded as Record<string, unknown>).iat !== "number" ||
			typeof (decoded as Record<string, unknown>).exp !== "number"
		) {
			return null;
		}
		payload = decoded as SessionPayload;
	} catch {
		return null;
	}

	const nowSeconds = now ?? Math.floor(Date.now() / 1000);
	if (payload.exp <= nowSeconds) {
		return null;
	}

	return payload;
}

/** `Set-Cookie` value for a fresh session token. */
export function sessionCookie(token: string): string {
	return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** `Set-Cookie` value that clears the session cookie (logout). */
export function clearSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
