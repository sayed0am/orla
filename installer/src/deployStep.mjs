import { parseDeployUrl } from "./parse.mjs";

/** `npm ci` in the checkout. */
export async function npmCi(runner, { dir }) {
	const result = await runner.capture("npm", ["ci"], { cwd: dir });
	return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

/** `wrangler d1 migrations apply <name> --remote`. Piped stdio means `process.stdin.isTTY` is
 * false, which wrangler's own docs say skips the interactive confirmation prompt (still runs a
 * backup first) — see `wrangler d1 migrations apply --help`'s epilogue. */
export async function applyMigrations(runner, { dir, wranglerBin, workerName }) {
	const result = await runner.capture(
		wranglerBin.command,
		[...wranglerBin.args, "d1", "migrations", "apply", workerName, "--remote"],
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
