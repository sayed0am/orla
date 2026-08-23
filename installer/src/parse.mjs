// Pure output-parsing helpers for wrangler CLI text. No child_process, no fs — these take a
// captured stdout string and return structured data, so they're unit-testable without spawning
// anything. Kept dependency-free like the rest of installer/.

/**
 * Parses `wrangler d1 create <name>` output. wrangler 4.125.0 prints a JSON config snippet
 * (verified against node_modules/wrangler/wrangler-dist/cli.js — `formatConfigSnippet` uses
 * `JSON.stringify` for any `JSON_CONFIG_FORMATS` config path, which includes `.jsonc`):
 *
 *   ✅ Successfully created DB 'orla' in region ENAM
 *   Created your new D1 database.
 *
 *   To access your new D1 Database in your Worker, add the following snippet to your configuration file:
 *   {
 *     "d1_databases": [
 *       {
 *         "binding": "DB",
 *         "database_name": "orla",
 *         "database_id": "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93"
 *       }
 *     ]
 *   }
 *
 * Older wrangler releases (and `wrangler.toml` configs) instead print a TOML table:
 *
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "orla"
 *   database_id = "0fbc25ef-2ca2-4c9a-84d4-b3a466531f93"
 *
 * Both formats put the same literal `database_id` key followed by a `:` or `=` and a quoted
 * UUID, so one regex handles both without caring which shape wraps it.
 */
export function parseD1CreateOutput(stdout) {
	const idMatch = stdout.match(/database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i);
	if (!idMatch) {
		throw new Error(`could not find a database_id in \`wrangler d1 create\` output:\n${stdout}`);
	}
	const nameMatch = stdout.match(/database_name["']?\s*[:=]\s*["']([^"']+)["']/i);
	const createdMatch = stdout.match(/Successfully created DB '([^']+)'/);
	return {
		databaseId: idMatch[1],
		databaseName: nameMatch?.[1] ?? createdMatch?.[1] ?? null,
	};
}

/**
 * Parses `wrangler deploy` output for the deployed URL. wrangler prints (verified against
 * node_modules/wrangler/wrangler-dist/cli.js):
 *
 *   Deployed orla triggers (1.23 sec)
 *     https://orla.<subdomain>.workers.dev
 *
 * A custom domain deploy prints an additional non-workers.dev https:// line; workers.dev is
 * preferred when both are present since that's the URL that always exists for a fresh install.
 */
export function parseDeployUrl(stdout) {
	const urls = [...stdout.matchAll(/https:\/\/\S+/g)].map((m) => m[0].replace(/[),.]+$/, ""));
	if (urls.length === 0) {
		throw new Error(`could not find a deployed URL in \`wrangler deploy\` output:\n${stdout}`);
	}
	const workersDev = urls.find((u) => u.includes(".workers.dev"));
	return workersDev ?? urls[0];
}

/**
 * Parses `wrangler whoami --json` output (verified against node_modules/wrangler/wrangler-dist
 * /cli.js's `whoami()`: `{ loggedIn, authType, email, accounts, tokenPermissions }`, one JSON
 * object on stdout, no other output mixed in for `--json`). Exits non-zero when not
 * authenticated instead of printing `loggedIn: false`, so callers should treat a non-zero exit
 * (or unparseable stdout) as "not logged in" rather than relying on the `loggedIn` field.
 */
export function parseWhoami(stdout) {
	const parsed = JSON.parse(stdout);
	if (!parsed.loggedIn) {
		return { loggedIn: false, email: null, accounts: [] };
	}
	return {
		loggedIn: true,
		email: parsed.email ?? null,
		accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
	};
}
