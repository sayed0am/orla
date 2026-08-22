/**
 * Memory Option A (PRD §8): a small curated `memory_facts` table (migrations/0007), user-
 * controlled, rendered into one stable block in the cached prompt prefix (`src/prompt.ts`'s
 * `memoryBlock`, placed second, right after the static system prompt). Only `active` facts ever
 * reach a prompt — `proposed` rows (from the nightly pass, PRD F3) and `archived` rows never do,
 * which is the auditability and privacy-composition guarantee from PRD §8's decision criteria.
 *
 * Cache note: the rendered block changes only when a user activates, edits, or archives a fact —
 * exactly the "prefix must change rarely" criterion (PRD §8 #1) — so it amortizes the same way the
 * static system prompt does.
 */

export type MemoryFactStatus = "proposed" | "active" | "archived";
export type MemoryFactSource = "user" | "reorganize";

export type MemoryFact = {
	id: string;
	text: string;
	status: MemoryFactStatus;
	source: MemoryFactSource;
	source_note_id: string | null;
	created_at: string;
	updated_at: string;
};

const MEMORY_FACT_COLUMNS = "id, text, status, source, source_note_id, created_at, updated_at";
const MAX_FACT_LENGTH = 200;
// PRD §8 Option A target: "< 1-2k tokens rendered" — a hard character cap on the rendered block
// protects the cache budget even if many facts are activated.
const MAX_BLOCK_LENGTH = 1500;
const OMITTED_SUFFIX = "- (more facts omitted)";

export class MemoryValidationError extends Error {}

function validateFactText(raw: string): string {
	const text = raw.trim();
	if (text.length === 0 || text.length > MAX_FACT_LENGTH) {
		throw new MemoryValidationError(`text must be 1 to ${MAX_FACT_LENGTH} characters`);
	}
	return text;
}

async function getFactById(db: D1Database, id: string): Promise<MemoryFact | null> {
	const row = await db
		.prepare(`SELECT ${MEMORY_FACT_COLUMNS} FROM memory_facts WHERE id = ?`)
		.bind(id)
		.first<MemoryFact>();
	return row ?? null;
}

/** Lists facts, optionally filtered to one status, oldest-first (stable, matches render order). */
export async function listFacts(db: D1Database, status?: MemoryFactStatus): Promise<MemoryFact[]> {
	if (status !== undefined) {
		const result = await db
			.prepare(
				`SELECT ${MEMORY_FACT_COLUMNS} FROM memory_facts WHERE status = ? ORDER BY created_at ASC, id ASC`,
			)
			.bind(status)
			.all<MemoryFact>();
		return result.results;
	}

	const result = await db
		.prepare(`SELECT ${MEMORY_FACT_COLUMNS} FROM memory_facts ORDER BY created_at ASC, id ASC`)
		.all<MemoryFact>();
	return result.results;
}

/** Inserts a new fact. `status` defaults to `"proposed"` (the nightly pass's case); a user-created
 * fact (`POST /api/memory`) passes `status: "active"` explicitly. */
export async function createFact(
	db: D1Database,
	input: {
		text: string;
		source: MemoryFactSource;
		sourceNoteId?: string;
		status?: MemoryFactStatus;
	},
): Promise<MemoryFact> {
	const text = validateFactText(input.text);
	const id = crypto.randomUUID();
	const status = input.status ?? "proposed";

	await db
		.prepare(
			"INSERT INTO memory_facts (id, text, status, source, source_note_id) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(id, text, status, input.source, input.sourceNoteId ?? null)
		.run();

	const row = await getFactById(db, id);
	if (!row) {
		throw new Error("createFact: row missing after insert");
	}
	return row;
}

/**
 * Edits and/or changes the status of a fact (activate a proposal, archive, edit text), bumping
 * `updated_at`. Returns `null` when `id` doesn't exist rather than throwing, so routes can turn
 * that into a 404.
 */
export async function updateFact(
	db: D1Database,
	id: string,
	patch: { text?: string; status?: MemoryFactStatus },
): Promise<MemoryFact | null> {
	const existing = await getFactById(db, id);
	if (!existing) {
		return null;
	}

	const text = patch.text !== undefined ? validateFactText(patch.text) : existing.text;
	const status = patch.status ?? existing.status;

	await db
		.prepare(
			"UPDATE memory_facts SET text = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
		)
		.bind(text, status, id)
		.run();

	const row = await getFactById(db, id);
	if (!row) {
		throw new Error("updateFact: row missing after update");
	}
	return row;
}

/** Hard-deletes a fact — the user owns this table. Returns `false` when `id` didn't exist. */
export async function deleteFact(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM memory_facts WHERE id = ?").bind(id).run();
	return result.meta.changes > 0;
}

/**
 * Deterministically renders `active` facts into one prompt block, oldest-first (so an edit to an
 * existing fact never reorders the block — only its own line's text changes) and stops appending
 * once the block would exceed `MAX_BLOCK_LENGTH` characters, appending a fixed omission marker
 * instead (PRD §8 "cache impact" + "cost" criteria). Returns `""` when there are no active facts,
 * so `buildMessages` (src/prompt.ts) omits the memory system message entirely.
 */
export function renderMemoryBlock(facts: { text: string }[]): string {
	if (facts.length === 0) {
		return "";
	}

	const header =
		"Facts the user has confirmed about themselves (treat as reliable background, do not " +
		"repeat back unprompted):";
	const lines: string[] = [header];

	let omitted = false;
	for (const fact of facts) {
		const candidate = [...lines, `- ${fact.text}`].join("\n");
		if (candidate.length > MAX_BLOCK_LENGTH) {
			omitted = true;
			break;
		}
		lines.push(`- ${fact.text}`);
	}

	if (omitted) {
		lines.push(OMITTED_SUFFIX);
	}

	return lines.join("\n");
}

/** Fetches active facts and renders them — what `handlePostMessage` passes as `memoryBlock`. */
export async function getMemoryBlock(db: D1Database): Promise<string> {
	const facts = await listFacts(db, "active");
	return renderMemoryBlock(facts);
}
