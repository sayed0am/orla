import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// Pinned @cloudflare/vitest-pool-workers@0.9.14 ships workerd 1.20251011, which
				// throws "vm._setUnsafeEval is not a function" under nodejs_compat at
				// compatibility dates >= 2025-10-11. Tests run on the older date; deploy uses
				// the date in wrangler.jsonc. Remove this when the pool is upgraded.
				miniflare: { compatibilityDate: "2025-09-01" },
			},
		},
	},
});
