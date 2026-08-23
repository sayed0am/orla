import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			// test/installer.test.ts is a plain-Node vitest suite for the F8 installer (uses
			// node:child_process, node:fs, etc., unavailable inside workerd) — it has its own config
			// (installer/vitest.config.mjs, run via `npm run test:installer`) and must not be picked
			// up here. Setting `exclude` replaces vitest's own default list, so it's repeated below.
			exclude: [
				"test/installer.test.ts",
				"**/node_modules/**",
				"**/dist/**",
				"**/cypress/**",
				"**/.{idea,git,cache,output,temp}/**",
				"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
			],
			setupFiles: ["./test/apply-migrations.ts"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
					// @cloudflare/vitest-pool-workers@0.9.14's isolated-storage stacking asserts on the
					// SQLite-backed DO's `.sqlite-shm` file ("Expected .sqlite, got ...sqlite-shm") —
					// disable it. Storage now persists across ALL tests in the run, so every test must
					// be independent of pre-existing rows (filter to what it created, or assert deltas).
					isolatedStorage: false,
					// With isolatedStorage off, test files otherwise still start as separate concurrent
					// workers sharing the one underlying storage instance, which races the D1 migrations
					// setup file ("table already exists"). Running serially in one worker avoids that.
					singleWorker: true,
					// Pinned @cloudflare/vitest-pool-workers@0.9.14 ships workerd 1.20251011, which
					// throws "vm._setUnsafeEval is not a function" under nodejs_compat at
					// compatibility dates >= 2025-10-11. Tests run on the older date; deploy uses
					// the date in wrangler.jsonc. Remove this when the pool is upgraded.
					miniflare: {
						compatibilityDate: "2025-09-01",
						bindings: {
							TEST_MIGRATIONS: migrations,
							ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
							ACCESS_AUD: "test-aud",
							// Access mode is the default for the whole pool so existing Access tests are
							// unaffected; passkey-mode tests build their own env override (see test/passkey.test.ts).
							AUTH_MODE: "access",
							SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
							// Pinned empty so tests never depend on deploy config; tests that need
							// push keys generate and inject their own.
							VAPID_PUBLIC_KEY: "",
							VAPID_PRIVATE_KEY: "",
							OPENROUTER_BASE_URL: "https://llm.test/v1",
							OPENROUTER_API_KEY: "test-key",
						},
					},
				},
			},
		},
	};
});
