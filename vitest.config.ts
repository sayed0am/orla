import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
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
						},
					},
				},
			},
		},
	};
});
