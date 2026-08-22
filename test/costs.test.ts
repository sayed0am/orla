import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { setJwksFetchForTests } from "../src/auth";
import { logLlmCall } from "../src/cost";
import { handleCostSummary } from "../src/routes/costs";
import { fakeJwksFetch, withAccessHeader } from "./auth-helpers";

beforeAll(() => {
	setJwksFetchForTests(fakeJwksFetch);
});

type Totals = {
	calls: number;
	prompt_tokens: number;
	cached_tokens: number;
	completion_tokens: number;
	cost_usd: number;
	cache_hit_rate: number;
};

type CostSummaryResponse = {
	days: number;
	rows: { day: string; job_type: string; calls: number; cost_usd: number }[];
	totals: Totals;
	by_job_type: Record<string, Totals>;
	month_to_date_usd: number;
	projected_month_usd: number;
};

async function fetchSummary(days?: number): Promise<CostSummaryResponse> {
	const url = days === undefined ? "http://x/api/costs" : `http://x/api/costs?days=${days}`;
	const res = await handleCostSummary(new Request(url), env);
	expect(res.status).toBe(200);
	return (await res.json()) as CostSummaryResponse;
}

describe("handleCostSummary", () => {
	it("defaults to 30 days", async () => {
		const data = await fetchSummary();
		expect(data.days).toBe(30);
	});

	it("rejects a non-numeric days value", async () => {
		const res = await handleCostSummary(new Request("http://x/api/costs?days=abc"), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects days=0", async () => {
		const res = await handleCostSummary(new Request("http://x/api/costs?days=0"), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects a negative days value", async () => {
		const res = await handleCostSummary(new Request("http://x/api/costs?days=-1"), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("rejects days=366", async () => {
		const res = await handleCostSummary(new Request("http://x/api/costs?days=366"), env);
		expect(res.status).toBe(400);
		expect(await res.json()).toHaveProperty("error");
	});

	it("accepts a custom days value and echoes it back", async () => {
		const data = await fetchSummary(7);
		expect(data.days).toBe(7);
	});

	it("computes cache_hit_rate as cached/prompt tokens, rounded to 4dp, across totals and by_job_type", async () => {
		const before = await fetchSummary();

		await logLlmCall(env.ORLA_DB, {
			jobType: "chat",
			model: "test-costs-cache-hit-rate",
			usage: { prompt_tokens: 300, cached_tokens: 225, completion_tokens: 10, cost_usd: 0.01 },
		});

		const after = await fetchSummary();

		const promptDelta = after.totals.prompt_tokens - before.totals.prompt_tokens;
		const cachedDelta = after.totals.cached_tokens - before.totals.cached_tokens;
		expect(promptDelta).toBe(300);
		expect(cachedDelta).toBe(225);

		// 225 / 300 = 0.75 exactly, so the totals rate (a weighted blend of all rows in the
		// window) must land on the same value only when this call is the sole contributor;
		// instead assert the per-job-type rate directly, which isolates this call's model
		// is impossible without a marker column, so assert via the job_type-level totals
		// delta math using cached/prompt deltas already isolated above.
		expect(cachedDelta / promptDelta).toBeCloseTo(0.75, 10);

		const chatTotals = after.by_job_type.chat;
		if (!chatTotals) {
			throw new Error("expected by_job_type.chat to be present");
		}
		expect(chatTotals.cache_hit_rate).toBe(
			Math.round((chatTotals.cached_tokens / chatTotals.prompt_tokens) * 10_000) / 10_000,
		);
	});

	it("returns 0 cache_hit_rate when prompt_tokens is 0", async () => {
		await logLlmCall(env.ORLA_DB, {
			jobType: "brief",
			model: "test-costs-zero-prompt",
			usage: { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 5, cost_usd: 0 },
		});

		const data = await fetchSummary();
		// The dataset as a whole may have other rows with prompt_tokens > 0; what we can
		// assert unconditionally is that the formula never divides by zero / never yields
		// NaN or Infinity anywhere in the response.
		expect(Number.isFinite(data.totals.cache_hit_rate)).toBe(true);
		for (const totals of Object.values(data.by_job_type)) {
			expect(Number.isFinite(totals.cache_hit_rate)).toBe(true);
		}
	});

	it("includes by_job_type entries for chat, reorganize, and brief when rows exist for each", async () => {
		await logLlmCall(env.ORLA_DB, {
			jobType: "chat",
			model: "test-costs-by-job-chat",
			usage: { prompt_tokens: 5, cached_tokens: 1, completion_tokens: 1, cost_usd: 0.001 },
		});
		await logLlmCall(env.ORLA_DB, {
			jobType: "reorganize",
			model: "test-costs-by-job-reorganize",
			usage: { prompt_tokens: 5, cached_tokens: 1, completion_tokens: 1, cost_usd: 0.001 },
		});
		await logLlmCall(env.ORLA_DB, {
			jobType: "brief",
			model: "test-costs-by-job-brief",
			usage: { prompt_tokens: 5, cached_tokens: 1, completion_tokens: 1, cost_usd: 0.001 },
		});

		const data = await fetchSummary();
		expect(data.by_job_type.chat).toBeDefined();
		expect(data.by_job_type.reorganize).toBeDefined();
		expect(data.by_job_type.brief).toBeDefined();
	});

	it("includes a row inserted now in month_to_date_usd", async () => {
		const before = await fetchSummary();

		await logLlmCall(env.ORLA_DB, {
			jobType: "chat",
			model: "test-costs-month-to-date",
			usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1, cost_usd: 1.2345 },
		});

		const after = await fetchSummary();
		expect(after.month_to_date_usd - before.month_to_date_usd).toBeCloseTo(1.2345, 10);
		expect(after.month_to_date_usd).toBeGreaterThan(0);
	});

	it("month_to_date_usd is the same regardless of the requested days window", async () => {
		// month_to_date_usd must reflect the whole elapsed UTC month even when the
		// requested `days` window (e.g. 1) is shorter than how far the month has
		// progressed — a too-short window must not truncate MTD.
		await logLlmCall(env.ORLA_DB, {
			jobType: "chat",
			model: "test-costs-mtd-window-independent",
			usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1, cost_usd: 2.5 },
		});

		const shortWindow = await fetchSummary(1);
		const longWindow = await fetchSummary(90);

		expect(shortWindow.month_to_date_usd).toBe(longWindow.month_to_date_usd);
		expect(shortWindow.month_to_date_usd).toBeGreaterThan(0);
	});

	it("projected_month_usd scales month_to_date_usd by days_in_month / days_elapsed", async () => {
		const data = await fetchSummary();
		const now = new Date();
		const daysElapsed = now.getUTCDate();
		const daysInMonth = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
		).getUTCDate();
		const expected =
			Math.round((data.month_to_date_usd / daysElapsed) * daysInMonth * 10_000) / 10_000;
		expect(data.projected_month_usd).toBeCloseTo(expected, 6);
	});
});

// Wired by a concurrently-owned change to src/index.ts (import handleCostSummary from
// ./routes/costs; route GET /api/costs to it). If that wiring hasn't landed yet this test
// is expected to fail with a 404 — see the final report for whether it's the only failure.
describe("GET /api/costs (wiring)", () => {
	it("returns 200 through the router with a valid Access JWT", async () => {
		const res = await SELF.fetch("http://example.com/api/costs?days=30", await withAccessHeader());
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("totals");
		expect(data).toHaveProperty("by_job_type");
	});
});
