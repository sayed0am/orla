#!/usr/bin/env node
// create-orla — F8 one-line installer (personal-assistant-prd.md F8/G7). Provisions Orla into
// the caller's own Cloudflare + OpenRouter accounts via `npx wrangler@<pinned>`; never bundles
// or hosts the app itself. Zero runtime dependencies — see installer/package.json.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HELP_TEXT, parseArgs } from "../src/cliArgs.mjs";
import { cloneOrReuse } from "../src/clone.mjs";
import { applyMigrations, deploy, npmCi } from "../src/deployStep.mjs";
import { buildDoneScreen } from "../src/doneScreen.mjs";
import {
	printChecklistHeader,
	printError,
	printStepDone,
	printStepFailed,
	printStepStart,
} from "../src/log.mjs";
import { validateOpenRouterKey, ZDR_REMINDER } from "../src/openrouter.mjs";
import { buildPlan, formatPlan } from "../src/plan.mjs";
import {
	checkCloudflareLogin,
	checkGitPresent,
	checkNodeVersion,
	login,
} from "../src/preflight.mjs";
import { createPromptInterface, promptMasked, promptText } from "../src/prompts.mjs";
import { provision } from "../src/provision.mjs";
import { createRealRunner } from "../src/run.mjs";
import { generateSessionSecret } from "../src/secrets.mjs";
import { putSecrets } from "../src/secretsStep.mjs";
import { stepsToRun } from "../src/steps.mjs";
import { generateVapidKeys } from "../src/vapid.mjs";
import { WRANGLER_VERSION } from "../src/wranglerVersion.mjs";
import { pinZdrProvider } from "../src/zdrPinStep.mjs";

const wranglerBin = { command: "npx", args: ["--yes", `wrangler@${WRANGLER_VERSION}`] };

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		printError(err.message);
		process.exit(1);
		return;
	}

	if (options.help) {
		console.log(HELP_TEXT);
		return;
	}

	const dir = options.dir ?? "orla";

	if (options.dryRun) {
		const plan = buildPlan({
			wranglerVersion: WRANGLER_VERSION,
			ref: options.ref,
			dir,
			workerName: options.workerName ?? "orla",
		});
		console.log(formatPlan(plan));
		console.log("\n(--dry-run: nothing above was executed)");
		return;
	}

	const steps = new Set(stepsToRun(options.from));
	const runner = createRealRunner();
	printChecklistHeader();

	// --- preflight ---------------------------------------------------------
	if (steps.has("preflight")) {
		printStepStart("preflight");
		const node = checkNodeVersion();
		if (!node.ok) {
			printStepFailed("preflight", `Node ${node.major || "?"} found; Node 20+ is required.`);
			process.exit(1);
		}
		const git = await checkGitPresent(runner);
		if (!git.ok) {
			printStepFailed("preflight", "git was not found on PATH.");
			process.exit(1);
		}
		let whoami = await checkCloudflareLogin(runner, wranglerBin);
		if (!whoami.loggedIn) {
			console.log("Not logged in to Cloudflare — opening `wrangler login`...");
			await login(runner, wranglerBin);
			whoami = await checkCloudflareLogin(runner, wranglerBin);
			if (!whoami.loggedIn) {
				printStepFailed("preflight", "Cloudflare login did not complete.");
				process.exit(1);
			}
		}
		console.log(`Logged in as ${whoami.email ?? "(unknown email)"}.`);
		if (whoami.accounts.length > 1 && !options.yes) {
			const rl = createPromptInterface();
			console.log("Multiple Cloudflare accounts found:");
			for (const account of whoami.accounts) console.log(`  - ${account.name} (${account.id})`);
			await promptText(rl, "Press enter to continue with the default account shown by wrangler");
			rl.close();
		}
		printStepDone("preflight");
	}

	// --- clone ---------------------------------------------------------------
	if (steps.has("clone")) {
		printStepStart("clone");
		const result = await cloneOrReuse(runner, { ref: options.ref, dir });
		if (result.code !== 0) {
			printStepFailed("clone", result.stderr);
			process.exit(1);
		}
		printStepDone("clone");
	}

	if (!existsSync(join(dir, "wrangler.jsonc"))) {
		printError(
			`${dir} does not look like an Orla checkout (no wrangler.jsonc). Run without ` +
				"--from, or pass --dir pointing at an existing checkout.",
		);
		process.exit(1);
	}

	// --- prompts (config is always resolved, even on --from resume; only the earlier
	// side-effecting steps above are skippable) -------------------------------------------------
	printStepStart("prompts");
	const rl = options.yes ? null : createPromptInterface();
	const assistantName =
		options.assistantName ??
		(options.yes ? "Orla" : await promptText(rl, "Assistant name", "Orla"));
	const workerName =
		options.workerName ?? (options.yes ? "orla" : await promptText(rl, "Worker name", "orla"));

	let openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey && !options.yes) {
		while (!openRouterApiKey) {
			const candidate = await promptMasked(rl, "OpenRouter API key");
			const validation = await validateOpenRouterKey(candidate);
			if (validation.ok) {
				openRouterApiKey = candidate;
			} else {
				console.log(`  ${validation.reason} — try again.`);
			}
		}
	}
	if (!openRouterApiKey) {
		printStepFailed(
			"prompts",
			"OPENROUTER_API_KEY is required with --yes (set the environment variable, or drop --yes).",
		);
		process.exit(1);
	}
	console.log(ZDR_REMINDER);

	let vapidSubjectDefault = "you@example.com";
	try {
		vapidSubjectDefault =
			execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim() ||
			vapidSubjectDefault;
	} catch {
		// no git email configured — keep the placeholder default
	}
	const vapidSubjectInput = options.yes
		? vapidSubjectDefault
		: await promptText(rl, "VAPID subject email", vapidSubjectDefault);
	const vapidSubject = `mailto:${vapidSubjectInput.replace(/^mailto:/, "")}`;

	if (rl) rl.close();
	printStepDone("prompts");

	// --- provision -------------------------------------------------------------------------
	const vapidKeys = await generateVapidKeys();
	if (steps.has("provision")) {
		printStepStart("provision");
		const result = await provision(runner, {
			dir,
			wranglerBin,
			workerName,
			assistantName,
			vapidSubject,
			vapidPublicKey: vapidKeys.publicKey,
		});
		if (!result.ok) {
			printStepFailed("provision", result.stderr);
			process.exit(1);
		}
		console.log(`D1 database ready (id ${result.databaseId}).`);
		printStepDone("provision");
	}

	// --- secrets ---------------------------------------------------------------------------
	if (steps.has("secrets")) {
		printStepStart("secrets");
		const sessionSecret = generateSessionSecret();
		const result = await putSecrets(runner, {
			wranglerBin,
			workerName,
			values: {
				OPENROUTER_API_KEY: openRouterApiKey,
				VAPID_PRIVATE_KEY: vapidKeys.privateKey,
				SESSION_SECRET: sessionSecret,
			},
		});
		if (!result.ok) {
			const failed = result.results.find((r) => !r.ok);
			printStepFailed("secrets", failed?.stderr);
			process.exit(1);
		}
		printStepDone("secrets");
	}

	// --- install / migrate / deploy ---------------------------------------------------------
	if (steps.has("install")) {
		printStepStart("install");
		const result = await npmCi(runner, { dir });
		if (!result.ok) {
			printStepFailed("install", result.stderr);
			process.exit(1);
		}
		printStepDone("install");
	}

	if (steps.has("migrate")) {
		printStepStart("migrate");
		const result = await applyMigrations(runner, { dir, wranglerBin, workerName });
		if (!result.ok) {
			printStepFailed("migrate", result.stderr);
			process.exit(1);
		}
		printStepDone("migrate");
	}

	let deployedUrl;
	if (steps.has("deploy")) {
		printStepStart("deploy");
		const result = await deploy(runner, { dir, wranglerBin });
		if (!result.ok) {
			printStepFailed("deploy", result.stderr);
			process.exit(1);
		}
		deployedUrl = result.url;
		printStepDone("deploy");
	}

	// --- optional ZDR provider pin ---------------------------------------------------------
	if (steps.has("zdr-pin")) {
		printStepStart("zdr-pin");
		const wantsPin = options.yes
			? false
			: (await promptText(createPromptInterface(), "Pin the cheapest ZDR provider now? (y/N)", "N"))
					.toLowerCase()
					.startsWith("y");
		if (wantsPin) {
			const result = await pinZdrProvider(runner, { dir, openRouterApiKey });
			if (!result.ok) {
				console.log(`  Skipping: ${result.stderr}`);
			} else {
				console.log(`  Pinned LLM_PROVIDER=${result.provider}; redeploying...`);
				const redeploy = await deploy(runner, { dir, wranglerBin });
				if (redeploy.ok) deployedUrl = redeploy.url;
			}
		}
		printStepDone("zdr-pin");
	}

	// --- done --------------------------------------------------------------------------------
	console.log(buildDoneScreen({ url: deployedUrl ?? "(deploy skipped)", dir, workerName }));
}

await main();
