/** Notifications section: Web Push enable/disable + test. Port of brief.js's notifications
 * section. */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import Button from "../../ui/Button";
import GlassCard from "../../ui/GlassCard";

type PushView =
	| { kind: "loading" }
	| { kind: "unsupported" }
	| { kind: "disabled" }
	| { kind: "enabled"; subscription: PushSubscription };

/** Converts a base64url-encoded VAPID public key into the Uint8Array pushManager.subscribe wants. */
function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	// Explicit ArrayBuffer (not the wider ArrayBufferLike Uint8Array's no-arg constructor infers)
	// so this satisfies PushSubscriptionOptionsInit.applicationServerKey's BufferSource type.
	const output = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) {
		output[i] = raw.charCodeAt(i);
	}
	return output;
}

function pushSupported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos(): boolean {
	return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
	return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

function IosHint() {
	if (!isIos() || isStandalone()) {
		return null;
	}
	return (
		<p className="hint">
			On iPhone/iPad, push notifications only work after adding Orla to your Home Screen (Share →
			Add to Home Screen).
		</p>
	);
}

async function subscribeAndRegister(): Promise<PushSubscription> {
	const registration = await navigator.serviceWorker.ready;
	let subscription = await registration.pushManager.getSubscription();
	if (!subscription) {
		const keyRes = await apiFetch("/api/push/vapid-public-key");
		if (!keyRes.ok) {
			throw new Error(`http ${keyRes.status}`);
		}
		const { key } = (await keyRes.json()) as { key: string };
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToUint8Array(key),
		});
	}

	const subscribeRes = await apiFetch("/api/push/subscribe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(subscription.toJSON()),
	});
	if (!subscribeRes.ok) {
		throw new Error(`http ${subscribeRes.status}`);
	}
	return subscription;
}

export default function PushSettings() {
	const [view, setView] = useState<PushView>({ kind: "loading" });
	const [enableBusy, setEnableBusy] = useState(false);
	const [testBusy, setTestBusy] = useState(false);
	const [disableBusy, setDisableBusy] = useState(false);
	const destroyedRef = useRef(false);

	const loadPushState = useCallback(async () => {
		if (!pushSupported()) {
			setView({ kind: "unsupported" });
			return;
		}
		setView({ kind: "loading" });
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (destroyedRef.current) {
				return;
			}
			if (subscription) {
				// Re-POST on load so a key rotation or reinstalled service worker's subscription stays
				// registered server-side (idempotent upsert on the endpoint).
				try {
					await apiFetch("/api/push/subscribe", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(subscription.toJSON()),
					});
				} catch (err) {
					console.error("settings: re-registering push subscription failed", err);
				}
				if (!destroyedRef.current) {
					setView({ kind: "enabled", subscription });
				}
			} else if (!destroyedRef.current) {
				setView({ kind: "disabled" });
			}
		} catch (err) {
			console.error("settings: failed to read push state", err);
			if (!destroyedRef.current) {
				setView({ kind: "disabled" });
			}
		}
	}, []);

	useEffect(() => {
		destroyedRef.current = false;
		loadPushState();
		return () => {
			destroyedRef.current = true;
		};
	}, [loadPushState]);

	async function enablePush() {
		setEnableBusy(true);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				return;
			}
			const subscription = await subscribeAndRegister();
			if (!destroyedRef.current) {
				setView({ kind: "enabled", subscription });
			}
		} catch (err) {
			console.error("settings: enable push failed", err);
		} finally {
			if (!destroyedRef.current) {
				setEnableBusy(false);
			}
		}
	}

	async function sendTest() {
		setTestBusy(true);
		try {
			const res = await apiFetch("/api/push/test", { method: "POST" });
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
		} catch (err) {
			console.error("settings: push test failed", err);
		} finally {
			if (!destroyedRef.current) {
				setTestBusy(false);
			}
		}
	}

	async function disable(subscription: PushSubscription) {
		setDisableBusy(true);
		try {
			const endpoint = subscription.endpoint;
			await subscription.unsubscribe();
			await apiFetch("/api/push/subscribe", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint }),
			}).catch(() => undefined);
			if (!destroyedRef.current) {
				await loadPushState();
			}
		} catch (err) {
			console.error("settings: disable push failed", err);
			if (!destroyedRef.current) {
				setDisableBusy(false);
			}
		}
	}

	return (
		<GlassCard title="Notifications">
			{view.kind === "loading" ? <p className="hint">Loading…</p> : null}
			{view.kind === "unsupported" ? (
				<>
					<p className="hint">Push notifications aren't supported in this browser.</p>
					<IosHint />
				</>
			) : null}
			{view.kind === "disabled" ? (
				<>
					<Button variant="primary" disabled={enableBusy} onClick={enablePush}>
						Enable morning push
					</Button>
					<IosHint />
				</>
			) : null}
			{view.kind === "enabled" ? (
				<>
					<p>Enabled — {endpointHost(view.subscription.endpoint)}</p>
					<div className="settings-actions-row">
						<Button disabled={testBusy} onClick={sendTest}>
							Send test
						</Button>
						<Button disabled={disableBusy} onClick={() => disable(view.subscription)}>
							Disable
						</Button>
					</div>
					<IosHint />
				</>
			) : null}
		</GlassCard>
	);
}
