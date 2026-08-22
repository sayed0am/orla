/** HTTP handlers for Web Push subscription management (PRD F4). */

import { broadcast } from "../push";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// Test-only hook, mirroring `setReorgFetchForTests` in src/reorganize.ts: route tests can't pass
// a function through the request/response cycle, so a fake fetch is installed here instead.
let testPushFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake push fetch used by `handlePushTest`. */
export function setPushFetchForTests(f: typeof fetch | undefined): void {
	testPushFetch = f;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function isBase64Url(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && BASE64URL_RE.test(value);
}

export async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}

	const { endpoint, keys } = payload as Record<string, unknown>;
	if (!isHttpsUrl(endpoint)) {
		return Response.json({ error: "endpoint must be an https URL" }, { status: 400 });
	}
	if (typeof keys !== "object" || keys === null) {
		return Response.json({ error: "keys must be an object" }, { status: 400 });
	}

	const { p256dh, auth } = keys as Record<string, unknown>;
	if (!isBase64Url(p256dh) || !isBase64Url(auth)) {
		return Response.json(
			{ error: "keys.p256dh and keys.auth must be base64url strings" },
			{ status: 400 },
		);
	}

	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
	)
		.bind(id, endpoint, p256dh, auth)
		.run();

	const row = await env.ORLA_DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
		.bind(endpoint)
		.first<{ id: string }>();

	return Response.json({ id: row?.id ?? id }, { status: 201 });
}

export async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (typeof payload !== "object" || payload === null) {
		return Response.json({ error: "body must be a JSON object" }, { status: 400 });
	}

	const { endpoint } = payload as Record<string, unknown>;
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		return Response.json({ error: "endpoint must be a non-empty string" }, { status: 400 });
	}

	await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
		.bind(endpoint)
		.run();

	return new Response(null, { status: 204 });
}

export function handleVapidPublicKey(env: Env): Response {
	return Response.json({ key: env.VAPID_PUBLIC_KEY });
}

export async function handlePushTest(env: Env): Promise<Response> {
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		return Response.json({ error: "push not configured" }, { status: 500 });
	}

	const result = await broadcast(
		env.ORLA_DB,
		JSON.stringify({ title: "Orla", body: "Push is working" }),
		{
			publicKey: env.VAPID_PUBLIC_KEY,
			privateKey: env.VAPID_PRIVATE_KEY,
			subject: env.VAPID_SUBJECT,
		},
		testPushFetch,
	);

	return Response.json(result, { status: 200 });
}
