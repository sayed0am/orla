// Clone-or-reuse logic for the target checkout directory. The directory-inspection half
// (`isExistingOrlaCheckout`) is pure filesystem reads and is unit-tested directly; the actual
// `git clone` call goes through the injectable runner like every other side-effecting step.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeOrlaCheckout } from "./wranglerConfig.mjs";

export const ORLA_REPO_URL = "https://github.com/sayed0am/orla.git";

/** True if `dir` already holds an Orla checkout (has a wrangler.jsonc naming the Worker "orla"),
 * so re-running the installer can `git pull` it instead of cloning fresh into a new directory. */
export function isExistingOrlaCheckout(dir) {
	const configPath = join(dir, "wrangler.jsonc");
	if (!existsSync(configPath)) return false;
	try {
		return looksLikeOrlaCheckout(readFileSync(configPath, "utf8"));
	} catch {
		return false;
	}
}

/** Clones (or, if `dir` is already an Orla checkout, pulls) the repo. Returns the runner's
 * `capture` result for the git command that ran. */
export async function cloneOrReuse(runner, { ref, dir }) {
	if (isExistingOrlaCheckout(dir)) {
		return runner.capture("git", ["-C", dir, "pull", "--ff-only", "origin", ref]);
	}
	return runner.capture("git", ["clone", "--depth", "1", "--branch", ref, ORLA_REPO_URL, dir]);
}
