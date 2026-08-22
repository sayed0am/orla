/**
 * Web Push (RFC 8030/8291/8292) with no dependencies — WebCrypto only (PRD F4).
 *
 * VAPID key storage: `generateVapidKeys` returns
 *   - `publicKey`: the raw uncompressed EC point (0x04 || X(32) || Y(32)), base64url — 65 bytes.
 *   - `privateKey`: the private scalar `d` straight out of the JWK export (WebCrypto's JWK `d` is
 *     already base64url-encoded, so it is stored verbatim, not re-encoded).
 * To sign with the stored private key later, its JWK is reconstructed by pairing `d` with the
 * x/y coordinates recovered from the stored raw public key — WebCrypto has no "import a bare
 * scalar" mode, so the public point must travel alongside it.
 */

export type PushSubscriptionKeys = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

export type VapidConfig = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

export type SendPushResult = { ok: true } | { ok: false; status: number; gone: boolean };

export type BroadcastResult = { sent: number; failed: number; removed: number };

const FAILURE_GIVEUP_THRESHOLD = 5;
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TTL_SECONDS = 86_400;
const RECORD_SIZE = 4096;
const PADDING_DELIMITER = 0x02;

function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
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

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** One WebCrypto HKDF call performs extract-then-expand in a single step (RFC 5869). */
async function hkdf(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	lengthBytes: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		lengthBytes * 8,
	);
	return new Uint8Array(bits);
}

/** Splits a raw uncompressed EC point (0x04 || X(32) || Y(32)) into base64url x/y for a JWK. */
function splitRawEcPoint(raw: Uint8Array): { x: string; y: string } {
	return { x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

// workerd's ambient SubtleCrypto types declare `exportKey` as returning a single
// `ArrayBuffer | JsonWebKey` union regardless of the `format` argument (unlike lib.dom's
// per-literal overloads), so every call site needs an explicit cast to the format it actually
// requested.
async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

async function exportJwkKey(key: CryptoKey): Promise<JsonWebKey> {
	return (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
}

/**
 * workerd's ambient types name the ECDH `deriveBits` peer-key field `$public` (its codegen
 * escapes the reserved word `public`), but the runtime Web Crypto implementation actually reads
 * `public` — verified directly against workerd, since following the declared `$public` field
 * silently derives the wrong secret. The algorithm object is built untyped and cast past the
 * mismatch so the real, spec-correct field name reaches the runtime.
 */
async function deriveEcdhSecret(
	privateKey: CryptoKey,
	publicKey: CryptoKey,
	lengthBits: number,
): Promise<Uint8Array> {
	const algorithm = {
		name: "ECDH",
		public: publicKey,
	} as unknown as SubtleCryptoDeriveKeyAlgorithm;
	return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, lengthBits));
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
	const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;

	const rawPublic = await exportRawKey(keyPair.publicKey);
	const jwkPrivate = await exportJwkKey(keyPair.privateKey);
	if (!jwkPrivate.d) {
		throw new Error("generateVapidKeys: exported private JWK missing d");
	}

	return { publicKey: b64urlEncode(rawPublic), privateKey: jwkPrivate.d };
}

/** Reconstructs the ECDSA signing key from a stored VAPID key pair (see module doc comment). */
async function importVapidSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
	const rawPublic = b64urlDecode(publicKey);
	const { x, y } = splitRawEcPoint(rawPublic);
	const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x, y, d: privateKey, ext: true };
	return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
	]);
}

async function buildVapidJwt(endpoint: string, vapid: VapidConfig): Promise<string> {
	const origin = new URL(endpoint).origin;
	const now = Math.floor(Date.now() / 1000);

	const header = { typ: "JWT", alg: "ES256" };
	const claims = { aud: origin, exp: now + VAPID_TTL_SECONDS, sub: vapid.subject };
	const headerB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
	const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
	const signingInput = `${headerB64}.${payloadB64}`;

	const signingKey = await importVapidSigningKey(vapid.publicKey, vapid.privateKey);
	// WebCrypto's ECDSA signature is already raw r||s (64 bytes for P-256) — exactly the JWS
	// ES256 signature encoding, no DER conversion needed.
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		signingKey,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
}

/** Encrypts `payload` per RFC 8291 (aes128gcm) for the given subscriber. */
async function encryptPayload(
	payload: string,
	subscriberP256dh: string,
	subscriberAuth: string,
): Promise<Uint8Array> {
	const uaPublic = b64urlDecode(subscriberP256dh);
	const authSecret = b64urlDecode(subscriberAuth);

	const ephemeralKeyPair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const asPublic = await exportRawKey(ephemeralKeyPair.publicKey);

	const uaPublicKey = await crypto.subtle.importKey(
		"raw",
		uaPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdhSecret = await deriveEcdhSecret(ephemeralKeyPair.privateKey, uaPublicKey, 256);

	const webpushInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
	// PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret); IKM = HKDF-Expand(PRK_key, info, 32)
	// — one WebCrypto HKDF call does both steps at once.
	const ikm = await hkdf(ecdhSecret, authSecret, webpushInfo, 32);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	// PRK = HKDF-Extract(salt, IKM); CEK/NONCE = HKDF-Expand(PRK, info, len) — same trick.
	const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

	const plaintext = concatBytes(
		new TextEncoder().encode(payload),
		new Uint8Array([PADDING_DELIMITER]),
	);
	const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, plaintext),
	);

	const rs = new Uint8Array(4);
	new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
	const idLen = new Uint8Array([asPublic.length]);

	return concatBytes(salt, rs, idLen, asPublic, ciphertext);
}

/** Sends one Web Push message. Never throws on a non-2xx upstream response. */
export async function sendPush(
	sub: PushSubscriptionKeys,
	payload: string,
	vapid: VapidConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<SendPushResult> {
	const [jwt, body] = await Promise.all([
		buildVapidJwt(sub.endpoint, vapid),
		encryptPayload(payload, sub.p256dh, sub.auth),
	]);

	const response = await fetchImpl(sub.endpoint, {
		method: "POST",
		headers: {
			Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(PUSH_TTL_SECONDS),
			Urgency: "normal",
		},
		body,
	});

	if (response.ok) {
		return { ok: true };
	}
	if (response.status === 404 || response.status === 410) {
		return { ok: false, status: response.status, gone: true };
	}
	return { ok: false, status: response.status, gone: false };
}

type SubscriptionRow = {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	failures: number;
};

/**
 * Sends `payload` to every stored subscription. A "gone" response (404/410) means the browser
 * unsubscribed, so the row is deleted immediately; any other failure increments `failures` and
 * the row is dropped once it reaches `FAILURE_GIVEUP_THRESHOLD`. A success resets `failures` and
 * stamps `last_success_at`.
 */
export async function broadcast(
	db: D1Database,
	payload: string,
	vapid: VapidConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<BroadcastResult> {
	const rows = await db
		.prepare("SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions")
		.all<SubscriptionRow>();

	let sent = 0;
	let failed = 0;
	let removed = 0;

	for (const row of rows.results) {
		const result = await sendPush(row, payload, vapid, fetchImpl);

		if (result.ok) {
			sent++;
			await db
				.prepare("UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?")
				.bind(new Date().toISOString(), row.id)
				.run();
			continue;
		}

		if (result.gone) {
			removed++;
			await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id).run();
			continue;
		}

		failed++;
		const nextFailures = row.failures + 1;
		if (nextFailures >= FAILURE_GIVEUP_THRESHOLD) {
			removed++;
			await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id).run();
		} else {
			await db
				.prepare("UPDATE push_subscriptions SET failures = ? WHERE id = ?")
				.bind(nextFailures, row.id)
				.run();
		}
	}

	return { sent, failed, removed };
}
