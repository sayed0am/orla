// The installer's step order, shared between the orchestrator (bin/create-orla.mjs), the
// --dry-run plan printer (plan.mjs), and --from <step> resume logic. Kept as one ordered list so
// all three always agree on what "the steps" are.

export const STEP_ORDER = [
	"preflight",
	"clone",
	"prompts",
	"provision",
	"secrets",
	"install",
	"build",
	"migrate",
	"deploy",
	"zdr-pin",
	"done",
];

/** Human-readable one-liners for the checklist printed as the installer runs. */
export const STEP_LABELS = {
	preflight: "Preflight checks (Node, git, Cloudflare login)",
	clone: "Clone the Orla repo",
	prompts: "Collect assistant name, Worker name, OpenRouter key, VAPID subject",
	provision: "Provision D1 and write wrangler.jsonc",
	secrets: "Upload secrets (OpenRouter key, VAPID private key, session secret)",
	install: "npm ci",
	build: "npm run build (frontend)",
	migrate: "Apply D1 migrations",
	deploy: "Deploy the Worker",
	"zdr-pin": "Pin cheapest ZDR provider (optional)",
	done: "Done",
};

/** Index of `step` in STEP_ORDER, or throws for an unknown step name (used to validate --from). */
export function resolveStepIndex(step) {
	const index = STEP_ORDER.indexOf(step);
	if (index === -1) {
		throw new Error(`unknown step "${step}"; valid steps are: ${STEP_ORDER.join(", ")}`);
	}
	return index;
}

/** The steps to run given an optional `--from <step>` resume point. Undefined/omitted runs
 * every step from the start. */
export function stepsToRun(fromStep) {
	if (fromStep === undefined) return [...STEP_ORDER];
	return STEP_ORDER.slice(resolveStepIndex(fromStep));
}
