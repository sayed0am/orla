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

export function printStepFailed(step, detail) {
	console.error(`✘ ${STEP_LABELS[step] ?? step} failed`);
	if (detail) console.error(detail);
	console.error(`\nResume with: npx create-orla --from ${step}`);
}

export function printError(message) {
	console.error(`error: ${message}`);
}
