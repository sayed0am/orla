// Generates a VAPID key pair for Web Push (PRD F4), duplicated from ../../scripts/vapid.mjs's
// `generateVapidKeys`. Duplicated rather than imported: create-orla is a standalone npm package
// that runs from wherever `npx`/`npm create` puts it, before the Orla repo has even been cloned,
// so there is no reliable relative path back to the app repo's scripts/ directory at runtime.
// Keep this in sync with scripts/vapid.mjs if that file's algorithm ever changes.

function b64urlEncode(bytes) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return Buffer.from(binary, "binary").toString("base64url");
}

export async function generateVapidKeys() {
	const keyPair = await globalThis.crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);

	const rawPublic = new Uint8Array(
		await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey),
	);
	const jwkPrivate = await globalThis.crypto.subtle.exportKey("jwk", keyPair.privateKey);
	if (!jwkPrivate.d) {
		throw new Error("generateVapidKeys: exported private JWK missing d");
	}

	return { publicKey: b64urlEncode(rawPublic), privateKey: jwkPrivate.d };
}
