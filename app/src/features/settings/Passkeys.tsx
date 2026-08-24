/** Passkeys section (passkey auth mode only): credential list, add another, sign out. Port of
 * brief.js's passkeys section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { credentialToJSON, toCreationOptions } from "../../lib/webauthn.js";
import Button from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import GlassCard from "../../ui/GlassCard";
import { formatDateTime } from "./format";

interface Credential {
	id: string;
	name: string | null;
	created_at: string;
	last_used_at: string | null;
}

function defaultDeviceName(): string {
	const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return uaData?.platform || "This device";
}

function PasskeyRow({
	credential,
	onRemove,
}: {
	credential: Credential;
	onRemove: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const destroyedRef = useRef(false);
	useEffect(
		() => () => {
			destroyedRef.current = true;
		},
		[],
	);

	async function click() {
		setBusy(true);
		await onRemove();
		if (!destroyedRef.current) {
			setBusy(false);
		}
	}

	return (
		<div className="passkey-row">
			<div className="passkey-info">
				<div className="passkey-name">{credential.name || "Unnamed passkey"}</div>
				<div className="passkey-meta hint">
					Added {formatDateTime(credential.created_at)} · Last used{" "}
					{formatDateTime(credential.last_used_at)}
				</div>
			</div>
			<Button variant="ghost" disabled={busy} onClick={click}>
				Remove
			</Button>
		</div>
	);
}

function AddPasskeyRow({ onSubmit }: { onSubmit: (name: string) => Promise<boolean> }) {
	const [name, setName] = useState(defaultDeviceName);
	const [busy, setBusy] = useState(false);

	async function submit() {
		setBusy(true);
		await onSubmit(name.trim() || "This device");
		setBusy(false);
	}

	return (
		<div className="passkey-add-row">
			<TextInput
				type="text"
				placeholder="Name this passkey"
				maxLength={60}
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Button variant="primary" disabled={busy} onClick={submit}>
				Add another passkey
			</Button>
		</div>
	);
}

export default function Passkeys() {
	const [credentials, setCredentials] = useState<Credential[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const destroyedRef = useRef(false);

	const load = useCallback(async () => {
		setLoadError(false);
		let res: Response;
		try {
			res = await apiFetch("/api/auth/credentials");
		} catch (err) {
			console.error("settings: failed to load passkeys", err);
			if (!destroyedRef.current) {
				setCredentials(null);
				setLoadError(true);
			}
			return;
		}
		if (destroyedRef.current) {
			return;
		}
		if (!res.ok) {
			setCredentials(null);
			setLoadError(true);
			return;
		}
		const data = (await res.json()) as { credentials?: Credential[] };
		setCredentials(data.credentials ?? []);
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		load();
		return () => {
			destroyedRef.current = true;
		};
	}, [load]);

	async function handleRemove(id: string) {
		setErrorMsg(null);
		try {
			const res = await apiFetch(`/api/auth/credentials/${id}`, { method: "DELETE" });
			if (res.status === 409) {
				setErrorMsg("You can't remove your last passkey.");
				return;
			}
			if (!res.ok && res.status !== 204) {
				throw new Error(`http ${res.status}`);
			}
			if (!destroyedRef.current) {
				await load();
			}
		} catch (err) {
			console.error("settings: failed to remove passkey", err);
			setErrorMsg("Couldn't remove that passkey.");
		}
	}

	async function handleAdd(name: string): Promise<boolean> {
		setErrorMsg(null);
		try {
			const optionsRes = await apiFetch("/api/auth/register/options", { method: "POST" });
			if (!optionsRes.ok) {
				throw new Error(`http ${optionsRes.status}`);
			}
			const optionsJson = await optionsRes.json();
			const credential = await navigator.credentials.create({
				publicKey: toCreationOptions(optionsJson),
			});
			const verifyRes = await apiFetch("/api/auth/register/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					response: credentialToJSON(credential as PublicKeyCredential),
					name,
				}),
			});
			if (!verifyRes.ok) {
				throw new Error(`http ${verifyRes.status}`);
			}
			if (!destroyedRef.current) {
				await load();
			}
			return true;
		} catch (err) {
			console.error("settings: failed to add passkey", err);
			if (!destroyedRef.current) {
				setErrorMsg(
					err instanceof Error && err.name === "NotAllowedError"
						? "Cancelled."
						: "Couldn't add that passkey.",
				);
			}
			return false;
		}
	}

	async function signOut() {
		try {
			const res = await apiFetch("/api/auth/logout", { method: "POST" });
			if (!res.ok && res.status !== 204) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("settings: sign out failed", err);
		} finally {
			// Reload unconditionally: whether or not the request succeeded, the freshest source of
			// truth for whether we're still signed in is a fresh /api/auth/status (matches brief.js).
			window.location.reload();
		}
	}

	return (
		<GlassCard title="Passkeys">
			{credentials === null && !loadError ? <p className="hint">Loading…</p> : null}
			{loadError ? <p className="hint">Couldn't load passkeys.</p> : null}
			{credentials !== null ? (
				<>
					{credentials.length === 0 ? (
						<p className="hint">No passkeys yet.</p>
					) : (
						credentials.map((credential) => (
							<PasskeyRow
								key={credential.id}
								credential={credential}
								onRemove={() => handleRemove(credential.id)}
							/>
						))
					)}
					<AddPasskeyRow onSubmit={handleAdd} />
					{errorMsg ? <p className="passkeys-error hint">{errorMsg}</p> : null}
					<Button variant="ghost" className="passkeys-signout" onClick={signOut}>
						Sign out
					</Button>
				</>
			) : null}
		</GlassCard>
	);
}
