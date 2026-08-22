import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { broadcast, generateVapidKeys, sendPush, type VapidConfig } from "../src/push";
import { setPushFetchForTests } from "../src/routes/push";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";
import {
	decryptPushBody,
	generateTestSubscriber,
	parseVapidAuthHeader,
	verifyVapidJwt,
} from "./push-crypto-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

afterEach(() => {
	setPushFetchForTests(undefined);
});

function b64urlDecode(input: string): Uint8Array {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - (normalized.length % 4)) % 4;
	const padded = normalized + "=".repeat(padLength);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

type Captured = { url: string; headers: Headers; body: Uint8Array };

function fakePushFetch(status: number): { fetchImpl: typeof fetch; captured: Captured[] } {
	const captured: Captured[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		captured.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: init?.body as Uint8Array,
		});
		return new Response(null, { status });
	};
	return { fetchImpl, captured };
}

async function insertSubscription(opts: {
	endpoint: string;
	p256dh: string;
	auth: string;
	failures?: number;
}): Promise<string> {
	const id = crypto.randomUUID();
	await env.ORLA_DB.prepare(
		"INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, failures) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, opts.endpoint, opts.p256dh, opts.auth, opts.failures ?? 0)
		.run();
	return id;
}

describe("generateVapidKeys", () => {
	it("returns a 65-byte uncompressed public point and a 32-byte private scalar", async () => {
		const keys = await generateVapidKeys();
		const publicBytes = b64urlDecode(keys.publicKey);
		const privateBytes = b64urlDecode(keys.privateKey);

		expect(publicBytes).toHaveLength(65);
		expect(publicBytes[0]).toBe(0x04);
		expect(privateBytes).toHaveLength(32);
	});

	it("generates a distinct key pair on every call", async () => {
		const a = await generateVapidKeys();
		const b = await generateVapidKeys();
		expect(a.publicKey).not.toBe(b.publicKey);
		expect(a.privateKey).not.toBe(b.privateKey);
	});
});

describe("sendPush", () => {
	it("encrypts the payload per RFC 8291 so an independent subscriber-side decrypt recovers it, and signs a valid VAPID JWT", async () => {
		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const subscriber = await generateTestSubscriber();
		const { fetchImpl, captured } = fakePushFetch(201);

		const result = await sendPush(
			{
				endpoint: "https://push.example.com/subscription/rfc8291-test",
				p256dh: subscriber.p256dh,
				auth: subscriber.auth,
			},
			"hello from orla",
			vapid,
			fetchImpl,
		);

		expect(result).toEqual({ ok: true });
		expect(captured).toHaveLength(1);
		const request = captured[0];
		if (!request) throw new Error("expected a captured request");

		expect(request.url).toBe("https://push.example.com/subscription/rfc8291-test");
		expect(request.headers.get("Content-Encoding")).toBe("aes128gcm");
		expect(request.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(request.headers.get("TTL")).toBe("86400");
		expect(request.headers.get("Urgency")).toBe("normal");

		const decrypted = await decryptPushBody(request.body.buffer as ArrayBuffer, subscriber);
		expect(decrypted).toBe("hello from orla");

		const authHeader = request.headers.get("Authorization");
		if (!authHeader) throw new Error("expected an Authorization header");
		const { jwt, publicKey } = parseVapidAuthHeader(authHeader);
		expect(publicKey).toBe(vapid.publicKey);

		const { header, payload } = await verifyVapidJwt(jwt, vapid.publicKey);
		expect(header).toMatchObject({ typ: "JWT", alg: "ES256" });
		expect(payload.aud).toBe("https://push.example.com");
		expect(payload.sub).toBe("mailto:test@example.com");
		expect(typeof payload.exp).toBe("number");
	});

	it("produces a different salt/ciphertext each call (the record is never replayable)", async () => {
		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const subscriber = await generateTestSubscriber();
		const { fetchImpl, captured } = fakePushFetch(201);
		const sub = {
			endpoint: "https://push.example.com/subscription/salt-test",
			p256dh: subscriber.p256dh,
			auth: subscriber.auth,
		};

		await sendPush(sub, "same payload", vapid, fetchImpl);
		await sendPush(sub, "same payload", vapid, fetchImpl);

		expect(captured).toHaveLength(2);
		const [first, second] = captured;
		if (!first || !second) throw new Error("expected two captured requests");
		expect(first.body).not.toEqual(second.body);
	});

	it("reports gone:true on 404 and 410, and gone:false on other failures", async () => {
		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const subscriber = await generateTestSubscriber();
		const sub = {
			endpoint: "https://push.example.com/subscription/status-test",
			p256dh: subscriber.p256dh,
			auth: subscriber.auth,
		};

		const gone410 = await sendPush(sub, "x", vapid, fakePushFetch(410).fetchImpl);
		expect(gone410).toEqual({ ok: false, status: 410, gone: true });

		const gone404 = await sendPush(sub, "x", vapid, fakePushFetch(404).fetchImpl);
		expect(gone404).toEqual({ ok: false, status: 404, gone: true });

		const serverError = await sendPush(sub, "x", vapid, fakePushFetch(500).fetchImpl);
		expect(serverError).toEqual({ ok: false, status: 500, gone: false });
	});
});

describe("broadcast", () => {
	it("marks a successful subscription's last_success_at and resets failures", async () => {
		const subscriber = await generateTestSubscriber();
		const endpoint = `https://push.example.com/broadcast/success-${crypto.randomUUID()}`;
		const id = await insertSubscription({
			endpoint,
			p256dh: subscriber.p256dh,
			auth: subscriber.auth,
			failures: 2,
		});

		const fetchImpl: typeof fetch = async (input) =>
			String(input) === endpoint
				? new Response(null, { status: 201 })
				: new Response(null, { status: 200 });

		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const result = await broadcast(env.ORLA_DB, "payload", vapid, fetchImpl);
		expect(result.sent).toBeGreaterThanOrEqual(1);

		const row = await env.ORLA_DB.prepare(
			"SELECT last_success_at, failures FROM push_subscriptions WHERE id = ?",
		)
			.bind(id)
			.first<{ last_success_at: string | null; failures: number }>();
		expect(row?.last_success_at).not.toBeNull();
		expect(row?.failures).toBe(0);

		// Cleanup: a successful push leaves the row in place, so it doesn't ride along into later
		// tests/other files that iterate the whole push_subscriptions table.
		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run();
	});

	it("deletes a subscription immediately when the push service reports it gone", async () => {
		const subscriber = await generateTestSubscriber();
		const endpoint = `https://push.example.com/broadcast/gone-${crypto.randomUUID()}`;
		await insertSubscription({ endpoint, p256dh: subscriber.p256dh, auth: subscriber.auth });

		const fetchImpl: typeof fetch = async (input) =>
			String(input) === endpoint
				? new Response(null, { status: 410 })
				: new Response(null, { status: 200 });

		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const result = await broadcast(env.ORLA_DB, "payload", vapid, fetchImpl);
		expect(result.removed).toBeGreaterThanOrEqual(1);

		const row = await env.ORLA_DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.first();
		expect(row).toBeNull();
	});

	it("increments failures on a non-gone error and removes the subscription once failures reach 5", async () => {
		const subscriberA = await generateTestSubscriber();
		const endpointA = `https://push.example.com/broadcast/fail-increment-${crypto.randomUUID()}`;
		const idA = await insertSubscription({
			endpoint: endpointA,
			p256dh: subscriberA.p256dh,
			auth: subscriberA.auth,
			failures: 1,
		});

		const subscriberB = await generateTestSubscriber();
		const endpointB = `https://push.example.com/broadcast/fail-giveup-${crypto.randomUUID()}`;
		await insertSubscription({
			endpoint: endpointB,
			p256dh: subscriberB.p256dh,
			auth: subscriberB.auth,
			failures: 4,
		});

		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url === endpointA || url === endpointB) return new Response(null, { status: 500 });
			return new Response(null, { status: 200 });
		};

		const vapid: VapidConfig = {
			...(await generateVapidKeys()),
			subject: "mailto:test@example.com",
		};
		const result = await broadcast(env.ORLA_DB, "payload", vapid, fetchImpl);
		expect(result.failed).toBeGreaterThanOrEqual(2);

		const rowA = await env.ORLA_DB.prepare("SELECT failures FROM push_subscriptions WHERE id = ?")
			.bind(idA)
			.first<{ failures: number }>();
		expect(rowA?.failures).toBe(2);

		const rowB = await env.ORLA_DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpointB)
			.first();
		expect(rowB).toBeNull();

		// Cleanup: endpointA survives (failures=2 < 5), remove it so it doesn't ride along into
		// later tests/other files that iterate the whole push_subscriptions table.
		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(idA).run();
	});
});

describe("POST /api/push/subscribe", () => {
	it("upserts by endpoint and returns 201 with an id", async () => {
		const endpoint = `https://push.example.com/route/subscribe-${crypto.randomUUID()}`;
		const res = await SELF.fetch(
			"http://example.com/api/push/subscribe",
			await withAccessHeader({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint, keys: { p256dh: "AAAA", auth: "BBBB" } }),
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		expect(typeof body.id).toBe("string");

		const row = await env.ORLA_DB.prepare(
			"SELECT p256dh, auth, failures FROM push_subscriptions WHERE endpoint = ?",
		)
			.bind(endpoint)
			.first<{ p256dh: string; auth: string; failures: number }>();
		expect(row).toMatchObject({ p256dh: "AAAA", auth: "BBBB", failures: 0 });

		// Re-subscribing the same endpoint with new keys updates in place (upsert), not duplicates.
		const res2 = await SELF.fetch(
			"http://example.com/api/push/subscribe",
			await withAccessHeader({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint, keys: { p256dh: "CCCC", auth: "DDDD" } }),
			}),
		);
		expect(res2.status).toBe(201);
		const row2 = await env.ORLA_DB.prepare(
			"SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?",
		)
			.bind(endpoint)
			.first<{ p256dh: string; auth: string }>();
		expect(row2).toMatchObject({ p256dh: "CCCC", auth: "DDDD" });

		await env.ORLA_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.run();
	});

	it("rejects a non-https endpoint", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/push/subscribe",
			await withAccessHeader({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					endpoint: "http://insecure.example.com",
					keys: { p256dh: "A", auth: "B" },
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects non-base64url keys", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/push/subscribe",
			await withAccessHeader({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					endpoint: "https://push.example.com/route/bad-keys",
					keys: { p256dh: "not base64url!!", auth: "BBBB" },
				}),
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects unauthenticated requests", async () => {
		const res = await SELF.fetch("http://example.com/api/push/subscribe", { method: "POST" });
		expect(res.status).toBe(401);
	});
});

describe("DELETE /api/push/subscribe", () => {
	it("deletes the subscription and returns 204", async () => {
		const endpoint = `https://push.example.com/route/unsubscribe-${crypto.randomUUID()}`;
		await insertSubscription({ endpoint, p256dh: "AAAA", auth: "BBBB" });

		const res = await SELF.fetch(
			"http://example.com/api/push/subscribe",
			await withAccessHeader({
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint }),
			}),
		);
		expect(res.status).toBe(204);

		const row = await env.ORLA_DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(endpoint)
			.first();
		expect(row).toBeNull();
	});
});

describe("GET /api/push/vapid-public-key", () => {
	it("returns the configured public key", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/push/vapid-public-key",
			await withAccessHeader(),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { key: string };
		expect(body.key).toBe(env.VAPID_PUBLIC_KEY);
	});

	it("rejects unauthenticated requests", async () => {
		const res = await SELF.fetch("http://example.com/api/push/vapid-public-key");
		expect(res.status).toBe(401);
	});
});

describe("POST /api/push/test", () => {
	it("returns 500 when VAPID keys are not configured", async () => {
		expect(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY).toBeFalsy();
		const res = await SELF.fetch(
			"http://example.com/api/push/test",
			await withAccessHeader({ method: "POST" }),
		);
		expect(res.status).toBe(500);
	});
});
