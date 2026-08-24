/** WebAuthn helpers: base64url <-> ArrayBuffer conversions and options/credential (de)serialization. */

/** Decodes a base64url string into an ArrayBuffer. */
export function base64urlToBuffer(value: string): ArrayBuffer;

/** Encodes an ArrayBuffer (or typed array) as a base64url string. */
export function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferView): string;

/**
 * Converts server-provided registration options JSON (base64url fields) into a
 * PublicKeyCredentialCreationOptions object ready for navigator.credentials.create.
 */
export function toCreationOptions(json: unknown): PublicKeyCredentialCreationOptions;

/**
 * Converts server-provided authentication options JSON (base64url fields) into a
 * PublicKeyCredentialRequestOptions object ready for navigator.credentials.get.
 */
export function toRequestOptions(json: unknown): PublicKeyCredentialRequestOptions;

/**
 * Converts a PublicKeyCredential (from create() or get()) into a plain JSON object with
 * base64url-encoded binary fields, suitable for POSTing to the verify endpoints.
 */
export function credentialToJSON(credential: PublicKeyCredential): Record<string, unknown>;

/** Returns true when the browser exposes the WebAuthn API at all. */
export function isSupported(): boolean;

/**
 * Resolves to true when a platform authenticator (Face ID / Touch ID / Windows Hello / etc.)
 * is available, false otherwise (including when WebAuthn isn't supported at all).
 */
export function isPlatformAuthenticatorAvailable(): Promise<boolean>;
