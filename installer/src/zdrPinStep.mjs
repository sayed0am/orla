// Optional step: run the cloned repo's own scripts/zdr-pin.mjs --json, write the recommended
// provider slug into wrangler.jsonc, and redeploy.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyProvisioning } from "./wranglerConfig.mjs";

export async function pinZdrProvider(runner, { dir, openRouterApiKey }) {
	const result = await runner.capture("node", ["scripts/zdr-pin.mjs", "--json"], {
		cwd: dir,
		env: { ...process.env, OPENROUTER_API_KEY: openRouterApiKey },
	});
	if (result.code !== 0) {
		return { ok: false, stderr: result.stderr };
	}

	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { ok: false, stderr: "zdr-pin.mjs --json produced unparseable output" };
	}
	const slug = parsed?.recommendation?.provider;
	if (!slug) {
		return { ok: false, stderr: "zdr-pin.mjs --json output missing recommendation.provider" };
	}

	const configPath = join(dir, "wrangler.jsonc");
	const before = readFileSync(configPath, "utf8");
	writeFileSync(configPath, applyProvisioning(before, { llmProvider: slug }));

	return { ok: true, provider: slug };
}
