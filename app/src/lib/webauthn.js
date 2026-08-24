/** WebAuthn helpers: base64url <-> ArrayBuffer conversions and options/credential (de)serialization. */

/**
 * Decodes a base64url string into an ArrayBuffer.
 * @param {string} value
 * @returns {ArrayBuffer}
 */
export function base64urlToBuffer(value) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) {
		bytes[i] = raw.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * Encodes an ArrayBuffer (or typed array) as a base64url string.
 * @param {ArrayBuffer|ArrayBufferView} buffer
 * @returns {string}
 */
export function bufferToBase64url(buffer) {
	const bytes =
		buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Converts server-provided registration options JSON (base64url fields) into a
 * PublicKeyCredentialCreationOptions object ready for navigator.credentials.create.
 * @param {object} json
 * @returns {PublicKeyCredentialCreationOptions}
 */
export function toCreationOptions(json) {
	if (
		typeof PublicKeyCredential !== "undefined" &&
		PublicKeyCredential.parseCreationOptionsFromJSON
	) {
		return PublicKeyCredential.parseCreationOptionsFromJSON(json);
	}
	return {
		...json,
		challenge: base64urlToBuffer(json.challenge),
		user: {
			...json.user,
			id: base64urlToBuffer(json.user.id),
		},
		excludeCredentials: (json.excludeCredentials ?? []).map((cred) => ({
			...cred,
			id: base64urlToBuffer(cred.id),
		})),
	};
}

/**
 * Converts server-provided authentication options JSON (base64url fields) into a
 * PublicKeyCredentialRequestOptions object ready for navigator.credentials.get.
 * @param {object} json
 * @returns {PublicKeyCredentialRequestOptions}
 */
export function toRequestOptions(json) {
	if (
		typeof PublicKeyCredential !== "undefined" &&
		PublicKeyCredential.parseRequestOptionsFromJSON
	) {
		return PublicKeyCredential.parseRequestOptionsFromJSON(json);
	}
	return {
		...json,
		challenge: base64urlToBuffer(json.challenge),
		allowCredentials: (json.allowCredentials ?? []).map((cred) => ({
			...cred,
			id: base64urlToBuffer(cred.id),
		})),
	};
}

/**
 * Converts a PublicKeyCredential (from create() or get()) into a plain JSON object with
 * base64url-encoded binary fields, suitable for POSTing to the verify endpoints.
 * @param {PublicKeyCredential} credential
 * @returns {object}
 */
export function credentialToJSON(credential) {
	if (typeof credential.toJSON === "function") {
		return credential.toJSON();
	}

	const response = credential.response;
	const json = {
		id: credential.id,
		rawId: bufferToBase64url(credential.rawId),
		type: credential.type,
		clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
	};
	if (credential.authenticatorAttachment) {
		json.authenticatorAttachment = credential.authenticatorAttachment;
	}

	if (typeof response.attestationObject !== "undefined") {
		json.response = {
			clientDataJSON: bufferToBase64url(response.clientDataJSON),
			attestationObject: bufferToBase64url(response.attestationObject),
		};
		if (typeof response.getTransports === "function") {
			json.response.transports = response.getTransports();
		}
	} else {
		json.response = {
			clientDataJSON: bufferToBase64url(response.clientDataJSON),
			authenticatorData: bufferToBase64url(response.authenticatorData),
			signature: bufferToBase64url(response.signature),
			userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
		};
	}

	return json;
}

/** Returns true when the browser exposes the WebAuthn API at all. */
export function isSupported() {
	return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

/**
 * Resolves to true when a platform authenticator (Face ID / Touch ID / Windows Hello / etc.)
 * is available, false otherwise (including when WebAuthn isn't supported at all).
 * @returns {Promise<boolean>}
 */
export async function isPlatformAuthenticatorAvailable() {
	if (!isSupported() || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
		return false;
	}
	try {
		return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
	} catch {
		return false;
	}
}
