/** Full-screen passkey login / registration view (Phase 3 step 1). */

import { credentialToJSON, isSupported, toCreationOptions, toRequestOptions } from "./webauthn.js";

const MIN_VERSIONS_HINT =
	"Passkeys need iOS 16+, Android Chrome 108+, or a desktop browser such as Safari 16+ or Chrome 108+.";

class HttpError extends Error {
	constructor(status) {
		super(
			status === 401 || status === 403
				? "Your session expired — try again."
				: `Request failed (${status}).`,
		);
		this.status = status;
	}
}

function describeError(err) {
	if (err instanceof HttpError) {
		return err.message;
	}
	if (err?.name === "NotAllowedError") {
		return "Cancelled — try again when you're ready.";
	}
	if (err?.name === "InvalidStateError") {
		return "This passkey is already registered on this device.";
	}
	return "Something went wrong. Check your connection and try again.";
}

async function postJson(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	if (!res.ok) {
		throw new HttpError(res.status);
	}
	const text = await res.text();
	return text.length > 0 ? JSON.parse(text) : undefined;
}

function defaultDeviceName() {
	return navigator.userAgentData?.platform || "This device";
}

/**
 * Mounts the full-screen login/registration view into `root`.
 * @param {HTMLElement} root
 * @param {{mode: string, has_credentials: boolean, authenticated: boolean}} status
 * @param {() => void} onSuccess called once registration or sign-in succeeds
 * @returns {() => void} unmount
 */
export function mountLogin(root, status, onSuccess) {
	const view = document.createElement("div");
	view.className = "login-view";
	root.appendChild(view);

	let destroyed = false;
	let conditionalAbort;

	function errorBox(container) {
		const p = document.createElement("p");
		p.className = "login-error";
		p.hidden = true;
		container.appendChild(p);
		return p;
	}

	function showError(box, message) {
		box.textContent = message;
		box.hidden = false;
	}

	function renderUnsupported(card) {
		const h1 = document.createElement("h1");
		h1.textContent = "Passkeys aren't supported here";
		card.appendChild(h1);
		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = MIN_VERSIONS_HINT;
		card.appendChild(p);
	}

	function renderSetup(card) {
		const h1 = document.createElement("h1");
		h1.textContent = "Set up Orla";
		card.appendChild(h1);

		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = "Create the first passkey for this Orla instance. It becomes the owner.";
		card.appendChild(p);

		const label = document.createElement("label");
		label.className = "login-name-label";
		label.textContent = "Name this passkey";
		card.appendChild(label);

		const input = document.createElement("input");
		input.type = "text";
		input.value = defaultDeviceName();
		input.maxLength = 60;
		label.appendChild(input);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "primary login-button";
		button.textContent = "Create passkey";
		card.appendChild(button);

		const errBox = errorBox(card);

		button.addEventListener("click", async () => {
			button.disabled = true;
			errBox.hidden = true;
			try {
				const optionsJson = await postJson("/api/auth/register/options");
				const credential = await navigator.credentials.create({
					publicKey: toCreationOptions(optionsJson),
				});
				await postJson("/api/auth/register/verify", {
					response: credentialToJSON(credential),
					name: input.value.trim() || "This device",
				});
				if (!destroyed) {
					onSuccess();
				}
			} catch (err) {
				console.error("login: registration failed", err);
				if (!destroyed) {
					showError(errBox, describeError(err));
					button.disabled = false;
				}
			}
		});
	}

	function renderSignIn(card) {
		const h1 = document.createElement("h1");
		h1.textContent = "Sign in";
		card.appendChild(h1);

		const p = document.createElement("p");
		p.className = "hint";
		p.textContent = "Use a passkey to sign in to Orla.";
		card.appendChild(p);

		// Conditional UI: a hidden username field autofill-capable authenticators can hook
		// into, so a passkey suggestion can surface without pressing the button first.
		const conditionalInput = document.createElement("input");
		conditionalInput.type = "text";
		conditionalInput.autocomplete = "username webauthn";
		conditionalInput.className = "login-conditional-input";
		conditionalInput.tabIndex = -1;
		conditionalInput.setAttribute("aria-hidden", "true");
		card.appendChild(conditionalInput);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "primary login-button";
		button.textContent = "Use passkey";
		card.appendChild(button);

		const errBox = errorBox(card);

		async function signIn(mediation) {
			errBox.hidden = true;
			if (mediation !== "conditional") {
				button.disabled = true;
			}
			const getOptions = {};
			try {
				const optionsJson = await postJson("/api/auth/login/options");
				getOptions.publicKey = toRequestOptions(optionsJson);
				if (mediation) {
					conditionalAbort = new AbortController();
					getOptions.mediation = mediation;
					getOptions.signal = conditionalAbort.signal;
				}
				const credential = await navigator.credentials.get(getOptions);
				await postJson("/api/auth/login/verify", { response: credentialToJSON(credential) });
				if (!destroyed) {
					onSuccess();
				}
			} catch (err) {
				if (err?.name === "AbortError") {
					return;
				}
				console.error("login: sign-in failed", err);
				if (!destroyed) {
					showError(errBox, describeError(err));
				}
			} finally {
				if (!destroyed && mediation !== "conditional") {
					button.disabled = false;
				}
			}
		}

		button.addEventListener("click", () => {
			conditionalAbort?.abort();
			signIn();
		});

		if (
			typeof PublicKeyCredential !== "undefined" &&
			PublicKeyCredential.isConditionalMediationAvailable
		) {
			PublicKeyCredential.isConditionalMediationAvailable()
				.then((available) => {
					if (available && !destroyed) {
						signIn("conditional");
					}
				})
				.catch(() => undefined);
		}
	}

	function render() {
		view.innerHTML = "";
		const card = document.createElement("div");
		card.className = "login-card";
		view.appendChild(card);

		if (!isSupported()) {
			renderUnsupported(card);
			return;
		}

		if (status.has_credentials) {
			renderSignIn(card);
		} else {
			renderSetup(card);
		}
	}

	render();

	return function unmount() {
		destroyed = true;
		conditionalAbort?.abort();
	};
}
