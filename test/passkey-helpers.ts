/**
 * A software WebAuthn authenticator for tests: generates real key pairs, CBOR-encodes a
 * `fmt: "none"` `attestationObject` and COSE public keys by hand (minimal encoder, no deps — the
 * mirror image of `src/passkey.ts`'s decoder), and produces signed assertions. This is what
 * proves the server-side parsing in `src/passkey.ts` against real WebCrypto-produced signatures.
 */

export type Alg = -7 | -257;

export type SoftwareAuthenticator = {
	credentialId: Uint8Array;
	keyPair: CryptoKeyPair;
	alg: Alg;
};

// ---------------------------------------------------------------------------
// base64url / bytes
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
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

function uint16BE(value: number): Uint8Array {
	return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function uint32BE(value: number): Uint8Array {
	return Uint8Array.of(
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder (RFC 8949) — only what building an attestationObject/COSE_Key needs.
// ---------------------------------------------------------------------------

export type CborInput =
	| number
	| string
	| Uint8Array
	| CborInput[]
	| Map<number | string, CborInput>;

function encodeCborHead(majorType: number, value: number): Uint8Array {
	if (value < 24) return Uint8Array.of((majorType << 5) | value);
	if (value < 256) return Uint8Array.of((majorType << 5) | 24, value);
	if (value < 65536) return concatBytes(Uint8Array.of((majorType << 5) | 25), uint16BE(value));
	return concatBytes(Uint8Array.of((majorType << 5) | 26), uint32BE(value));
}

export function encodeCbor(value: CborInput): Uint8Array {
	if (typeof value === "number") {
		return Number.isInteger(value) && value < 0
			? encodeCborHead(1, -1 - value)
			: encodeCborHead(0, value);
	}
	if (typeof value === "string") {
		const bytes = new TextEncoder().encode(value);
		return concatBytes(encodeCborHead(3, bytes.length), bytes);
	}
	if (value instanceof Uint8Array) {
		return concatBytes(encodeCborHead(2, value.length), value);
	}
	if (Array.isArray(value)) {
		return concatBytes(encodeCborHead(4, value.length), ...value.map(encodeCbor));
	}
	if (value instanceof Map) {
		const parts: Uint8Array[] = [encodeCborHead(5, value.size)];
		for (const [k, v] of value) {
			parts.push(encodeCbor(k));
			parts.push(encodeCbor(v));
		}
		return concatBytes(...parts);
	}
	throw new Error("encodeCbor: unsupported value");
}

// ---------------------------------------------------------------------------
// Authenticators
// ---------------------------------------------------------------------------

export async function createEs256Authenticator(): Promise<SoftwareAuthenticator> {
	const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	return { credentialId: crypto.getRandomValues(new Uint8Array(16)), keyPair, alg: -7 };
}

export async function createRs256Authenticator(): Promise<SoftwareAuthenticator> {
	const keyPair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	return { credentialId: crypto.getRandomValues(new Uint8Array(16)), keyPair, alg: -257 };
}

// workerd's ambient SubtleCrypto types declare `exportKey` as returning a single
// `ArrayBuffer | JsonWebKey` union regardless of `format` (see src/push.ts's doc comment for the
// same issue), so every JWK export needs an explicit cast.
async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
	return (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
}

async function coseKeyBytes(authenticator: SoftwareAuthenticator): Promise<Uint8Array> {
	const jwk = await exportJwk(authenticator.keyPair.publicKey);
	if (authenticator.alg === -7) {
		if (!jwk.x || !jwk.y) throw new Error("EC public JWK missing x/y");
		const map = new Map<number, CborInput>([
			[1, 2], // kty EC2
			[3, -7], // alg ES256
			[-1, 1], // crv P-256
			[-2, base64UrlDecode(jwk.x)],
			[-3, base64UrlDecode(jwk.y)],
		]);
		return encodeCbor(map);
	}
	if (!jwk.n || !jwk.e) throw new Error("RSA public JWK missing n/e");
	const map = new Map<number, CborInput>([
		[1, 3], // kty RSA
		[3, -257], // alg RS256
		[-1, base64UrlDecode(jwk.n)],
		[-2, base64UrlDecode(jwk.e)],
	]);
	return encodeCbor(map);
}

// ---------------------------------------------------------------------------
// clientDataJSON / authData / attestationObject
// ---------------------------------------------------------------------------

function buildClientDataJSON(opts: {
	type: string;
	challenge: string;
	origin: string;
}): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({ type: opts.type, challenge: opts.challenge, origin: opts.origin }),
	);
}

async function rpIdHash(rpId: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
}

const FLAG_UP_AT = 0x01 | 0x40;
const FLAG_UP = 0x01;

async function buildRegistrationAuthData(opts: {
	rpId: string;
	signCount: number;
	credentialId: Uint8Array;
	coseKey: Uint8Array;
	flags?: number;
}): Promise<Uint8Array> {
	return concatBytes(
		await rpIdHash(opts.rpId),
		Uint8Array.of(opts.flags ?? FLAG_UP_AT),
		uint32BE(opts.signCount),
		new Uint8Array(16), // aaguid, all-zero — unused by the server
		uint16BE(opts.credentialId.length),
		opts.credentialId,
		opts.coseKey,
	);
}

async function buildAssertionAuthData(opts: {
	rpId: string;
	signCount: number;
	flags?: number;
}): Promise<Uint8Array> {
	return concatBytes(
		await rpIdHash(opts.rpId),
		Uint8Array.of(opts.flags ?? FLAG_UP),
		uint32BE(opts.signCount),
	);
}

function buildAttestationObject(opts: {
	fmt: string;
	attStmt: Map<string, CborInput>;
	authData: Uint8Array;
}): Uint8Array {
	const map = new Map<string, CborInput>([
		["fmt", opts.fmt],
		["attStmt", opts.attStmt],
		["authData", opts.authData],
	]);
	return encodeCbor(map);
}

/** WebCrypto's ECDSA signature is raw r||s; WebAuthn assertions carry it DER-encoded. */
function rawToDerEcdsaSignature(raw: Uint8Array): Uint8Array {
	const encodeInt = (bytes: Uint8Array): Uint8Array => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0x00) start++;
		const trimmed = bytes.slice(start);
		const padded =
			(trimmed[0] as number) & 0x80 ? concatBytes(Uint8Array.of(0x00), trimmed) : trimmed;
		return concatBytes(Uint8Array.of(0x02, padded.length), padded);
	};
	const body = concatBytes(encodeInt(raw.slice(0, 32)), encodeInt(raw.slice(32, 64)));
	return concatBytes(Uint8Array.of(0x30, body.length), body);
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/** Builds a `navigator.credentials.create()`-shaped response (WebAuthn JSON serialization). */
export async function buildRegistrationResponse(opts: {
	authenticator: SoftwareAuthenticator;
	challenge: string;
	origin: string;
	rpId: string;
	signCount?: number;
	type?: string;
	transports?: string[];
	fmt?: string;
	attStmt?: Map<string, CborInput>;
	authDataRpId?: string;
	flags?: number;
}): Promise<unknown> {
	const clientDataBytes = buildClientDataJSON({
		type: opts.type ?? "webauthn.create",
		challenge: opts.challenge,
		origin: opts.origin,
	});

	const coseKey = await coseKeyBytes(opts.authenticator);
	const authData = await buildRegistrationAuthData({
		rpId: opts.authDataRpId ?? opts.rpId,
		signCount: opts.signCount ?? 0,
		credentialId: opts.authenticator.credentialId,
		coseKey,
		flags: opts.flags,
	});

	const attestationObjectBytes = buildAttestationObject({
		fmt: opts.fmt ?? "none",
		attStmt: opts.attStmt ?? new Map(),
		authData,
	});

	return {
		id: base64UrlEncode(opts.authenticator.credentialId),
		rawId: base64UrlEncode(opts.authenticator.credentialId),
		type: "public-key",
		response: {
			clientDataJSON: base64UrlEncode(clientDataBytes),
			attestationObject: base64UrlEncode(attestationObjectBytes),
			...(opts.transports !== undefined ? { transports: opts.transports } : {}),
		},
		clientExtensionResults: {},
	};
}

/** Builds a `navigator.credentials.get()`-shaped response (WebAuthn JSON serialization). */
export async function buildAuthenticationResponse(opts: {
	authenticator: SoftwareAuthenticator;
	challenge: string;
	origin: string;
	rpId: string;
	signCount: number;
	type?: string;
	authDataRpId?: string;
	flags?: number;
	tamperSignature?: boolean;
	credentialIdOverride?: Uint8Array;
}): Promise<unknown> {
	const clientDataBytes = buildClientDataJSON({
		type: opts.type ?? "webauthn.get",
		challenge: opts.challenge,
		origin: opts.origin,
	});
	const authenticatorData = await buildAssertionAuthData({
		rpId: opts.authDataRpId ?? opts.rpId,
		signCount: opts.signCount,
		flags: opts.flags,
	});

	const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
	const signedData = concatBytes(authenticatorData, clientDataHash);

	let signature: Uint8Array;
	if (opts.authenticator.alg === -7) {
		const raw = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				opts.authenticator.keyPair.privateKey,
				signedData,
			),
		);
		signature = rawToDerEcdsaSignature(raw);
	} else {
		signature = new Uint8Array(
			await crypto.subtle.sign(
				"RSASSA-PKCS1-v1_5",
				opts.authenticator.keyPair.privateKey,
				signedData,
			),
		);
	}

	if (opts.tamperSignature) {
		signature = signature.slice();
		signature[0] = (signature[0] as number) ^ 0xff;
	}

	const credentialId = opts.credentialIdOverride ?? opts.authenticator.credentialId;

	return {
		id: base64UrlEncode(credentialId),
		rawId: base64UrlEncode(credentialId),
		type: "public-key",
		response: {
			clientDataJSON: base64UrlEncode(clientDataBytes),
			authenticatorData: base64UrlEncode(authenticatorData),
			signature: base64UrlEncode(signature),
		},
		clientExtensionResults: {},
	};
}

/** The JWK + alg a stored `credentials` row would hold for this authenticator, for test setup. */
export async function storedCredentialFields(
	authenticator: SoftwareAuthenticator,
): Promise<{ publicKeyJwk: JsonWebKey; alg: Alg }> {
	const jwk = await exportJwk(authenticator.keyPair.publicKey);
	return { publicKeyJwk: jwk, alg: authenticator.alg };
}
