// readline/promises-based prompt helpers. These do real terminal I/O, so they're exercised by
// hand (and by --dry-run/--yes, which skip them) rather than by unit tests — the pure decision
// logic (what default to fall back to) lives in bin/create-orla.mjs's option-resolution, which
// takes plain values, not a readline interface.

import { createInterface } from "node:readline/promises";

const CTRL_C = "";
const BACKSPACE = "";

/** Prompts for a plain string, returning `defaultValue` on an empty reply. */
export async function promptText(rl, question, defaultValue) {
	const suffix = defaultValue ? ` (${defaultValue})` : "";
	const answer = await rl.question(`${question}${suffix}: `);
	const trimmed = answer.trim();
	return trimmed === "" ? defaultValue : trimmed;
}

/**
 * Prompts for a value without echoing it to the terminal (best-effort masking: pauses the
 * terminal's normal line echo while the OpenRouter key is typed). Falls back to a visible prompt
 * when stdin isn't a TTY (piped input, CI) since there's nothing to mask in that case.
 */
export async function promptMasked(rl, question) {
	const stdin = rl.input;
	if (!stdin.isTTY) {
		return (await rl.question(`${question}: `)).trim();
	}

	return new Promise((resolve, reject) => {
		const stdout = rl.output;
		stdout.write(`${question}: `);
		let value = "";
		const onData = (char) => {
			const str = char.toString("utf8");
			if (str === "\n" || str === "\r") {
				stdin.setRawMode(false);
				stdin.removeListener("data", onData);
				stdout.write("\n");
				resolve(value.trim());
				return;
			}
			if (str === CTRL_C) {
				stdin.setRawMode(false);
				stdin.removeListener("data", onData);
				stdout.write("\n");
				reject(new Error("aborted"));
				return;
			}
			if (str === BACKSPACE) {
				value = value.slice(0, -1);
				return;
			}
			value += str;
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
	});
}

export function createPromptInterface() {
	return createInterface({ input: process.stdin, output: process.stdout });
}
