import { parseDeployUrl } from "./parse.mjs";

/** The D1 binding name in wrangler.jsonc — `applyProvisioning` (wranglerConfig.mjs) never
 * rewrites `binding`, so this stays constant across every install regardless of Worker/database
 * name. `wrangler d1 migrations apply <database>` accepts "the name or binding of the DB" (its
 * own `--help` text) — using the binding here instead of the Worker/database name means this
 * step still resolves correctly even if `database_name` in config and the real D1 database name
 * were ever to drift apart again. */
export const D1_BINDING = "ORLA_DB";

/** `npm ci` in the checkout. */
export async function npmCi(runner, { dir }) {
	const result = await runner.capture("npm", ["ci"], { cwd: dir });
	return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

/** `wrangler d1 migrations apply <binding> --remote`. Piped stdio means `process.stdin.isTTY` is
 * false, which wrangler's own docs say skips the interactive confirmation prompt (still runs a
 * backup first) — see `wrangler d1 migrations apply --help`'s epilogue. Resolves the database by
 * the stable `D1_BINDING`, not by Worker/database name (see that constant's doc comment). */
export async function applyMigrations(runner, { dir, wranglerBin }) {
	const result = await runner.capture(
		wranglerBin.command,
		[...wranglerBin.args, "d1", "migrations", "apply", D1_BINDING, "--remote"],
		{ cwd: dir },
	);
	return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

/** `wrangler deploy`; returns the parsed deployed URL on success. */
export async function deploy(runner, { dir, wranglerBin }) {
	const result = await runner.capture(wranglerBin.command, [...wranglerBin.args, "deploy"], {
		cwd: dir,
	});
	if (result.code !== 0) {
		return { ok: false, stdout: result.stdout, stderr: result.stderr };
	}
	const url = parseDeployUrl(result.stdout);
	return { ok: true, url, stdout: result.stdout };
}
