/** Data layer for `raw_notes` — the instant-capture write path (PRD F2). No LLM calls here. */

export type RawNote = {
	id: string;
	body: string;
	created_at: string;
	private: boolean;
	processed_at: string | null;
};

type RawNoteRow = {
	id: string;
	body: string;
	created_at: string;
	private: number;
	processed_at: string | null;
};

function toRawNote(row: RawNoteRow): RawNote {
	return {
		id: row.id,
		body: row.body,
		created_at: row.created_at,
		private: row.private !== 0,
		processed_at: row.processed_at,
	};
}

export async function insertRawNote(
	db: D1Database,
	input: { body: string; private?: boolean; client_id?: string },
): Promise<RawNote> {
	const id = input.client_id ?? crypto.randomUUID();
	const isPrivate = input.private ?? false;

	await db
		.prepare(
			"INSERT INTO raw_notes (id, body, private) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
		)
		.bind(id, input.body, isPrivate ? 1 : 0)
		.run();

	const row = await db
		.prepare("SELECT id, body, created_at, private, processed_at FROM raw_notes WHERE id = ?")
		.bind(id)
		.first<RawNoteRow>();

	if (!row) {
		throw new Error("insertRawNote: row missing after insert");
	}

	return toRawNote(row);
}

export async function listRawNotes(
	db: D1Database,
	opts?: { limit?: number; before?: string },
): Promise<RawNote[]> {
	const limit = Math.min(opts?.limit ?? 50, 200);

	const query = opts?.before
		? db
				.prepare(
					"SELECT id, body, created_at, private, processed_at FROM raw_notes WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
				)
				.bind(opts.before, limit)
		: db
				.prepare(
					"SELECT id, body, created_at, private, processed_at FROM raw_notes ORDER BY created_at DESC LIMIT ?",
				)
				.bind(limit);

	const result = await query.all<RawNoteRow>();
	return result.results.map(toRawNote);
}
