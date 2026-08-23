#!/usr/bin/env node
// Picks the cheapest ZDR (Zero Data Retention) OpenRouter endpoint that supports implicit/prompt
// caching for a given model (PRD §5), and prints the exact `wrangler.jsonc` "vars" line to pin it.
// No dependencies — mirrors scripts/vapid.mjs's Node-builtin-only style.
//
// Field names verified live against the OpenRouter API (2026-08):
//   GET https://openrouter.ai/api/v1/endpoints/zdr
//     -> { data: [{ model_id, provider_name, tag, context_length,
//                    pricing: { prompt, completion, ... },  // USD per token, as strings
//                    supports_implicit_caching, ... }] }
//   GET https://openrouter.ai/api/v1/providers
//     -> { data: [{ name, slug, ... }] }  // used to resolve a provider_name to the slug
//                                          // OpenRouter expects in a chat request's `provider.order`
// Docs: https://openrouter.ai/docs/api/api-reference/endpoints/preview-the-impact-of-zdr-on-the-available-endpoints
//       https://openrouter.ai/docs/features/provider-routing

const ZDR_ENDPOINTS_URL = "https://openrouter.ai/api/v1/endpoints/zdr";
const PROVIDERS_URL = "https://openrouter.ai/api/v1/providers";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731";

// Blended price weighting for ranking: interactive chat is prompt-heavy (long cached
// system/history prefix, short replies), so prompt price counts for more than completion price.
const PROMPT_WEIGHT = 0.8;
const COMPLETION_WEIGHT = 0.2;

function parseArgs(argv) {
	let model = DEFAULT_MODEL;
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") json = true;
		else model = arg;
	}
	return { model, json };
}

async function fetchJson(url, apiKey, label) {
	let response;
	try {
		response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
	} catch (err) {
		throw new Error(`network error calling ${label}: ${err instanceof Error ? err.message : err}`);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${label} failed with status ${response.status}: ${text}`);
	}
	return response.json();
}

function perMillion(pricePerToken) {
	// Round off float noise (e.g. 0.05 * 1e6 -> 49999.999999999996) without losing precision on
	// the tiny per-token prices this API returns.
	return Math.round(Number(pricePerToken) * 1_000_000 * 1e6) / 1e6;
}

function blendedPricePerToken(endpoint) {
	return (
		Number(endpoint.pricing.prompt) * PROMPT_WEIGHT +
		Number(endpoint.pricing.completion) * COMPLETION_WEIGHT
	);
}

/**
 * Resolves the provider slug OpenRouter expects in `provider.order`. Prefers an exact
 * `provider_name` match against `GET /api/v1/providers` (handles cases like tag
 * "sambanova-turbo" whose real slug is "sambanova"); falls back to the first `/`-segment of
 * `tag`, which matches the slug for the common case (e.g. "deepinfra/fp8" -> "deepinfra").
 */
function resolveProviderSlug(endpoint, providersByName) {
	const byName = providersByName.get(endpoint.provider_name.toLowerCase());
	if (byName) return byName;
	return endpoint.tag.split("/")[0];
}

function formatTable(rows) {
	const headers = ["provider", "prompt $/M", "completion $/M", "caching", "context"];
	const widths = headers.map((header, i) =>
		Math.max(header.length, ...rows.map((row) => String(row[i]).length)),
	);
	const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function toEndpointSummary(endpoint, slug) {
	return {
		provider: slug,
		provider_name: endpoint.provider_name,
		tag: endpoint.tag,
		prompt_per_million: perMillion(endpoint.pricing.prompt),
		completion_per_million: perMillion(endpoint.pricing.completion),
		supports_implicit_caching: endpoint.supports_implicit_caching,
		context_length: endpoint.context_length,
	};
}

async function main() {
	const { model, json } = parseArgs(process.argv.slice(2));

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.error(
			"OPENROUTER_API_KEY is not set in the environment. Export it before running this script " +
				"(it does not read .dev.vars) — e.g. `export OPENROUTER_API_KEY=sk-or-...`.",
		);
		process.exitCode = 1;
		return;
	}

	let allEndpoints;
	let providers;
	try {
		[allEndpoints, providers] = await Promise.all([
			fetchJson(ZDR_ENDPOINTS_URL, apiKey, "GET /api/v1/endpoints/zdr").then((payload) => {
				if (!Array.isArray(payload.data)) {
					throw new Error("unexpected response shape from /api/v1/endpoints/zdr: missing `data`");
				}
				return payload.data;
			}),
			fetchJson(PROVIDERS_URL, apiKey, "GET /api/v1/providers").then((payload) => {
				if (!Array.isArray(payload.data)) {
					throw new Error("unexpected response shape from /api/v1/providers: missing `data`");
				}
				return payload.data;
			}),
		]);
	} catch (err) {
		console.error(`Failed to fetch OpenRouter data: ${err instanceof Error ? err.message : err}`);
		process.exitCode = 1;
		return;
	}

	const providersByName = new Map(providers.map((p) => [String(p.name).toLowerCase(), p.slug]));

	const forModel = allEndpoints.filter((e) => e.model_id === model);
	if (forModel.length === 0) {
		console.error(`No ZDR endpoints found for model "${model}".`);
		process.exitCode = 1;
		return;
	}

	const cachingEndpoints = forModel.filter((e) => e.supports_implicit_caching === true);
	const usedFallback = cachingEndpoints.length === 0;
	const candidates = usedFallback ? forModel : cachingEndpoints;

	const sorted = [...candidates].sort((a, b) => blendedPricePerToken(a) - blendedPricePerToken(b));
	const best = sorted[0];
	const bestSlug = resolveProviderSlug(best, providersByName);

	if (json) {
		console.log(
			JSON.stringify(
				{
					model,
					used_caching_fallback: usedFallback,
					recommendation: toEndpointSummary(best, bestSlug),
					endpoints: sorted.map((e) =>
						toEndpointSummary(e, resolveProviderSlug(e, providersByName)),
					),
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(
		`ZDR endpoints for ${model}` +
			(usedFallback
				? " (none report supports_implicit_caching — showing all ZDR endpoints instead):\n"
				: " that support implicit/prompt caching:\n"),
	);

	const rows = sorted.map((e) => [
		e.provider_name,
		perMillion(e.pricing.prompt).toFixed(2),
		perMillion(e.pricing.completion).toFixed(2),
		e.supports_implicit_caching ? "yes" : "no",
		e.context_length,
	]);
	console.log(formatTable(rows));

	console.log(
		`\nRecommendation: ${best.provider_name} (${bestSlug}) — blended price ` +
			`${(blendedPricePerToken(best) * 1_000_000).toFixed(3)}/M tokens ` +
			`(weighted ${PROMPT_WEIGHT} prompt / ${COMPLETION_WEIGHT} completion — interactive chat is prompt-heavy).`,
	);
	if (usedFallback) {
		console.log(
			"Note: no ZDR endpoint for this model reports `supports_implicit_caching: true` — " +
				"fell back to ranking all ZDR endpoints for this model instead.",
		);
	}

	console.log('\nAdd to wrangler.jsonc "vars":');
	console.log(`  "LLM_PROVIDER": "${bestSlug}"`);
}

await main();
