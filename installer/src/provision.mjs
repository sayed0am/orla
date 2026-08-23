// Provisioning step: `wrangler d1 create`, then rewrite wrangler.jsonc in place. Side-effecting
// (spawns wrangler, writes a file) so it takes an injectable `runner`; the parsing and rewriting
// it calls into (parse.mjs, wranglerConfig.mjs) are the actually-unit-tested pure parts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseD1CreateOutput } from "./parse.mjs";
import { applyProvisioning } from "./wranglerConfig.mjs";

/**
 * Runs `wrangler d1 create <workerName>` and rewrites `<dir>/wrangler.jsonc` with the resulting
 * database_id plus the worker name, assistant name, VAPID subject, and VAPID public key.
 * `--update-config=false` stops wrangler's own (interactive-by-default) config-patching prompt —
 * see installer/src/parse.mjs's doc comment for how that flag was verified against wrangler's
 * source. Idempotent: re-running against a dir whose wrangler.jsonc already has this
 * database_id is safe (D1 database names are unique per account, so re-creating with the same
 * name fails loudly instead of silently drifting — the caller should catch that and treat it as
 * "already provisioned" via `--from secrets` instead of re-running this step).
 */
export async function provision(
	runner,
	{ dir, wranglerBin, workerName, assistantName, vapidSubject, vapidPublicKey },
) {
	const result = await runner.capture(wranglerBin.command, [
		...wranglerBin.args,
		"d1",
		"create",
		workerName,
		"--update-config=false",
	]);
	if (result.code !== 0) {
		return { ok: false, stderr: result.stderr, stdout: result.stdout };
	}

	const { databaseId } = parseD1CreateOutput(result.stdout);

	const configPath = join(dir, "wrangler.jsonc");
	const before = readFileSync(configPath, "utf8");
	const after = applyProvisioning(before, {
		workerName,
		databaseId,
		assistantName,
		vapidSubject,
		vapidPublicKey,
	});
	writeFileSync(configPath, after);

	return { ok: true, databaseId };
}
