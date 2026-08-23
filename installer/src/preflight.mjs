import { parseWhoami } from "./parse.mjs";

export const MIN_NODE_MAJOR = 20;

/** Checks the running Node's major version against MIN_NODE_MAJOR. Pure — takes the version
 * string instead of reading `process.version` itself, so it's directly testable. */
export function checkNodeVersion(versionString = process.version) {
	const match = versionString.match(/^v(\d+)\./);
	const major = match ? Number(match[1]) : Number.NaN;
	return { ok: major >= MIN_NODE_MAJOR, major };
}

/** `git --version` — just needs to succeed. */
export async function checkGitPresent(runner) {
	const result = await runner.capture("git", ["--version"]);
	return { ok: result.code === 0 };
}

/** `wrangler whoami --json`. A non-zero exit or unparseable stdout means "not logged in" —
 * wrangler's own `whoami --json` throws instead of printing `loggedIn: false` on that path (see
 * installer/src/parse.mjs's doc comment), so both cases are folded into the same result shape
 * here rather than the caller needing to know that distinction. */
export async function checkCloudflareLogin(runner, wranglerBin) {
	const result = await runner.capture(wranglerBin.command, [
		...wranglerBin.args,
		"whoami",
		"--json",
	]);
	if (result.code !== 0) {
		return { loggedIn: false, email: null, accounts: [] };
	}
	try {
		return parseWhoami(result.stdout);
	} catch {
		return { loggedIn: false, email: null, accounts: [] };
	}
}

/** `wrangler login` — opens a browser; stdio is inherited so the user sees wrangler's own
 * prompts/output for this one interactive step. */
export async function login(runner, wranglerBin) {
	const result = await runner.interactive(wranglerBin.command, [...wranglerBin.args, "login"]);
	return { ok: result.code === 0 };
}
