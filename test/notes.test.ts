import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

async function createNote(body: unknown) {
	return SELF.fetch(
		"http://example.com/api/notes",
		await withAccessHeader({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

async function getNotes(path: string) {
	return SELF.fetch(`http://example.com${path}`, await withAccessHeader());
}

describe("POST /api/notes", () => {
	it("returns 201 with the created note fields", async () => {
		const res = await createNote({ body: "buy milk" });
		expect(res.status).toBe(201);
		const note = await res.json();
		expect(note).toMatchObject({
			body: "buy milk",
			private: false,
			processed_at: null,
		});
		expect(typeof (note as { id: string }).id).toBe("string");
		expect(typeof (note as { created_at: string }).created_at).toBe("string");
	});

	it("stores the body untrimmed", async () => {
		const res = await createNote({ body: "  padded note  " });
		expect(res.status).toBe(201);
		const note = (await res.json()) as { body: string };
		expect(note.body).toBe("  padded note  ");
	});

	it("rejects an empty body", async () => {
		const res = await createNote({ body: "" });
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects a whitespace-only body", async () => {
		const res = await createNote({ body: "   " });
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects a body longer than 20,000 characters", async () => {
		const res = await createNote({ body: "a".repeat(20_001) });
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("accepts a body of exactly 20,000 characters", async () => {
		const res = await createNote({ body: "a".repeat(20_000) });
		expect(res.status).toBe(201);
	});

	it("rejects invalid JSON", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/notes",
			await withAccessHeader({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects a malformed client_id", async () => {
		const res = await createNote({ body: "note", client_id: "not-a-uuid" });
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("is idempotent for a repeated client_id", async () => {
		const clientId = crypto.randomUUID();
		const first = await createNote({ body: "idempotent note", client_id: clientId });
		const second = await createNote({ body: "idempotent note", client_id: clientId });

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);

		const firstNote = (await first.json()) as { id: string };
		const secondNote = (await second.json()) as { id: string };
		expect(secondNote.id).toBe(firstNote.id);

		const listRes = await getNotes("/api/notes?limit=200");
		const { notes } = (await listRes.json()) as { notes: { id: string }[] };
		const matches = notes.filter((n) => n.id === firstNote.id);
		expect(matches).toHaveLength(1);
	});

	it("round-trips private:true as a boolean", async () => {
		const res = await createNote({ body: "secret note", private: true });
		expect(res.status).toBe(201);
		const note = (await res.json()) as { private: boolean };
		expect(note.private).toBe(true);
	});
});

describe("GET /api/notes", () => {
	it("lists notes newest-first and respects limit / before cursor", async () => {
		await createNote({ body: "note a" });
		await createNote({ body: "note b" });
		const c = await createNote({ body: "note c" });
		const noteC = (await c.json()) as { created_at: string };

		const listRes = await getNotes("/api/notes?limit=2");
		expect(listRes.status).toBe(200);
		const { notes } = (await listRes.json()) as { notes: { id: string; created_at: string }[] };
		expect(notes).toHaveLength(2);
		const [first, second] = notes;
		expect(first && second && first.created_at >= second.created_at).toBe(true);

		const beforeRes = await getNotes(`/api/notes?before=${encodeURIComponent(noteC.created_at)}`);
		const { notes: beforeNotes } = (await beforeRes.json()) as {
			notes: { created_at: string }[];
		};
		for (const n of beforeNotes) {
			expect(n.created_at < noteC.created_at).toBe(true);
		}
	});

	it("rejects a non-numeric limit", async () => {
		const res = await getNotes("/api/notes?limit=abc");
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});
});
