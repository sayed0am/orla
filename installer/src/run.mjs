// Thin child_process wrapper. Kept separate from the step logic so steps take an injectable
// `runner` argument in tests instead of spawning anything real.

import { spawn } from "node:child_process";

/**
 * Runs a command to completion and captures stdout/stderr. Never rejects on a non-zero exit —
 * the caller decides what a failure means for that step; it rejects only if the process itself
 * could not be spawned (e.g. command not found).
 *
 * `input`, if given, is written to the child's stdin and the stream is then closed — this is how
 * secret values reach `wrangler secret put` without ever appearing in argv (visible in `ps`) or
 * a shell history file.
 */
export function capture(command, args, { cwd, input, env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: env ?? process.env,
			stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		if (input !== undefined) {
			child.stdin.write(input);
			child.stdin.end();
		}
	});
}

/**
 * Runs a command with stdio inherited from this process (visible terminal output, e.g.
 * `wrangler login`'s browser-opening flow, or `npm ci`'s progress output). Resolves with just
 * the exit code — there's no captured output to parse.
 */
export function interactive(command, args, { cwd, env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code }));
	});
}

/** The real runner used by the CLI outside of tests. Steps accept a runner shaped like this so
 * tests can substitute a mock that records calls instead of spawning anything. */
export function createRealRunner() {
	return { capture, interactive };
}
