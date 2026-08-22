/** HTTP handler for F6 cost & cache dashboard — tuning instrument for G4 and §10 cache-hit rate. */

import { costSummary } from "../cost";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

type Totals = {
	calls: number;
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number;
	cache_hit_rate: number;
};

function emptyTotals(): Totals {
	return {
		calls: 0,
		prompt_tokens: 0,
		cached_tokens: 0,
		completion_tokens: 0,
		cost_usd: 0,
		cache_hit_rate: 0,
	};
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function cacheHitRate(cachedTokens: number, promptTokens: number): number {
	return promptTokens === 0 ? 0 : round4(cachedTokens / promptTokens);
}

function parseDays(request: Request): number | Response {
	const url = new URL(request.url);
	const raw = url.searchParams.get("days");
	if (raw === null) {
		return DEFAULT_DAYS;
	}
	const days = Number(raw);
	if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
		return Response.json(
			{ error: `days must be an integer between ${MIN_DAYS} and ${MAX_DAYS}` },
			{ status: 400 },
		);
	}
	return days;
}

function sumCostUsd(rows: { day: string; cost_usd: number }[], monthPrefix: string): number {
	let total = 0;
	for (const row of rows) {
		if (row.day.startsWith(monthPrefix)) {
			total += row.cost_usd;
		}
	}
	return total;
}

export async function handleCostSummary(request: Request, env: Env): Promise<Response> {
	const days = parseDays(request);
	if (days instanceof Response) {
		return days;
	}

	const rows = await costSummary(env.ORLA_DB, { days });

	const totals = emptyTotals();
	const byJobType: Record<string, Totals> = {};

	for (const row of rows) {
		totals.calls += row.calls;
		totals.prompt_tokens += row.prompt_tokens;
		totals.cached_tokens += row.cached_tokens;
		totals.completion_tokens += row.completion_tokens;
		totals.cost_usd += row.cost_usd;

		const jobTotals = byJobType[row.job_type] ?? emptyTotals();
		jobTotals.calls += row.calls;
		jobTotals.prompt_tokens += row.prompt_tokens;
		jobTotals.cached_tokens += row.cached_tokens;
		jobTotals.completion_tokens += row.completion_tokens;
		jobTotals.cost_usd += row.cost_usd;
		byJobType[row.job_type] = jobTotals;
	}

	totals.cost_usd = round4(totals.cost_usd);
	totals.cache_hit_rate = cacheHitRate(totals.cached_tokens, totals.prompt_tokens);
	for (const jobTotals of Object.values(byJobType)) {
		jobTotals.cost_usd = round4(jobTotals.cost_usd);
		jobTotals.cache_hit_rate = cacheHitRate(jobTotals.cached_tokens, jobTotals.prompt_tokens);
	}

	const now = new Date();
	const monthPrefix = now.toISOString().slice(0, 7); // "YYYY-MM"
	const daysElapsed = now.getUTCDate();
	const daysInMonth = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
	).getUTCDate();

	// The requested `days` window may be shorter than how far the current UTC month has
	// progressed (e.g. days=7 on the 20th), in which case it can't be used to compute
	// month-to-date spend — fetch a window that covers the whole elapsed month instead.
	// When the requested window already covers it, reuse it rather than double-querying.
	const mtdRows = days < daysElapsed ? await costSummary(env.ORLA_DB, { days: daysElapsed }) : rows;

	const monthToDateUsd = round4(sumCostUsd(mtdRows, monthPrefix));
	const projectedMonthUsd = round4((monthToDateUsd / daysElapsed) * daysInMonth);

	return Response.json({
		days,
		rows,
		totals,
		by_job_type: byJobType,
		month_to_date_usd: monthToDateUsd,
		projected_month_usd: projectedMonthUsd,
	});
}
