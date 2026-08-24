// Builds the ordered list of shell commands the installer would run, without running any of
// them. Used for `--dry-run` and unit-tested directly so the plan's shape is covered without
// spawning a process.

import { D1_BINDING } from "./deployStep.mjs";
import { STEP_ORDER } from "./steps.mjs";

/**
 * @param {object} opts
 * @param {string} opts.wranglerVersion - exact pinned version, e.g. "4.125.0"
 * @param {string} [opts.ref] - git ref to clone (default "main")
 * @param {string} [opts.dir] - clone directory (default "orla")
 * @param {string} [opts.workerName] - Worker / D1 database name (default "orla")
 * @param {boolean} [opts.pinZdr] - whether the optional ZDR-pin step is included
 * @returns {{ step: string, commands: string[] }[]} one entry per step in STEP_ORDER
 */
export function buildPlan({
	wranglerVersion,
	ref = "main",
	dir = "orla",
	workerName = "orla",
	pinZdr = false,
} = {}) {
	if (!wranglerVersion) {
		throw new Error("buildPlan: wranglerVersion is required");
	}
	const wrangler = `npx --yes wrangler@${wranglerVersion}`;

	const commandsByStep = {
		preflight: ["node --version", "git --version", `${wrangler} whoami --json`],
		clone: [`git clone --depth 1 --branch ${ref} <orla-repo-url> ${dir}`],
		prompts: [
			"prompt: assistant name (default Orla)",
			`prompt: Worker name (default ${workerName})`,
			"prompt: OpenRouter API key (masked; validated against GET https://openrouter.ai/api/v1/auth/key)",
			"prompt: VAPID subject email (default from `git config user.email`)",
		],
		provision: [
			`${wrangler} d1 create ${workerName} --update-config=false`,
			"edit wrangler.jsonc: name, database_id, database_name, ASSISTANT_NAME, VAPID_SUBJECT, VAPID_PUBLIC_KEY",
		],
		secrets: [
			`echo <OPENROUTER_API_KEY> | ${wrangler} secret put OPENROUTER_API_KEY --name ${workerName}`,
			`echo <VAPID_PRIVATE_KEY> | ${wrangler} secret put VAPID_PRIVATE_KEY --name ${workerName}`,
			`echo <SESSION_SECRET> | ${wrangler} secret put SESSION_SECRET --name ${workerName}`,
		],
		install: ["npm ci"],
		build: ["npm run build"],
		// Resolved by the stable D1 binding, not the Worker/database name — see deployStep.mjs's
		// D1_BINDING doc comment.
		migrate: [`${wrangler} d1 migrations apply ${D1_BINDING} --remote`],
		deploy: [`${wrangler} deploy`],
		"zdr-pin": pinZdr
			? ["node scripts/zdr-pin.mjs --json", `${wrangler} deploy`]
			: ["(skipped — not requested)"],
		done: ["print done screen with deployed URL and next steps"],
	};

	return STEP_ORDER.map((step) => ({ step, commands: commandsByStep[step] }));
}

/** Flattens a plan into the printable transcript lines shown for `--dry-run`. */
export function formatPlan(plan) {
	const lines = [];
	for (const { step, commands } of plan) {
		lines.push(`# ${step}`);
		for (const command of commands) {
			lines.push(`  $ ${command}`);
		}
	}
	return lines.join("\n");
}
