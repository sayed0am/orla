#!/usr/bin/env node
// Generates a VAPID key pair for Web Push (PRD F4). Uses Node's built-in WebCrypto (globalThis
// .crypto) so this script has no dependencies, mirroring `generateVapidKeys` in src/push.ts —
// see that file's doc comment for why the private key is stored as the bare JWK `d` value.

function b64urlEncode(bytes) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return Buffer.from(binary, "binary").toString("base64url");
}

async function generateVapidKeys() {
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

const { publicKey, privateKey } = await generateVapidKeys();

console.log("VAPID key pair generated.\n");
console.log(`Public key:  ${publicKey}`);
console.log(`Private key: ${privateKey}\n`);
console.log("Next steps:");
console.log('  1. Put the public key in wrangler.jsonc under "vars" -> "VAPID_PUBLIC_KEY".');
console.log("  2. Store the private key as a secret:");
console.log("       wrangler secret put VAPID_PRIVATE_KEY");
console.log("     (paste the private key above when prompted)");
