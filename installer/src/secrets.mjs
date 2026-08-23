// Local secret generation. Pure aside from reading `node:crypto`'s CSPRNG, so it's trivially
// unit-testable for shape (length, alphabet) without mocking randomness.

import { randomBytes } from "node:crypto";

/** A `SESSION_SECRET` for signing the passkey session cookie: 48 random bytes, base64-encoded
 * (64 base64 characters, well over `src/auth.ts`'s MIN_SESSION_SECRET_LENGTH of 32). */
export function generateSessionSecret() {
	return randomBytes(48).toString("base64");
}
