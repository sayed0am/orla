/** Full-screen passkey login / registration view (port of public/login.js). */

import { useEffect, useRef, useState } from "react";
import { type AuthStatus, apiFetch } from "../../lib/api";
import {
	credentialToJSON,
	isSupported,
	toCreationOptions,
	toRequestOptions,
} from "../../lib/webauthn.js";
import Button from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import GlassCard from "../../ui/GlassCard";

const MIN_VERSIONS_HINT =
	"Passkeys need iOS 16+, Android Chrome 108+, or a desktop browser such as Safari 16+ or Chrome 108+.";

class HttpError extends Error {
	status: number;

	constructor(status: number) {
		super(
			status === 401 || status === 403
				? "Your session expired — try again."
				: `Request failed (${status}).`,
		);
		this.status = status;
	}
}

function describeError(err: unknown): string {
	if (err instanceof HttpError) {
		return err.message;
	}
	if (err instanceof Error) {
		if (err.name === "NotAllowedError") {
			return "Cancelled — try again when you're ready.";
		}
		if (err.name === "InvalidStateError") {
			return "This passkey is already registered on this device.";
		}
	}
	return "Something went wrong. Check your connection and try again.";
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
	const res = await apiFetch(path, {
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

function defaultDeviceName(): string {
	const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return uaData?.platform || "This device";
}

interface LoginScreenProps {
	status: AuthStatus;
	onSuccess: () => void;
}

export default function LoginScreen({ status, onSuccess }: LoginScreenProps) {
	return (
		<div className="login-view">
			<GlassCard className="login-card">
				<p className="login-hero brand">Orla</p>
				<p className="hint">A personal assistant that lives at the edge.</p>
				{!isSupported() ? (
					<Unsupported />
				) : status.has_credentials ? (
					<SignIn onSuccess={onSuccess} />
				) : (
					<Setup onSuccess={onSuccess} />
				)}
			</GlassCard>
		</div>
	);
}

function Unsupported() {
	return (
		<>
			<h1>Passkeys aren't supported here</h1>
			<p className="hint">{MIN_VERSIONS_HINT}</p>
		</>
	);
}

function Setup({ onSuccess }: { onSuccess: () => void }) {
	const [name, setName] = useState(defaultDeviceName);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);

	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	async function createPasskey() {
		setBusy(true);
		setError(null);
		try {
			const optionsJson = await postJson("/api/auth/register/options");
			const credential = await navigator.credentials.create({
				publicKey: toCreationOptions(optionsJson),
			});
			await postJson("/api/auth/register/verify", {
				response: credentialToJSON(credential as PublicKeyCredential),
				name: name.trim() || "This device",
			});
			if (mountedRef.current) {
				onSuccess();
			}
		} catch (err) {
			console.error("login: registration failed", err);
			if (mountedRef.current) {
				setError(describeError(err));
				setBusy(false);
			}
		}
	}

	return (
		<>
			<h1>Set up Orla</h1>
			<p className="hint">Create the first passkey for this Orla instance. It becomes the owner.</p>
			<label className="login-name-label" htmlFor="login-passkey-name">
				Name this passkey
				<TextInput
					id="login-passkey-name"
					value={name}
					maxLength={60}
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			<Button variant="primary" className="login-button" disabled={busy} onClick={createPasskey}>
				Create passkey
			</Button>
			{error ? <p className="login-error">{error}</p> : null}
		</>
	);
}

function SignIn({ onSuccess }: { onSuccess: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	const conditionalAbortRef = useRef<AbortController | undefined>(undefined);

	async function signIn(mediation?: CredentialMediationRequirement) {
		setError(null);
		if (mediation !== "conditional") {
			setBusy(true);
		}
		const getOptions: CredentialRequestOptions = {};
		try {
			const optionsJson = await postJson("/api/auth/login/options");
			getOptions.publicKey = toRequestOptions(optionsJson);
			if (mediation) {
				const controller = new AbortController();
				conditionalAbortRef.current = controller;
				getOptions.mediation = mediation;
				getOptions.signal = controller.signal;
			}
			const credential = await navigator.credentials.get(getOptions);
			await postJson("/api/auth/login/verify", {
				response: credentialToJSON(credential as PublicKeyCredential),
			});
			if (mountedRef.current) {
				onSuccess();
			}
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				return;
			}
			console.error("login: sign-in failed", err);
			if (mountedRef.current) {
				setError(describeError(err));
			}
		} finally {
			if (mountedRef.current && mediation !== "conditional") {
				setBusy(false);
			}
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount only, mirrors login.js's mount-time conditional-mediation kickoff
	useEffect(() => {
		mountedRef.current = true;

		if (
			typeof PublicKeyCredential !== "undefined" &&
			PublicKeyCredential.isConditionalMediationAvailable
		) {
			PublicKeyCredential.isConditionalMediationAvailable()
				.then((available) => {
					if (available && mountedRef.current) {
						signIn("conditional");
					}
				})
				.catch(() => undefined);
		}

		return () => {
			mountedRef.current = false;
			conditionalAbortRef.current?.abort();
		};
	}, []);

	function onButtonClick() {
		conditionalAbortRef.current?.abort();
		signIn();
	}

	return (
		<>
			<h1>Sign in</h1>
			<p className="hint">Use a passkey to sign in to Orla.</p>
			{/* Conditional UI: a hidden username field autofill-capable authenticators can hook
			    into, so a passkey suggestion can surface without pressing the button first. */}
			<input
				type="text"
				autoComplete="username webauthn"
				className="login-conditional-input"
				tabIndex={-1}
				aria-hidden="true"
			/>
			<Button variant="primary" className="login-button" disabled={busy} onClick={onButtonClick}>
				Use passkey
			</Button>
			{error ? <p className="login-error">{error}</p> : null}
		</>
	);
}
