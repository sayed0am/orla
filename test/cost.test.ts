import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { costSummary, logLlmCall } from "../src/cost";
import type { Usage } from "../src/llm";

type LlmCallRow = {
	id: string;
	created_at: string;
	job_type: string;
	model: string;
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number | null;
};

describe("logLlmCall", () => {
	it("inserts a row that can be queried back", async () => {
		const usage: Usage = {
			prompt_tokens: 100,
			cached_tokens: 20,
			completion_tokens: 30,
			cost_usd: 0.001,
		};

		await logLlmCall(env.ORLA_DB, { jobType: "chat", model: "test-model-insert", usage });

		const row = await env.ORLA_DB.prepare("SELECT * FROM llm_calls WHERE model = ?")
			.bind("test-model-insert")
			.first<LlmCallRow>();

		expect(row).toMatchObject({
			job_type: "chat",
			model: "test-model-insert",
			prompt_tokens: 100,
			cached_tokens: 20,
			completion_tokens: 30,
			cost_usd: 0.001,
		});
		expect(typeof row?.id).toBe("string");
		expect(typeof row?.created_at).toBe("string");
	});

	it("stores a null cost_usd as null", async () => {
		const usage: Usage = {
			prompt_tokens: 5,
			cached_tokens: 0,
			completion_tokens: 1,
			cost_usd: null,
		};

		await logLlmCall(env.ORLA_DB, { jobType: "brief", model: "test-model-null-cost", usage });

		const row = await env.ORLA_DB.prepare("SELECT cost_usd FROM llm_calls WHERE model = ?")
			.bind("test-model-null-cost")
			.first<{ cost_usd: number | null }>();

		expect(row?.cost_usd).toBeNull();
	});
});

describe("costSummary", () => {
	it("aggregates two calls of the same job_type into one row with summed tokens", async () => {
		// Other test files also log job_type "reorganize" rows on the same UTC day (shared D1
		// across the whole run per vitest.config.ts), so assert deltas rather than absolute
		// totals — everything still lands in exactly one (day, job_type) row since it's all
		// logged today.
		const before = await costSummary(env.ORLA_DB, { days: 7 });
		const baseline = before.find((row) => row.job_type === "reorganize");

		await logLlmCall(env.ORLA_DB, {
			jobType: "reorganize",
			model: "test-model-agg",
			usage: { prompt_tokens: 10, cached_tokens: 2, completion_tokens: 5, cost_usd: 0.01 },
		});
		await logLlmCall(env.ORLA_DB, {
			jobType: "reorganize",
			model: "test-model-agg",
			usage: { prompt_tokens: 20, cached_tokens: 3, completion_tokens: 7, cost_usd: 0.02 },
		});

		const summary = await costSummary(env.ORLA_DB, { days: 7 });
		const reorganizeRows = summary.filter((row) => row.job_type === "reorganize");

		expect(reorganizeRows).toHaveLength(1);
		const row = reorganizeRows[0];
		expect(row).toBeDefined();
		if (!row) return;
		expect(row.calls - (baseline?.calls ?? 0)).toBe(2);
		expect(row.prompt_tokens - (baseline?.prompt_tokens ?? 0)).toBe(30);
		expect(row.cached_tokens - (baseline?.cached_tokens ?? 0)).toBe(5);
		expect(row.completion_tokens - (baseline?.completion_tokens ?? 0)).toBe(12);
		expect(row.cost_usd - (baseline?.cost_usd ?? 0)).toBeCloseTo(0.03, 10);
		expect(typeof row.day).toBe("string");
	});

	it("keeps distinct job_types in separate rows", async () => {
		await logLlmCall(env.ORLA_DB, {
			jobType: "chat",
			model: "test-model-distinct",
			usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1, cost_usd: 0.0001 },
		});
		await logLlmCall(env.ORLA_DB, {
			jobType: "brief",
			model: "test-model-distinct",
			usage: { prompt_tokens: 2, cached_tokens: 0, completion_tokens: 2, cost_usd: 0.0002 },
		});

		const summary = await costSummary(env.ORLA_DB, { days: 7 });
		const relevant = summary.filter((row) => row.job_type === "chat" || row.job_type === "brief");
		const jobTypes = new Set(relevant.map((row) => row.job_type));
		expect(jobTypes.has("chat")).toBe(true);
		expect(jobTypes.has("brief")).toBe(true);
	});
});
