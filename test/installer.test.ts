// Unit tests for the create-orla installer's pure logic (F8). Plain vitest with a node
// environment (installer/vitest.config.mjs) — NOT the workers pool the rest of this repo's
// tests use, since the installer is a Node CLI that never runs inside a Worker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import { parseArgs } from "../installer/src/cliArgs.mjs";
import { isExistingOrlaCheckout } from "../installer/src/clone.mjs";
import { applyMigrations, D1_BINDING, deploy, npmCi } from "../installer/src/deployStep.mjs";
import { buildResumeCommand } from "../installer/src/log.mjs";
import { parseD1CreateOutput, parseDeployUrl, parseWhoami } from "../installer/src/parse.mjs";
import { buildPlan, formatPlan } from "../installer/src/plan.mjs";
import {
	checkCloudflareLogin,
	checkGitPresent,
	checkNodeVersion,
} from "../installer/src/preflight.mjs";
import { provision } from "../installer/src/provision.mjs";
import type { CaptureOptions, CaptureResult, Runner } from "../installer/src/run.d.mts";
import { generateSessionSecret } from "../installer/src/secrets.mjs";
import { putSecrets, SECRET_NAMES } from "../installer/src/secretsStep.mjs";
import { resolveStepIndex, STEP_ORDER, stepsToRun } from "../installer/src/steps.mjs";
import { generateVapidKeys } from "../installer/src/vapid.mjs";
import {
	applyProvisioning,
	looksLikeOrlaCheckout,
	setJsonStringField,
} from "../installer/src/wranglerConfig.mjs";
import { WRANGLER_VERSION } from "../installer/src/wranglerVersion.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A Runner double that records every call instead of spawning anything, and resolves each
 * `capture` call from a caller-supplied queue. This is the "spawn mocked via an injectable
 * runner" pattern the step modules (provision.mjs, secretsStep.mjs, deployStep.mjs,
 * preflight.mjs) are built around. */
function createMockRunner(captureResults: CaptureResult[]): {
	runner: Runner;
	calls: Array<{ command: string; args: string[]; options: CaptureOptions | undefined }>;
} {
	const calls: Array<{ command: string; args: string[]; options: CaptureOptions | undefined }> = [];
	let index = 0;
	const runner: Runner = {
		async capture(command, args, options) {
			calls.push({ command, args, options });
			const result = captureResults[index];
			index += 1;
			if (!result) {
				throw new Error(
					`mock runner: no queued result for call ${index} (${command} ${args.join(" ")})`,
				);
			}
			return result;
		},
		async interactive(command, args, options) {
			calls.push({ command, args, options });
			return { code: 0 };
		},
	};
	return { runner, calls };
}

const WRANGLER_BIN = { command: "npx", args: ["--yes", `wrangler@${WRANGLER_VERSION}`] };

describe("wranglerVersion", () => {
	it("stays in sync with the root package.json's pinned wrangler devDependency", () => {
		const pkg: { devDependencies?: Record<string, string> } = JSON.parse(
			readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.devDependencies?.wrangler).toBe(WRANGLER_VERSION);
	});
});

describe("parseD1CreateOutput", () => {
	it("parses the JSON config-snippet format wrangler 4.125.0 prints", () => {
		const stdout = `✅ Successfully created DB 'orla' in region ENAM
Created your new D1 database.

To access your new D1 Database in your Worker, add the following snippet to your configuration file:
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "orla",
      "database_id": "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93"
    }
  ]
}
`;
		expect(parseD1CreateOutput(stdout)).toEqual({
			databaseId: "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93",
			databaseName: "orla",
		});
	});

	it("parses the legacy TOML table format", () => {
		const stdout = `✅ Successfully created DB 'orla'!

[[d1_databases]]
binding = "DB"
database_name = "orla"
database_id = "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93"
`;
		expect(parseD1CreateOutput(stdout)).toEqual({
			databaseId: "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93",
			databaseName: "orla",
		});
	});

	it("throws with the offending output when no database_id is present", () => {
		expect(() => parseD1CreateOutput("something went wrong")).toThrow(/database_id/);
	});
});

describe("parseDeployUrl", () => {
	it("extracts the workers.dev URL from deploy output", () => {
		const stdout = `Total Upload: 42.42 KiB / gzip: 12.34 KiB
Uploaded orla (1.23 sec)
Deployed orla triggers (1.50 sec)
  https://orla.sayed0am.workers.dev
Current Version ID: abc-123
`;
		expect(parseDeployUrl(stdout)).toBe("https://orla.sayed0am.workers.dev");
	});

	it("prefers the workers.dev URL over a custom-domain line", () => {
		const stdout = `Deployed orla triggers (1.50 sec)
  https://assistant.example.com
  https://orla.sayed0am.workers.dev
`;
		expect(parseDeployUrl(stdout)).toBe("https://orla.sayed0am.workers.dev");
	});

	it("throws when no URL is present", () => {
		expect(() => parseDeployUrl("No targets deployed for orla")).toThrow(/deployed URL/);
	});
});

describe("parseWhoami", () => {
	it("parses a logged-in response", () => {
		const stdout = JSON.stringify({
			loggedIn: true,
			authType: "OAuth Token",
			email: "sayed0am@gmail.com",
			accounts: [{ id: "acct-1", name: "sayed0am@gmail.com's Account" }],
			tokenPermissions: [],
		});
		expect(parseWhoami(stdout)).toEqual({
			loggedIn: true,
			email: "sayed0am@gmail.com",
			accounts: [{ id: "acct-1", name: "sayed0am@gmail.com's Account" }],
		});
	});

	it("parses a not-logged-in response", () => {
		const stdout = JSON.stringify({ loggedIn: false });
		expect(parseWhoami(stdout)).toEqual({ loggedIn: false, email: null, accounts: [] });
	});
});

describe("wrangler.jsonc rewriting", () => {
	function withTempConfig<T>(fn: (path: string, original: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "orla-installer-test-"));
		const configPath = join(dir, "wrangler.jsonc");
		const original = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
		writeFileSync(configPath, original);
		try {
			return fn(configPath, original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("replaces a single string field while leaving the rest byte-identical", () => {
		withTempConfig((configPath, original) => {
			const updated = setJsonStringField(original, "VAPID_SUBJECT", "mailto:new@example.com");
			expect(updated).toContain('"VAPID_SUBJECT": "mailto:new@example.com"');
			// Nothing else in the file changed.
			const withoutSubjectLines = (s: string) =>
				s.split("\n").filter((line) => !line.includes("VAPID_SUBJECT"));
			expect(withoutSubjectLines(updated)).toEqual(withoutSubjectLines(original));
			writeFileSync(configPath, updated);
		});
	});

	it("replaces only the first (top-level) occurrence of a repeated key by default", () => {
		withTempConfig((_configPath, original) => {
			const updated = setJsonStringField(original, "name", "my-orla");
			expect(updated).toContain('"name": "my-orla"');
			// The durable_objects bindings' `"name": "CONVERSATION"` / `"SCHEDULER"` must survive.
			expect(updated).toContain('"name": "CONVERSATION"');
			expect(updated).toContain('"name": "SCHEDULER"');
		});
	});

	it("throws for a field that doesn't exist", () => {
		withTempConfig((_configPath, original) => {
			expect(() => setJsonStringField(original, "NOT_A_REAL_FIELD", "x")).toThrow(
				/NOT_A_REAL_FIELD/,
			);
		});
	});

	it("applyProvisioning sets every provisioned field and preserves comments", () => {
		withTempConfig((_configPath, original) => {
			const updated = applyProvisioning(original, {
				workerName: "my-orla",
				databaseId: "11111111-2222-3333-4444-555555555555",
				databaseName: "my-orla",
				assistantName: "Robin",
				vapidSubject: "mailto:me@example.com",
				vapidPublicKey: "PUBLICKEYVALUE",
			});

			expect(updated).toContain('"name": "my-orla"');
			expect(updated).toContain('"database_id": "11111111-2222-3333-4444-555555555555"');
			// Regression: a real install with Worker name "orla-test" once left
			// `"database_name": "orla"` in place, and `wrangler d1 migrations apply orla-test
			// --remote` failed with "Couldn't find a D1 DB with the name or binding 'orla-test'"
			// because wrangler resolves the migrations target by database_name/binding in config.
			expect(updated).toContain('"database_name": "my-orla"');
			expect(updated).toContain('"ASSISTANT_NAME": "Robin"');
			expect(updated).toContain('"VAPID_SUBJECT": "mailto:me@example.com"');
			expect(updated).toContain('"VAPID_PUBLIC_KEY": "PUBLICKEYVALUE"');

			// The D1 binding itself must never change — only database_name/database_id do.
			expect(updated).toContain('"binding": "ORLA_DB"');

			// Comments are preserved verbatim (a JSON.parse/stringify round trip would drop these).
			expect(updated).toContain("// 03:00 UTC nightly reorganization");
			expect(updated).toContain("// Secrets (wrangler secret put)");
			expect(updated).toContain("// Auth end state is passkeys");

			// Untouched fields stay untouched.
			expect(updated).toContain('"AUTH_MODE": "passkey"');
			expect(updated).toContain('"ACCESS_TEAM_DOMAIN": ""');

			// Still valid JSONC: dropping whole-line `//` comments must leave parseable JSON. (Every
			// comment in wrangler.jsonc is a standalone line — trimming only those, rather than
			// anything after "//" on every line, avoids mistaking the "//" in string values like
			// "https://openrouter.ai/api/v1" for a comment.)
			const withoutComments = updated
				.split("\n")
				.filter((line) => !line.trim().startsWith("//"))
				.join("\n");
			expect(() => JSON.parse(withoutComments)).not.toThrow();
		});
	});

	it("applyProvisioning skips fields left undefined", () => {
		withTempConfig((_configPath, original) => {
			const updated = applyProvisioning(original, { llmProvider: "deepinfra" });
			expect(updated).toContain('"LLM_PROVIDER": "deepinfra"');
			expect(updated).toContain('"name": "orla"'); // unchanged
		});
	});
});

describe("looksLikeOrlaCheckout / isExistingOrlaCheckout", () => {
	it("recognizes the real root wrangler.jsonc as an Orla checkout", () => {
		const original = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
		expect(looksLikeOrlaCheckout(original)).toBe(true);
	});

	it("rejects a config with a different worker name", () => {
		expect(looksLikeOrlaCheckout('{ "name": "some-other-worker" }')).toBe(false);
	});

	it("isExistingOrlaCheckout checks the filesystem for wrangler.jsonc", () => {
		const dir = mkdtempSync(join(tmpdir(), "orla-installer-test-"));
		try {
			expect(isExistingOrlaCheckout(dir)).toBe(false);
			writeFileSync(join(dir, "wrangler.jsonc"), readFileSync(join(REPO_ROOT, "wrangler.jsonc")));
			expect(isExistingOrlaCheckout(dir)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("VAPID key generation", () => {
	it("produces a public/private key pair shaped like scripts/vapid.mjs's output", async () => {
		const { publicKey, privateKey } = await generateVapidKeys();
		// Uncompressed P-256 point (0x04 || X || Y = 65 bytes) base64url-encoded, no padding.
		expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(Buffer.from(publicKey, "base64url").length).toBe(65);
		// The raw `d` scalar for a P-256 key is 32 bytes base64url-encoded.
		expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(Buffer.from(privateKey, "base64url").length).toBe(32);
	});

	it("generates a different pair on every call", async () => {
		const a = await generateVapidKeys();
		const b = await generateVapidKeys();
		expect(a.publicKey).not.toBe(b.publicKey);
	});
});

describe("generateSessionSecret", () => {
	it("is 48 random bytes, base64-encoded", () => {
		const secret = generateSessionSecret();
		expect(Buffer.from(secret, "base64").length).toBe(48);
		// Well over src/auth.ts's MIN_SESSION_SECRET_LENGTH of 32 characters.
		expect(secret.length).toBeGreaterThanOrEqual(32);
	});

	it("generates a different secret on every call", () => {
		expect(generateSessionSecret()).not.toBe(generateSessionSecret());
	});
});

describe("step resume logic", () => {
	it("STEP_ORDER matches the milestones documented in the F8 task", () => {
		expect(STEP_ORDER).toEqual([
			"preflight",
			"clone",
			"prompts",
			"provision",
			"secrets",
			"install",
			"migrate",
			"deploy",
			"zdr-pin",
			"done",
		]);
	});

	it("stepsToRun() with no argument runs everything", () => {
		expect(stepsToRun()).toEqual(STEP_ORDER);
	});

	it("stepsToRun(step) returns that step and every step after it", () => {
		expect(stepsToRun("secrets")).toEqual([
			"secrets",
			"install",
			"migrate",
			"deploy",
			"zdr-pin",
			"done",
		]);
		expect(stepsToRun("done")).toEqual(["done"]);
	});

	it("resolveStepIndex throws a helpful error for an unknown step", () => {
		expect(() => resolveStepIndex("bogus")).toThrow(/unknown step "bogus"/);
	});
});

describe("cliArgs.parseArgs", () => {
	it("defaults to no flags set", () => {
		const args = parseArgs([]);
		expect(args).toMatchObject({ yes: false, dryRun: false, help: false, ref: "main" });
	});

	it("parses --yes, --dry-run, --ref, --dir, --from", () => {
		const args = parseArgs([
			"--yes",
			"--dry-run",
			"--ref",
			"v1.2.3",
			"--dir",
			"my-orla",
			"--from",
			"deploy",
		]);
		expect(args).toMatchObject({
			yes: true,
			dryRun: true,
			ref: "v1.2.3",
			dir: "my-orla",
			from: "deploy",
		});
	});

	it("--dry-run implies --yes so a dry run never blocks on a prompt", () => {
		const args = parseArgs(["--dry-run"]);
		expect(args.yes).toBe(true);
	});

	it("throws on an unknown flag", () => {
		expect(() => parseArgs(["--not-a-real-flag"])).toThrow(/unknown argument/);
	});

	it("throws when a value-taking flag is missing its value", () => {
		expect(() => parseArgs(["--ref"])).toThrow(/requires a value/);
	});
});

describe("--dry-run plan", () => {
	it("builds the expected command list without executing anything", () => {
		const plan = buildPlan({
			wranglerVersion: "4.125.0",
			ref: "main",
			dir: "orla",
			workerName: "orla",
		});
		expect(plan.map((s) => s.step)).toEqual(STEP_ORDER);

		const preflight = plan.find((s) => s.step === "preflight");
		expect(preflight?.commands).toContain("npx --yes wrangler@4.125.0 whoami --json");

		const provisionStep = plan.find((s) => s.step === "provision");
		expect(provisionStep?.commands).toContain(
			"npx --yes wrangler@4.125.0 d1 create orla --update-config=false",
		);

		const secretsStep = plan.find((s) => s.step === "secrets");
		expect(secretsStep?.commands).toEqual([
			"echo <OPENROUTER_API_KEY> | npx --yes wrangler@4.125.0 secret put OPENROUTER_API_KEY --name orla",
			"echo <VAPID_PRIVATE_KEY> | npx --yes wrangler@4.125.0 secret put VAPID_PRIVATE_KEY --name orla",
			"echo <SESSION_SECRET> | npx --yes wrangler@4.125.0 secret put SESSION_SECRET --name orla",
		]);

		const migrateStep = plan.find((s) => s.step === "migrate");
		expect(migrateStep?.commands).toEqual([
			`npx --yes wrangler@4.125.0 d1 migrations apply ${D1_BINDING} --remote`,
		]);

		const deployStep = plan.find((s) => s.step === "deploy");
		expect(deployStep?.commands).toEqual(["npx --yes wrangler@4.125.0 deploy"]);
	});

	it("requires a wranglerVersion", () => {
		// @ts-expect-error — intentionally omitting the required field to exercise the runtime check.
		expect(() => buildPlan({})).toThrow(/wranglerVersion/);
	});

	it("formats into a readable transcript with no executed side effects", () => {
		const plan = buildPlan({ wranglerVersion: "4.125.0" });
		const text = formatPlan(plan);
		expect(text).toContain("# preflight");
		expect(text).toContain("$ node --version");
		expect(text.split("\n").length).toBeGreaterThan(10);
	});
});

describe("step modules use an injectable runner instead of spawning directly", () => {
	it("provision() runs `d1 create` with --update-config=false, then rewrites wrangler.jsonc", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orla-installer-test-"));
		try {
			const original = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
			writeFileSync(join(dir, "wrangler.jsonc"), original);

			const { runner, calls } = createMockRunner([
				{
					code: 0,
					stdout:
						'{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "orla",\n      "database_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"\n    }\n  ]\n}\n',
					stderr: "",
				},
			]);

			const result = await provision(runner, {
				dir,
				wranglerBin: WRANGLER_BIN,
				workerName: "orla",
				assistantName: "Orla",
				vapidSubject: "mailto:me@example.com",
				vapidPublicKey: "PUBKEY",
			});

			expect(result).toEqual({ ok: true, databaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.args).toEqual([
				"--yes",
				`wrangler@${WRANGLER_VERSION}`,
				"d1",
				"create",
				"orla",
				"--update-config=false",
			]);

			const written = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
			expect(written).toContain('"database_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
			// Regression: database_name must be rewritten too, not just database_id — see
			// applyProvisioning's doc comment and the "wrangler.jsonc rewriting" describe block above.
			expect(written).toContain('"database_name": "orla"');
			expect(written).toContain('"VAPID_PUBLIC_KEY": "PUBKEY"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("provision() rewrites database_name to the Worker name even when it differs from the checkout's current one (real-install regression)", async () => {
		// Reproduces the bug report exactly: Worker name "orla-test" against a freshly cloned
		// checkout whose wrangler.jsonc still says `"database_name": "orla"`. Before the fix,
		// `wrangler d1 migrations apply orla-test --remote` failed with "Couldn't find a D1 DB
		// with the name or binding 'orla-test'" because database_name was left at "orla".
		const dir = mkdtempSync(join(tmpdir(), "orla-installer-test-"));
		try {
			const original = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
			writeFileSync(join(dir, "wrangler.jsonc"), original);

			const { runner } = createMockRunner([
				{
					code: 0,
					stdout:
						'{\n  "d1_databases": [\n    {\n      "binding": "ORLA_DB",\n      "database_name": "orla-test",\n      "database_id": "99999999-8888-7777-6666-555555555555"\n    }\n  ]\n}\n',
					stderr: "",
				},
			]);

			const result = await provision(runner, {
				dir,
				wranglerBin: WRANGLER_BIN,
				workerName: "orla-test",
				assistantName: "Orla",
				vapidSubject: "mailto:me@example.com",
				vapidPublicKey: "PUBKEY",
			});

			expect(result.ok).toBe(true);
			const written = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
			expect(written).toContain('"name": "orla-test"');
			expect(written).toContain('"database_name": "orla-test"');
			expect(written).toContain('"database_id": "99999999-8888-7777-6666-555555555555"');
			// The binding is never renamed.
			expect(written).toContain('"binding": "ORLA_DB"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("provision() surfaces a `d1 create` failure without touching wrangler.jsonc", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orla-installer-test-"));
		try {
			const original = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
			writeFileSync(join(dir, "wrangler.jsonc"), original);
			const { runner } = createMockRunner([
				{ code: 1, stdout: "", stderr: "A database with that name already exists" },
			]);

			const result = await provision(runner, {
				dir,
				wranglerBin: WRANGLER_BIN,
				workerName: "orla",
				assistantName: "Orla",
				vapidSubject: "mailto:me@example.com",
				vapidPublicKey: "PUBKEY",
			});

			expect(result.ok).toBe(false);
			expect(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).toBe(original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("putSecrets() pipes each secret value via stdin, never argv, in SECRET_NAMES order", async () => {
		const { runner, calls } = createMockRunner([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]);

		const result = await putSecrets(runner, {
			wranglerBin: WRANGLER_BIN,
			workerName: "orla",
			values: {
				OPENROUTER_API_KEY: "sk-or-secret",
				VAPID_PRIVATE_KEY: "priv-secret",
				SESSION_SECRET: "session-secret",
			},
		});

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(3);
		expect(calls.map((c) => c.args.at(-3))).toEqual(SECRET_NAMES);
		for (const call of calls) {
			// The secret *values* must never appear in argv (visible to `ps`) — only the constant
			// subcommand name "secret put" is expected to contain the word "secret".
			expect(call.args.join(" ")).not.toContain("sk-or-secret");
			expect(call.args.join(" ")).not.toContain("priv-secret");
			expect(call.args.join(" ")).not.toContain("session-secret");
		}
		expect(calls[0]?.options?.input).toBe("sk-or-secret");
		expect(calls[1]?.options?.input).toBe("priv-secret");
		expect(calls[2]?.options?.input).toBe("session-secret");
	});

	it("putSecrets() stops at the first failure", async () => {
		const { runner, calls } = createMockRunner([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "boom" },
		]);

		const result = await putSecrets(runner, {
			wranglerBin: WRANGLER_BIN,
			workerName: "orla",
			values: {
				OPENROUTER_API_KEY: "a",
				VAPID_PRIVATE_KEY: "b",
				SESSION_SECRET: "c",
			},
		});

		expect(result).toMatchObject({ ok: false, failedAt: "VAPID_PRIVATE_KEY" });
		expect(calls).toHaveLength(2);
	});

	it("npmCi() runs `npm ci` in the checkout directory", async () => {
		const dir = "/some/checkout";
		const { runner, calls } = createMockRunner([{ code: 0, stdout: "", stderr: "" }]);
		const result = await npmCi(runner, { dir });
		expect(result.ok).toBe(true);
		expect(calls[0]).toMatchObject({ command: "npm", args: ["ci"], options: { cwd: dir } });
	});

	it("applyMigrations() resolves the database by its binding, not the Worker/database name", async () => {
		// Regression: this must NOT depend on workerName/database_name staying in sync (that's a
		// separate wrangler.jsonc-rewrite concern, covered above) — the binding is stable
		// regardless, and `wrangler d1 migrations apply <name-or-binding>` accepts either.
		const { runner, calls } = createMockRunner([{ code: 0, stdout: "", stderr: "" }]);
		await applyMigrations(runner, { dir: "/orla", wranglerBin: WRANGLER_BIN });
		expect(calls[0]?.args).toEqual([
			"--yes",
			`wrangler@${WRANGLER_VERSION}`,
			"d1",
			"migrations",
			"apply",
			D1_BINDING,
			"--remote",
		]);
	});

	it("deploy() parses the deployed URL from a successful run", async () => {
		const { runner } = createMockRunner([
			{
				code: 0,
				stdout: "Deployed orla triggers (1.0 sec)\n  https://orla.sayed0am.workers.dev\n",
				stderr: "",
			},
		]);
		const result = await deploy(runner, { dir: "/orla", wranglerBin: WRANGLER_BIN });
		expect(result).toEqual({
			ok: true,
			url: "https://orla.sayed0am.workers.dev",
			stdout: "Deployed orla triggers (1.0 sec)\n  https://orla.sayed0am.workers.dev\n",
		});
	});

	it("deploy() surfaces a non-zero exit as a failure instead of throwing", async () => {
		const { runner } = createMockRunner([{ code: 1, stdout: "", stderr: "compile error" }]);
		const result = await deploy(runner, { dir: "/orla", wranglerBin: WRANGLER_BIN });
		expect(result).toEqual({ ok: false, stdout: "", stderr: "compile error" });
	});

	it("checkGitPresent() reports success/failure from the mock runner's exit code", async () => {
		const ok = await checkGitPresent(
			createMockRunner([{ code: 0, stdout: "git version 2.42.0", stderr: "" }]).runner,
		);
		expect(ok).toEqual({ ok: true });
		const missing = await checkGitPresent(
			createMockRunner([{ code: 127, stdout: "", stderr: "not found" }]).runner,
		);
		expect(missing).toEqual({ ok: false });
	});

	it("checkCloudflareLogin() treats a non-zero exit as not logged in", async () => {
		const { runner } = createMockRunner([{ code: 1, stdout: "", stderr: "not authenticated" }]);
		expect(await checkCloudflareLogin(runner, WRANGLER_BIN)).toEqual({
			loggedIn: false,
			email: null,
			accounts: [],
		});
	});

	it("checkCloudflareLogin() parses a logged-in whoami --json response", async () => {
		const { runner } = createMockRunner([
			{
				code: 0,
				stdout: JSON.stringify({
					loggedIn: true,
					email: "sayed0am@gmail.com",
					accounts: [{ id: "1", name: "Personal" }],
				}),
				stderr: "",
			},
		]);
		expect(await checkCloudflareLogin(runner, WRANGLER_BIN)).toEqual({
			loggedIn: true,
			email: "sayed0am@gmail.com",
			accounts: [{ id: "1", name: "Personal" }],
		});
	});
});

describe("checkNodeVersion", () => {
	it("accepts Node 20 and above", () => {
		expect(checkNodeVersion("v20.0.0")).toEqual({ ok: true, major: 20 });
		expect(checkNodeVersion("v24.15.0")).toEqual({ ok: true, major: 24 });
	});

	it("rejects Node below 20", () => {
		expect(checkNodeVersion("v18.19.0").ok).toBe(false);
	});

	it("defaults to the running process's version", () => {
		expect(checkNodeVersion().ok).toBe(true);
	});
});

describe("installer CLI has zero runtime dependencies", () => {
	it("installer/package.json declares no dependencies", () => {
		const pkg: { dependencies?: Record<string, string> } = JSON.parse(
			readFileSync(join(REPO_ROOT, "installer", "package.json"), "utf8"),
		);
		expect(pkg.dependencies ?? {}).toEqual({});
	});
});

describe("buildResumeCommand", () => {
	it("echoes the actual argv[0]/argv[1] the user invoked, not a hardcoded command", () => {
		const argv = ["/usr/local/bin/node", "/Users/me/installer/bin/create-orla.mjs", "--yes"];
		expect(buildResumeCommand(argv, "migrate")).toBe(
			"/usr/local/bin/node /Users/me/installer/bin/create-orla.mjs --from migrate",
		);
	});

	it("appends --dir so the resume targets the same checkout", () => {
		const argv = ["node", "create-orla.mjs"];
		expect(buildResumeCommand(argv, "secrets", "my-orla")).toBe(
			"node create-orla.mjs --from secrets --dir my-orla",
		);
	});

	it("works for a published `create-orla` invocation too", () => {
		const argv = ["/usr/local/bin/node", "/usr/local/bin/create-orla"];
		expect(buildResumeCommand(argv, "deploy", "orla")).toBe(
			"/usr/local/bin/node /usr/local/bin/create-orla --from deploy --dir orla",
		);
	});
});

describe("bin/create-orla.mjs --dry-run (end-to-end, no wrangler/git/network calls)", () => {
	it("prints a full plan and exits 0 without needing any input", () => {
		const stdout = execFileSync(
			process.execPath,
			[join(REPO_ROOT, "installer", "bin", "create-orla.mjs"), "--dry-run"],
			{ encoding: "utf8", cwd: REPO_ROOT },
		);
		for (const step of STEP_ORDER) {
			expect(stdout).toContain(`# ${step}`);
		}
		expect(stdout).toContain(`wrangler@${WRANGLER_VERSION}`);
		expect(stdout).toContain("(--dry-run: nothing above was executed)");
	});
});
