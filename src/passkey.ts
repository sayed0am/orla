/**
 * WebAuthn (W3C Level 2) server-side verification for a single-RP, single-user server —
 * WebCrypto only, no dependencies. Implements exactly the subset of the spec a server needs to
 * verify registration and authentication ceremonies produced by `navigator.credentials.create`
 * / `.get`; it does not implement client-side behaviour, attestation trust chains, or extensions.
 *
 * Deliberate scope cuts (documented, not oversights):
 *  - Only attestation format `"none"` is accepted. We request `attestation: "none"` in
 *    `registrationOptions`, so a conforming client never sends anything else; `packed`/`self`
 *    attestation statement verification is NOT implemented and any non-`"none"` `fmt` is rejected.
 *  - Extension data (`authData` flag `ED`, bit 0x80) is rejected outright — we don't request or
 *    parse any extensions, so its presence is treated as unexpected/untrusted input.
 *  - Only ES256 (COSE alg -7, P-256) and RS256 (COSE alg -257) are supported, matching the two
 *    algorithms offered in `registrationOptions`.
 *  - Signature counters: per §6.1.1, a non-incrementing counter can indicate a cloned
 *    authenticator. We require `newSignCount > storedSignCount`, with one carve-out: authenticators
 *    that never increment the counter always report 0, so `0 == 0` is allowed through. Any other
 *    non-increase is rejected.
 */

export class PasskeyError extends Error {
	reason: string;

	constructor(reason: string) {
		super(reason);
		this.name = "PasskeyError";
		this.reason = reason;
	}
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict decode: rejects anything outside the base64url alphabet instead of silently coercing. */
function base64UrlDecodeStrict(input: string): Uint8Array {
	if (!BASE64URL_RE.test(input)) {
		throw new PasskeyError("malformed base64url string");
	}
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - (normalized.length % 4)) % 4;
	const padded = normalized + "=".repeat(padLength);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new PasskeyError("malformed base64url string");
	}
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] as number) ^ (b[i] as number);
	}
	return diff === 0;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] as number) * 0x1000000 +
		(((bytes[offset + 1] as number) << 16) |
			((bytes[offset + 2] as number) << 8) |
			(bytes[offset + 3] as number))
	);
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (RFC 8949) — maps, arrays, byte/text strings, ints, booleans, null.
// No indefinite-length items, no tags, no floats: nothing WebAuthn's `attestationObject` or a
// COSE_Key ever needs for a `"none"`-attestation, no-extensions flow.
// ---------------------------------------------------------------------------

type CborValue =
	| number
	| string
	| boolean
	| null
	| Uint8Array
	| CborValue[]
	| Map<number | string, CborValue>;

function requireBytes(bytes: Uint8Array, offset: number, length: number): void {
	if (length < 0 || offset + length > bytes.length) {
		throw new PasskeyError("cbor: unexpected end of input");
	}
}

function readCborLength(
	bytes: Uint8Array,
	offset: number,
	additionalInfo: number,
): { value: number; offset: number } {
	if (additionalInfo < 24) {
		return { value: additionalInfo, offset };
	}
	if (additionalInfo === 24) {
		requireBytes(bytes, offset, 1);
		return { value: bytes[offset] as number, offset: offset + 1 };
	}
	if (additionalInfo === 25) {
		requireBytes(bytes, offset, 2);
		return { value: readUint16BE(bytes, offset), offset: offset + 2 };
	}
	if (additionalInfo === 26) {
		requireBytes(bytes, offset, 4);
		return { value: readUint32BE(bytes, offset), offset: offset + 4 };
	}
	throw new PasskeyError("cbor: unsupported length encoding");
}

function decodeCborValue(bytes: Uint8Array, offset: number): { value: CborValue; offset: number } {
	requireBytes(bytes, offset, 1);
	const initial = bytes[offset] as number;
	const majorType = initial >> 5;
	const additionalInfo = initial & 0x1f;
	let pos = offset + 1;

	if (majorType === 7) {
		if (additionalInfo === 20) return { value: false, offset: pos };
		if (additionalInfo === 21) return { value: true, offset: pos };
		if (additionalInfo === 22) return { value: null, offset: pos };
		throw new PasskeyError("cbor: unsupported simple value");
	}

	const { value: length, offset: afterLength } = readCborLength(bytes, pos, additionalInfo);
	pos = afterLength;

	switch (majorType) {
		case 0: // unsigned int
			return { value: length, offset: pos };
		case 1: // negative int: -1 - n
			return { value: -1 - length, offset: pos };
		case 2: {
			// byte string
			requireBytes(bytes, pos, length);
			return { value: bytes.slice(pos, pos + length), offset: pos + length };
		}
		case 3: {
			// text string
			requireBytes(bytes, pos, length);
			return {
				value: new TextDecoder().decode(bytes.slice(pos, pos + length)),
				offset: pos + length,
			};
		}
		case 4: {
			// array
			const arr: CborValue[] = [];
			let o = pos;
			for (let i = 0; i < length; i++) {
				const item = decodeCborValue(bytes, o);
				arr.push(item.value);
				o = item.offset;
			}
			return { value: arr, offset: o };
		}
		case 5: {
			// map
			const map = new Map<number | string, CborValue>();
			let o = pos;
			for (let i = 0; i < length; i++) {
				const key = decodeCborValue(bytes, o);
				if (typeof key.value !== "number" && typeof key.value !== "string") {
					throw new PasskeyError("cbor: unsupported map key type");
				}
				const val = decodeCborValue(bytes, key.offset);
				map.set(key.value, val.value);
				o = val.offset;
			}
			return { value: map, offset: o };
		}
		default:
			throw new PasskeyError("cbor: unsupported major type");
	}
}

// ---------------------------------------------------------------------------
// attestationObject / authData parsing
// ---------------------------------------------------------------------------

type AttestationObject = {
	fmt: string;
	attStmt: Map<number | string, CborValue>;
	authData: Uint8Array;
};

function decodeAttestationObject(bytes: Uint8Array): AttestationObject {
	const { value, offset } = decodeCborValue(bytes, 0);
	if (offset !== bytes.length) {
		throw new PasskeyError("attestationObject has trailing data");
	}
	if (!(value instanceof Map)) {
		throw new PasskeyError("attestationObject must be a CBOR map");
	}
	const fmt = value.get("fmt");
	const attStmt = value.get("attStmt");
	const authData = value.get("authData");
	if (typeof fmt !== "string") {
		throw new PasskeyError("attestationObject.fmt must be a string");
	}
	if (!(attStmt instanceof Map)) {
		throw new PasskeyError("attestationObject.attStmt must be a map");
	}
	if (!(authData instanceof Uint8Array)) {
		throw new PasskeyError("attestationObject.authData must be a byte string");
	}
	return { fmt, attStmt, authData };
}

const FLAG_UP = 0x01; // user present
const FLAG_AT = 0x40; // attested credential data included
const FLAG_ED = 0x80; // extension data included

type ParsedAuthData = {
	rpIdHash: Uint8Array;
	signCount: number;
	credentialId?: Uint8Array;
	coseKey?: Map<number | string, CborValue>;
};

/**
 * Parses the fixed-layout `authData` structure (§6.1). `requireAttestedCredentialData` selects
 * between the registration shape (must carry `attestedCredentialData`) and the authentication
 * shape (must not).
 */
function parseAuthData(
	authData: Uint8Array,
	opts: { requireAttestedCredentialData: boolean },
): ParsedAuthData {
	if (authData.length < 37) {
		throw new PasskeyError("authData too short");
	}
	const rpIdHash = authData.slice(0, 32);
	const flags = authData[32] as number;
	const signCount = readUint32BE(authData, 33);

	if ((flags & FLAG_UP) === 0) {
		throw new PasskeyError("user presence flag not set");
	}
	if ((flags & FLAG_ED) !== 0) {
		throw new PasskeyError("unsupported: extension data present");
	}

	const hasAttestedCredentialData = (flags & FLAG_AT) !== 0;
	if (opts.requireAttestedCredentialData && !hasAttestedCredentialData) {
		throw new PasskeyError("missing attested credential data");
	}
	if (!opts.requireAttestedCredentialData && hasAttestedCredentialData) {
		throw new PasskeyError("unexpected attested credential data in assertion");
	}

	if (!hasAttestedCredentialData) {
		if (authData.length !== 37) {
			throw new PasskeyError("authData has unexpected trailing data");
		}
		return { rpIdHash, signCount };
	}

	let offset = 37;
	requireBytes(authData, offset, 16 + 2);
	offset += 16; // aaguid, unused
	const credIdLen = readUint16BE(authData, offset);
	offset += 2;
	requireBytes(authData, offset, credIdLen);
	const credentialId = authData.slice(offset, offset + credIdLen);
	offset += credIdLen;

	const { value: coseKeyValue, offset: afterKey } = decodeCborValue(authData, offset);
	if (afterKey !== authData.length) {
		throw new PasskeyError("authData has trailing data after credential public key");
	}
	if (!(coseKeyValue instanceof Map)) {
		throw new PasskeyError("credential public key must be a CBOR map");
	}

	return { rpIdHash, signCount, credentialId, coseKey: coseKeyValue };
}

// ---------------------------------------------------------------------------
// COSE_Key -> JWK
// ---------------------------------------------------------------------------

const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_CRV_P256 = 1;

export const ALG_ES256 = -7;
export const ALG_RS256 = -257;

function coseKeyToJwk(map: Map<number | string, CborValue>): { jwk: JsonWebKey; alg: number } {
	const kty = map.get(1);
	const alg = map.get(3);
	if (typeof alg !== "number" || (alg !== ALG_ES256 && alg !== ALG_RS256)) {
		throw new PasskeyError("unsupported COSE algorithm");
	}

	if (kty === COSE_KTY_EC2) {
		if (alg !== ALG_ES256) {
			throw new PasskeyError("COSE key type/algorithm mismatch");
		}
		const crv = map.get(-1);
		const x = map.get(-2);
		const y = map.get(-3);
		if (crv !== COSE_CRV_P256) {
			throw new PasskeyError("unsupported EC curve");
		}
		if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
			throw new PasskeyError("malformed EC public key");
		}
		return {
			jwk: { kty: "EC", crv: "P-256", x: base64UrlEncode(x), y: base64UrlEncode(y), ext: true },
			alg,
		};
	}

	if (kty === COSE_KTY_RSA) {
		if (alg !== ALG_RS256) {
			throw new PasskeyError("COSE key type/algorithm mismatch");
		}
		const n = map.get(-1);
		const e = map.get(-2);
		if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
			throw new PasskeyError("malformed RSA public key");
		}
		return {
			jwk: { kty: "RSA", n: base64UrlEncode(n), e: base64UrlEncode(e), ext: true },
			alg,
		};
	}

	throw new PasskeyError("unsupported COSE key type");
}

// ---------------------------------------------------------------------------
// clientDataJSON
// ---------------------------------------------------------------------------

function parseClientData(bytes: Uint8Array): { type: string; challenge: string; origin: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new PasskeyError("clientDataJSON is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new PasskeyError("clientDataJSON must be an object");
	}
	const { type, challenge, origin } = parsed as Record<string, unknown>;
	if (typeof type !== "string" || typeof challenge !== "string" || typeof origin !== "string") {
		throw new PasskeyError("clientDataJSON missing type/challenge/origin");
	}
	return { type, challenge, origin };
}

// ---------------------------------------------------------------------------
// DER (ECDSA signature) -> raw r||s
// ---------------------------------------------------------------------------

function trimToFixedWidth(bytes: Uint8Array, width: number): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0x00) {
		start++;
	}
	const trimmed = bytes.slice(start);
	if (trimmed.length > width) {
		throw new PasskeyError("malformed DER signature: integer too large");
	}
	const out = new Uint8Array(width);
	out.set(trimmed, width - trimmed.length);
	return out;
}

/** WebAuthn ECDSA assertion signatures are DER-encoded; WebCrypto wants raw 64-byte r||s. */
function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
	let offset = 0;
	if (der.length < 8 || der[offset] !== 0x30) {
		throw new PasskeyError("malformed DER signature");
	}
	offset += 1;

	let seqLen = der[offset] as number;
	offset += 1;
	if ((seqLen & 0x80) !== 0) {
		const numBytes = seqLen & 0x7f;
		if (numBytes < 1 || numBytes > 2) {
			throw new PasskeyError("malformed DER signature");
		}
		seqLen = 0;
		for (let i = 0; i < numBytes; i++) {
			requireBytes(der, offset, 1);
			seqLen = (seqLen << 8) | (der[offset] as number);
			offset += 1;
		}
	}

	if (der[offset] !== 0x02) {
		throw new PasskeyError("malformed DER signature");
	}
	offset += 1;
	const rLen = der[offset] as number;
	offset += 1;
	requireBytes(der, offset, rLen);
	const rBytes = der.slice(offset, offset + rLen);
	offset += rLen;

	if (der[offset] !== 0x02) {
		throw new PasskeyError("malformed DER signature");
	}
	offset += 1;
	const sLen = der[offset] as number;
	offset += 1;
	requireBytes(der, offset, sLen);
	const sBytes = der.slice(offset, offset + sLen);

	return concatBytes(trimToFixedWidth(rBytes, 32), trimToFixedWidth(sBytes, 32));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const OWNER_USER_ID = base64UrlEncode(new TextEncoder().encode("owner"));
const TIMEOUT_MS = 60_000;

export type PublicKeyCredentialCreationOptionsJSON = {
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	challenge: string;
	pubKeyCredParams: { type: "public-key"; alg: number }[];
	timeout: number;
	excludeCredentials: { type: "public-key"; id: string }[];
	authenticatorSelection: { residentKey: string; userVerification: string };
	attestation: string;
};

export function registrationOptions(opts: {
	rpId: string;
	rpName: string;
	challenge: string;
	excludeCredentialIds: string[];
}): PublicKeyCredentialCreationOptionsJSON {
	return {
		rp: { id: opts.rpId, name: opts.rpName },
		user: { id: OWNER_USER_ID, name: "owner", displayName: "owner" },
		challenge: opts.challenge,
		pubKeyCredParams: [
			{ type: "public-key", alg: ALG_ES256 },
			{ type: "public-key", alg: ALG_RS256 },
		],
		timeout: TIMEOUT_MS,
		excludeCredentials: opts.excludeCredentialIds.map((id) => ({ type: "public-key", id })),
		authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
		attestation: "none",
	};
}

export type PublicKeyCredentialRequestOptionsJSON = {
	rpId: string;
	challenge: string;
	timeout: number;
	userVerification: string;
	allowCredentials: { type: "public-key"; id: string }[];
};

export function authenticationOptions(opts: {
	rpId: string;
	challenge: string;
	allowCredentialIds: string[];
}): PublicKeyCredentialRequestOptionsJSON {
	return {
		rpId: opts.rpId,
		challenge: opts.challenge,
		timeout: TIMEOUT_MS,
		userVerification: "preferred",
		allowCredentials: opts.allowCredentialIds.map((id) => ({ type: "public-key", id })),
	};
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new PasskeyError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PasskeyError(`${path} must be a non-empty string`);
	}
	return value;
}

export type VerifiedRegistration = {
	credentialId: string;
	publicKeyJwk: JsonWebKey;
	alg: number;
	signCount: number;
	transports: string[];
};

/**
 * Verifies a `navigator.credentials.create()` response (as its WebAuthn JSON serialization:
 * every ArrayBuffer field — `clientDataJSON`, `attestationObject` — base64url-encoded).
 *
 * Checks performed, in order: `clientData.type === "webauthn.create"`; challenge equality
 * (base64url string compare); origin equality; `fmt === "none"` (packed/self attestation is
 * intentionally not implemented — see module doc comment); `attStmt` is the empty map §8.7
 * requires for `"none"`; `authData.rpIdHash === SHA-256(rpId)`; `UP` flag set; `AT` flag set;
 * `ED` flag absent (extensions unsupported); attested credential data parses cleanly with no
 * trailing bytes; COSE public key algorithm is ES256 or RS256 and matches its declared key type.
 */
export async function verifyRegistration(input: {
	response: unknown;
	expectedChallenge: string;
	expectedOrigin: string;
	rpId: string;
}): Promise<VerifiedRegistration> {
	const credentialJson = asRecord(input.response, "response");
	const authenticatorResponse = asRecord(credentialJson.response, "response.response");

	const clientDataJsonB64 = requireString(
		authenticatorResponse.clientDataJSON,
		"response.response.clientDataJSON",
	);
	const attestationObjectB64 = requireString(
		authenticatorResponse.attestationObject,
		"response.response.attestationObject",
	);

	const clientDataBytes = base64UrlDecodeStrict(clientDataJsonB64);
	const clientData = parseClientData(clientDataBytes);

	if (clientData.type !== "webauthn.create") {
		throw new PasskeyError("clientData.type must be webauthn.create");
	}
	if (clientData.challenge !== input.expectedChallenge) {
		throw new PasskeyError("challenge mismatch");
	}
	if (clientData.origin !== input.expectedOrigin) {
		throw new PasskeyError("origin mismatch");
	}

	const attestationBytes = base64UrlDecodeStrict(attestationObjectB64);
	const { fmt, attStmt, authData } = decodeAttestationObject(attestationBytes);

	if (fmt !== "none") {
		throw new PasskeyError(`unsupported attestation format: ${fmt}`);
	}
	if (attStmt.size !== 0) {
		throw new PasskeyError("attestation statement must be empty for fmt none");
	}

	const parsed = parseAuthData(authData, { requireAttestedCredentialData: true });
	const expectedRpIdHash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rpId)),
	);
	if (!bytesEqual(parsed.rpIdHash, expectedRpIdHash)) {
		throw new PasskeyError("rpIdHash mismatch");
	}
	if (!parsed.credentialId || !parsed.coseKey) {
		throw new PasskeyError("missing attested credential data");
	}

	const { jwk, alg } = coseKeyToJwk(parsed.coseKey);

	let transports: string[] = [];
	const transportsRaw = authenticatorResponse.transports;
	if (transportsRaw !== undefined) {
		if (!Array.isArray(transportsRaw) || !transportsRaw.every((t) => typeof t === "string")) {
			throw new PasskeyError("transports must be an array of strings");
		}
		transports = transportsRaw;
	}

	return {
		credentialId: base64UrlEncode(parsed.credentialId),
		publicKeyJwk: jwk,
		alg,
		signCount: parsed.signCount,
		transports,
	};
}

async function importEcVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
	try {
		return await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
	} catch {
		throw new PasskeyError("invalid EC public key");
	}
}

async function importRsaVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
	try {
		return await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
	} catch {
		throw new PasskeyError("invalid RSA public key");
	}
}

async function verifySignature(
	alg: number,
	jwk: JsonWebKey,
	signature: Uint8Array,
	data: Uint8Array,
): Promise<boolean> {
	if (alg === ALG_ES256) {
		const key = await importEcVerifyKey(jwk);
		const raw = derToRawEcdsaSignature(signature);
		return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, data);
	}
	if (alg === ALG_RS256) {
		const key = await importRsaVerifyKey(jwk);
		return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
	}
	throw new PasskeyError("unsupported algorithm");
}

/**
 * Verifies a `navigator.credentials.get()` response against a stored credential.
 *
 * Checks performed, in order: `clientData.type === "webauthn.get"`; challenge equality; origin
 * equality; `authData.rpIdHash === SHA-256(rpId)`; `UP` flag set; `ED`/`AT` flags absent;
 * signature counter increased (or both old and new counters are 0 — authenticators that don't
 * implement a counter always report 0, so that pair is allowed through; any other non-increase
 * is rejected as a possible cloned authenticator); signature over
 * `authenticatorData || SHA-256(clientDataJSON)` verifies against the stored public key (ES256:
 * DER-to-raw r||s conversion, then ECDSA/P-256/SHA-256; RS256: RSASSA-PKCS1-v1_5/SHA-256 as-is).
 */
export async function verifyAuthentication(input: {
	response: unknown;
	expectedChallenge: string;
	expectedOrigin: string;
	rpId: string;
	credential: { publicKeyJwk: JsonWebKey; alg: number; signCount: number };
}): Promise<{ newSignCount: number }> {
	const credentialJson = asRecord(input.response, "response");
	const authenticatorResponse = asRecord(credentialJson.response, "response.response");

	const clientDataJsonB64 = requireString(
		authenticatorResponse.clientDataJSON,
		"response.response.clientDataJSON",
	);
	const authenticatorDataB64 = requireString(
		authenticatorResponse.authenticatorData,
		"response.response.authenticatorData",
	);
	const signatureB64 = requireString(
		authenticatorResponse.signature,
		"response.response.signature",
	);

	const clientDataBytes = base64UrlDecodeStrict(clientDataJsonB64);
	const clientData = parseClientData(clientDataBytes);

	if (clientData.type !== "webauthn.get") {
		throw new PasskeyError("clientData.type must be webauthn.get");
	}
	if (clientData.challenge !== input.expectedChallenge) {
		throw new PasskeyError("challenge mismatch");
	}
	if (clientData.origin !== input.expectedOrigin) {
		throw new PasskeyError("origin mismatch");
	}

	const authenticatorData = base64UrlDecodeStrict(authenticatorDataB64);
	const parsed = parseAuthData(authenticatorData, { requireAttestedCredentialData: false });

	const expectedRpIdHash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rpId)),
	);
	if (!bytesEqual(parsed.rpIdHash, expectedRpIdHash)) {
		throw new PasskeyError("rpIdHash mismatch");
	}

	const storedSignCount = input.credential.signCount;
	const newSignCount = parsed.signCount;
	const counterOk = newSignCount > storedSignCount || (newSignCount === 0 && storedSignCount === 0);
	if (!counterOk) {
		throw new PasskeyError("signature counter did not increase (possible cloned authenticator)");
	}

	const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
	const signedData = concatBytes(authenticatorData, clientDataHash);
	const signature = base64UrlDecodeStrict(signatureB64);

	const verified = await verifySignature(
		input.credential.alg,
		input.credential.publicKeyJwk,
		signature,
		signedData,
	);
	if (!verified) {
		throw new PasskeyError("invalid signature");
	}

	return { newSignCount };
}
