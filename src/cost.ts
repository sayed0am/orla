/** Cost log for `llm_calls` — drives F6 dashboard and the G4 cache-hit metric (PLAN step 6). */

import type { LlmConfig, Usage } from "./llm";

type CostSummaryRow = {
	day: string;
	job_type: string;
	calls: number;
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number;
};

export async function logLlmCall(
	db: D1Database,
	entry: { jobType: LlmConfig["jobType"]; model: string; usage: Usage },
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO llm_calls (id, job_type, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			entry.jobType,
			entry.model,
			entry.usage.prompt_tokens,
			entry.usage.cached_tokens,
			entry.usage.completion_tokens,
			entry.usage.cost_usd,
		)
		.run();
}

export async function costSummary(
	db: D1Database,
	opts: { days: number },
): Promise<CostSummaryRow[]> {
	const result = await db
		.prepare(
			`SELECT
				date(created_at) AS day,
				job_type,
				COUNT(*) AS calls,
				SUM(prompt_tokens) AS prompt_tokens,
				SUM(cached_tokens) AS cached_tokens,
				SUM(completion_tokens) AS completion_tokens,
				SUM(COALESCE(cost_usd, 0)) AS cost_usd
			FROM llm_calls
			WHERE created_at >= datetime('now', ?)
			GROUP BY day, job_type
			ORDER BY day DESC, job_type ASC`,
		)
		.bind(`-${opts.days} days`)
		.all<CostSummaryRow>();

	return result.results;
}
