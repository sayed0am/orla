/**
 * F4 — morning brief (PRD F4, §7 Reliability). Assembles a deterministic Markdown summary from
 * data the nightly pass (F3) has already produced — no LLM call in v1. The PRD says the brief
 * "assembles" today's items, yesterday's summary, and reminders; since F3 already distills raw
 * notes into structured, summarized rows, a template read of that structure is enough. An LLM
 * narrative pass over the same inputs is a Phase-3 option, not a v1 requirement.
 */

import { broadcast, type VapidConfig } from "./push";
import { consecutiveFailedRuns } from "./reorganize";

const UNDATED_ITEM_LIMIT = 10;
const PUSH_BODY_MAX_LENGTH = 120;

export type BriefActionItem = {
	id: string;
	text: string;
	due_date: string | null;
	overdue: boolean;
};

export type BriefYesterdayNote = {
	id: string;
	type: string;
	summary: string;
	tags: string[];
};

export type BriefReorgRun = {
	id: string;
	started_at: string;
	finished_at: string | null;
	status: string;
	notes_in: number;
	notes_ok: number;
	notes_failed: number;
	error: string | null;
};

export type BriefInputs = {
	for_date: string;
	today_items: BriefActionItem[];
	undated_items: BriefActionItem[];
	yesterday: BriefYesterdayNote[];
	reorg_health: { last_run: BriefReorgRun | null; consecutive_failures: number };
	pending_raw: number;
};

type ActionItemRow = {
	id: string;
	text: string;
	due_date: string | null;
};

/**
 * Gathers everything the brief renders from, for the UTC calendar day `forDate` (YYYY-MM-DD).
 * `today_items` includes overdue items (due_date <= forDate), flagged individually; `yesterday`
 * is organized notes whose *raw* note was captured on forDate-1, joined through raw_notes since
 * organized_notes itself carries no capture timestamp of its own.
 */
export async function buildBriefInputs(db: D1Database, forDate: string): Promise<BriefInputs> {
	const todayRows = await db
		.prepare(
			`SELECT id, text, due_date FROM action_items
			 WHERE status = 'open' AND due_date IS NOT NULL AND due_date <= ?
			 ORDER BY due_date ASC`,
		)
		.bind(forDate)
		.all<ActionItemRow>();
	const todayItems: BriefActionItem[] = todayRows.results.map((row) => ({
		id: row.id,
		text: row.text,
		due_date: row.due_date,
		overdue: row.due_date !== null && row.due_date < forDate,
	}));

	const undatedRows = await db
		.prepare(
			`SELECT id, text, due_date FROM action_items
			 WHERE status = 'open' AND due_date IS NULL
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(UNDATED_ITEM_LIMIT)
		.all<ActionItemRow>();
	const undatedItems: BriefActionItem[] = undatedRows.results.map((row) => ({
		id: row.id,
		text: row.text,
		due_date: row.due_date,
		overdue: false,
	}));

	const yesterdayRows = await db
		.prepare(
			`SELECT o.id AS id, o.type AS type, o.summary AS summary, o.tags AS tags
			 FROM organized_notes o
			 JOIN raw_notes r ON r.id = o.raw_note_id
			 WHERE date(r.created_at) = date(?, '-1 day')
			 ORDER BY o.created_at ASC`,
		)
		.bind(forDate)
		.all<{ id: string; type: string; summary: string; tags: string }>();
	const yesterday: BriefYesterdayNote[] = yesterdayRows.results.map((row) => ({
		id: row.id,
		type: row.type,
		summary: row.summary,
		tags: JSON.parse(row.tags) as string[],
	}));

	const lastRun = await db
		.prepare(
			`SELECT id, started_at, finished_at, status, notes_in, notes_ok, notes_failed, error
			 FROM reorg_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`,
		)
		.first<BriefReorgRun>();
	const consecutiveFailures = await consecutiveFailedRuns(db);

	const pendingRow = await db
		.prepare("SELECT COUNT(*) AS n FROM raw_notes WHERE processed_at IS NULL AND private = 0")
		.first<{ n: number }>();

	return {
		for_date: forDate,
		today_items: todayItems,
		undated_items: undatedItems,
		yesterday,
		reorg_health: { last_run: lastRun ?? null, consecutive_failures: consecutiveFailures },
		pending_raw: pendingRow?.n ?? 0,
	};
}

function renderActionItem(item: BriefActionItem): string {
	const marker = item.overdue ? "⚠ " : "";
	const due = item.due_date ? ` (due ${item.due_date})` : "";
	return `- ${marker}${item.text}${due}`;
}

function renderYesterdayNote(note: BriefYesterdayNote): string {
	const tags = note.tags.length > 0 ? ` · ${note.tags.map((t) => `#${t}`).join(" ")}` : "";
	return `- ${note.type} · ${note.summary}${tags}`;
}

/**
 * Renders the deterministic brief template. No dates or randomness beyond `inputs.for_date` and
 * `assistantName` — same inputs always render the same Markdown.
 */
export function renderBriefMarkdown(inputs: BriefInputs, assistantName: string): string {
	const lines: string[] = [];

	lines.push(`# Morning brief — ${inputs.for_date}`);
	lines.push("");
	lines.push(`_Prepared by ${assistantName}._`);
	lines.push("");

	lines.push("## Today");
	if (inputs.today_items.length === 0) {
		lines.push("Nothing due today.");
	} else {
		for (const item of inputs.today_items) {
			lines.push(renderActionItem(item));
		}
	}
	lines.push("");

	lines.push("## Also on your list");
	if (inputs.undated_items.length === 0) {
		lines.push("Nothing else on your list.");
	} else {
		for (const item of inputs.undated_items) {
			lines.push(renderActionItem(item));
		}
	}
	lines.push("");

	lines.push("## Yesterday");
	if (inputs.yesterday.length === 0) {
		lines.push("No notes from yesterday.");
	} else {
		for (const note of inputs.yesterday) {
			lines.push(renderYesterdayNote(note));
		}
	}

	const systemLines: string[] = [];
	if (inputs.reorg_health.consecutive_failures >= 1) {
		systemLines.push(
			`- ⚠ Nightly reorganization has failed ${inputs.reorg_health.consecutive_failures} time(s) in a row.`,
		);
	}
	if (inputs.pending_raw > 0) {
		systemLines.push(`- ${inputs.pending_raw} note(s) are still waiting to be processed.`);
	}
	if (systemLines.length > 0) {
		lines.push("");
		lines.push("## System");
		lines.push(...systemLines);
	}

	return lines.join("\n");
}

// Test-only hook, mirroring `setReorgFetchForTests` in src/reorganize.ts: RPC/route wiring can't
// carry a function through `opts`, so SELF-based route tests install a fake fetch here instead.
let testBriefFetch: typeof fetch | undefined;

/** Test-only: install (or clear, with `undefined`) a fake push fetch used by `runMorningBrief`. */
export function setBriefFetchForTests(f: typeof fetch | undefined): void {
	testBriefFetch = f;
}

export type RunMorningBriefResult = {
	briefId: string;
	forDate: string;
	pushed: number;
	failed: number;
};

/**
 * Builds and stores today's brief (idempotent per `for_date` — re-running the same day updates
 * the existing row rather than duplicating it), then pushes it if VAPID keys are configured. A
 * second, separate push warns the user when the nightly reorganization has failed repeatedly
 * (PRD §7 Reliability) so a stuck cron doesn't fail silently.
 */
export async function runMorningBrief(
	env: Env,
	opts?: { now?: Date; fetchImpl?: typeof fetch },
): Promise<RunMorningBriefResult> {
	const db = env.ORLA_DB;
	const now = opts?.now ?? new Date();
	const forDate = now.toISOString().slice(0, 10);
	const fetchImpl = opts?.fetchImpl ?? testBriefFetch ?? fetch;

	const inputs = await buildBriefInputs(db, forDate);
	const bodyMd = renderBriefMarkdown(inputs, env.ASSISTANT_NAME);
	const dataJson = JSON.stringify(inputs);
	const newId = crypto.randomUUID();

	await db
		.prepare(
			`INSERT INTO briefs (id, for_date, body_md, data)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(for_date) DO UPDATE SET body_md = excluded.body_md, data = excluded.data`,
		)
		.bind(newId, forDate, bodyMd, dataJson)
		.run();

	const briefRow = await db
		.prepare("SELECT id FROM briefs WHERE for_date = ?")
		.bind(forDate)
		.first<{ id: string }>();
	const briefId = briefRow?.id ?? newId;

	let pushed = 0;
	let failed = 0;

	if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
		const vapid: VapidConfig = {
			publicKey: env.VAPID_PUBLIC_KEY,
			privateKey: env.VAPID_PRIVATE_KEY,
			subject: env.VAPID_SUBJECT,
		};

		const todayCount = inputs.today_items.length;
		const overdueCount = inputs.today_items.filter((item) => item.overdue).length;
		const briefPayload = JSON.stringify({
			title: "Good morning",
			body: `${todayCount} due today, ${overdueCount} overdue`.slice(0, PUSH_BODY_MAX_LENGTH),
			url: "/#brief",
			tag: "brief",
		});

		const briefPush = await broadcast(db, briefPayload, vapid, fetchImpl);
		pushed += briefPush.sent;
		failed += briefPush.failed;

		if (inputs.reorg_health.consecutive_failures >= 2) {
			const alertPayload = JSON.stringify({
				title: "Orla needs attention",
				body: `Nightly reorganization has failed ${inputs.reorg_health.consecutive_failures} times`,
				url: "/#costs",
				tag: "system",
			});
			const alertPush = await broadcast(db, alertPayload, vapid, fetchImpl);
			pushed += alertPush.sent;
			failed += alertPush.failed;
		}

		await db
			.prepare("UPDATE briefs SET pushed_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), briefId)
			.run();
	}

	return { briefId, forDate, pushed, failed };
}
