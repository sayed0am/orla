/**
 * Test-only, independent-of-`src/push.ts` reimplementation of the *subscriber* side of RFC
 * 8291/8292 — decrypting an aes128gcm Web Push body and verifying a VAPID JWT. This exists so
 * `test/push.test.ts` and `test/brief.test.ts` can prove `src/push.ts`'s encryption/signing is
 * spec-correct without a real browser: they encrypt with `sendPush`/`broadcast`, then decrypt
 * here using only the "subscriber"'s private key material, matching the payload byte-for-byte.
 */

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

export type TestSubscriber = {
	p256dh: string;
	auth: string;
	privateKey: CryptoKey;
};

/** Generates a fake browser subscription: an ECDH P-256 key pair plus a random auth secret. */
export async function generateTestSubscriber(): Promise<TestSubscriber> {
	const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as CryptoKeyPair;
	// workerd's ambient exportKey type returns a single ArrayBuffer|JsonWebKey union regardless
	// of `format`, so the "raw" result needs an explicit cast (mirrors src/push.ts).
	const rawPublic = new Uint8Array(
		(await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
	);
	const authSecret = crypto.getRandomValues(new Uint8Array(16));

	return {
		p256dh: b64urlEncode(rawPublic),
		auth: b64urlEncode(authSecret),
		privateKey: keyPair.privateKey,
	};
}

/** Decrypts an aes128gcm Web Push body (RFC 8291) captured on the wire, as the subscriber would. */
export async function decryptPushBody(
	body: ArrayBuffer,
	subscriber: TestSubscriber,
): Promise<string> {
	const bytes = new Uint8Array(body);
	const salt = bytes.slice(0, 16);
	const idLen = bytes[20];
	if (idLen === undefined) {
		throw new Error("decryptPushBody: body too short");
	}
	const asPublic = bytes.slice(21, 21 + idLen);
	const ciphertext = bytes.slice(21 + idLen);

	const asPublicKey = await crypto.subtle.importKey(
		"raw",
		asPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	// workerd's ambient type names this field `$public`, but the runtime reads `public` (see
	// src/push.ts's `deriveEcdhSecret` comment) — cast past the mismatch.
	const ecdhAlgorithm = {
		name: "ECDH",
		public: asPublicKey,
	} as unknown as SubtleCryptoDeriveKeyAlgorithm;
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(ecdhAlgorithm, subscriber.privateKey, 256),
	);

	const uaPublicRaw = b64urlDecode(subscriber.p256dh);
	const authSecret = b64urlDecode(subscriber.auth);

	const webpushInfo = concatBytes(
		new TextEncoder().encode("WebPush: info\0"),
		uaPublicRaw,
		asPublic,
	);
	const ikm = await hkdf(ecdhSecret, authSecret, webpushInfo, 32);

	const cek = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

	const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plaintext = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext),
	);

	const last = plaintext[plaintext.length - 1];
	if (last !== 0x02) {
		throw new Error(`decryptPushBody: expected 0x02 padding delimiter, got ${last}`);
	}
	return new TextDecoder().decode(plaintext.slice(0, -1));
}

/** Verifies a VAPID ES256 JWT against the claimed public key, returning its header and claims. */
export async function verifyVapidJwt(
	jwt: string,
	publicKeyB64: string,
): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
	const parts = jwt.split(".");
	const [headerB64, payloadB64, signatureB64] = parts;
	if (parts.length !== 3 || !headerB64 || !payloadB64 || !signatureB64) {
		throw new Error("verifyVapidJwt: malformed JWT");
	}

	const publicKey = await crypto.subtle.importKey(
		"raw",
		b64urlDecode(publicKeyB64),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);

	const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = b64urlDecode(signatureB64);
	const valid = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		signature,
		signingInput,
	);
	if (!valid) {
		throw new Error("verifyVapidJwt: signature does not verify against the given public key");
	}

	const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64))) as Record<
		string,
		unknown
	>;
	const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as Record<
		string,
		unknown
	>;
	return { header, payload };
}

/** Parses the `Authorization: vapid t=<jwt>, k=<publicKey>` header `sendPush` sends. */
export function parseVapidAuthHeader(header: string): { jwt: string; publicKey: string } {
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
	if (!match?.[1] || !match[2]) {
		throw new Error(`parseVapidAuthHeader: unexpected header shape: ${header}`);
	}
	return { jwt: match[1], publicKey: match[2] };
}
