// Secrets-upload step: pipes each secret value to `wrangler secret put NAME` via stdin (never
// argv — see installer/src/run.mjs's doc comment). Verified against
// node_modules/wrangler/wrangler-dist/cli.js's secretPutCommand handler (wrangler 4.125.0):
//   - `secret put` reads the value from stdin whenever `process.stdin.isTTY` is false, which a
//     piped child process always is — no extra flag needed.
//   - If the named Worker doesn't exist yet, `createDraftWorker` prompts
//     "Do you want to create a new Worker with that name and add secrets to it?" with
//     `defaultValue: true, fallbackValue: true` — the fallback applies in non-interactive/CI
//     contexts (again, exactly what a piped child process is), so a fresh Worker is created
//     automatically and secrets do NOT require a prior `wrangler deploy`. This installer still
//     runs a real `deploy` in the next step regardless, both to ship actual app code (the draft
//     is a one-line stub) and as a belt-and-braces guard against a future wrangler version
//     changing that fallback behavior.

const SECRET_NAMES = ["OPENROUTER_API_KEY", "VAPID_PRIVATE_KEY", "SESSION_SECRET"];

export { SECRET_NAMES };

/** @param {Record<string, string>} values - keyed by entries of SECRET_NAMES */
export async function putSecrets(runner, { wranglerBin, workerName, values }) {
	const results = [];
	for (const name of SECRET_NAMES) {
		const value = values[name];
		if (!value) {
			throw new Error(`putSecrets: missing value for ${name}`);
		}
		const result = await runner.capture(
			wranglerBin.command,
			[...wranglerBin.args, "secret", "put", name, "--name", workerName],
			{ input: value },
		);
		results.push({ name, ok: result.code === 0, stderr: result.stderr });
		if (result.code !== 0) {
			return { ok: false, failedAt: name, results };
		}
	}
	return { ok: true, results };
}
