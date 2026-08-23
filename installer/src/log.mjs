// Minimal checklist printer. No dependencies (no chalk/ora) — just enough formatting to make the
// installer's progress legible.

import { STEP_LABELS } from "./steps.mjs";

export function printChecklistHeader() {
	console.log("Orla installer\n");
}

export function printStepStart(step) {
	console.log(`▶ ${STEP_LABELS[step] ?? step}`);
}

export function printStepDone(step) {
	console.log(`✔ ${STEP_LABELS[step] ?? step}\n`);
}

/**
 * Builds the "resume after a failure" command line. Takes `argv` explicitly (rather than reading
 * `process.argv` itself) so it's a pure, unit-testable function — `printStepFailed` below is the
 * only real caller, and passes the live `process.argv`.
 *
 * Echoes back exactly how the user invoked this run (`argv[0]`/`argv[1]` — e.g. `node
 * installer/bin/create-orla.mjs`, or whatever a published `create-orla`/`npm create orla`
 * resolves those to) instead of hardcoding `npx create-orla`, since a hardcoded command doesn't
 * work for a `node installer/bin/create-orla.mjs` dev invocation. Appends `--dir <dir>` so the
 * resume targets the same checkout the failed run was using, not a fresh `./orla`.
 */
export function buildResumeCommand(argv, step, dir) {
	const args = [...argv.slice(0, 2), "--from", step];
	if (dir !== undefined) args.push("--dir", dir);
	return args.join(" ");
}

export function printStepFailed(step, detail, dir) {
	console.error(`✘ ${STEP_LABELS[step] ?? step} failed`);
	if (detail) console.error(detail);
	console.error(`\nResume with: ${buildResumeCommand(process.argv, step, dir)}`);
}

export function printError(message) {
	console.error(`error: ${message}`);
}
