// Regex-based, comment-preserving edits to the cloned repo's wrangler.jsonc. A real JSON(C)
// parser would drop the `//` comments that document AUTH_MODE, VAPID_PUBLIC_KEY, etc. (see the
// root wrangler.jsonc) — those comments matter to anyone who later opens the file by hand, so
// edits here are surgical string replacements instead of parse-mutate-serialize.

function escapeForRegex(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces the value of a `"key": "..."` string field. Matches only quoted-string values (every
 * field this installer touches — name, database_id, ASSISTANT_NAME, VAPID_SUBJECT,
 * VAPID_PUBLIC_KEY, LLM_PROVIDER — is a string in wrangler.jsonc).
 *
 * By default only the first match is replaced: `"name"` is the field this installer cares about
 * at the top level, but `durable_objects.bindings[].name` ("CONVERSATION", "SCHEDULER") reuses
 * the same key deeper in the file — file order puts the top-level field first, so "first" is the
 * correct default. Pass `all: true` for fields that are genuinely unique already (database_id,
 * ASSISTANT_NAME, VAPID_SUBJECT, VAPID_PUBLIC_KEY, LLM_PROVIDER) if a future config ever repeats
 * one; today every one of those is unique, so "first" and "all" behave identically for them.
 */
export function setJsonStringField(source, key, value, { all = false } = {}) {
	const pattern = new RegExp(`("${escapeForRegex(key)}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "g");
	let count = 0;
	const result = source.replace(pattern, (match, prefix) => {
		count++;
		if (!all && count > 1) return match;
		return `${prefix}${JSON.stringify(value)}`;
	});
	if (count === 0) {
		throw new Error(`setJsonStringField: no "${key}": "..." found in wrangler.jsonc`);
	}
	return result;
}

/**
 * Applies every field this installer provisions to a wrangler.jsonc source string in one pass.
 * Any option left `undefined` is skipped (leaves the existing value, e.g. AUTH_MODE stays
 * "passkey" and ACCESS_* stay empty — this installer never touches either).
 *
 * `databaseName` matters as much as `databaseId`: `wrangler d1 migrations apply <name>` and
 * `wrangler deploy` resolve the D1 database by matching `database_name` (or the binding) in
 * config against the account's real D1 database name — a real install once left
 * `"database_name": "orla"` in place while renaming the Worker to `orla-test`, and
 * `d1 migrations apply orla-test --remote` failed with "Couldn't find a D1 DB with the name or
 * binding 'orla-test'". `provision.mjs` creates the D1 database with the same name as the
 * Worker, so callers should pass `databaseName` equal to `workerName` whenever they set either.
 * The `binding` (ORLA_DB) is never touched here — it stays stable across installs.
 */
export function applyProvisioning(
	source,
	{
		workerName,
		databaseId,
		databaseName,
		assistantName,
		vapidSubject,
		vapidPublicKey,
		llmProvider,
	} = {},
) {
	let out = source;
	if (workerName !== undefined) out = setJsonStringField(out, "name", workerName);
	if (databaseId !== undefined) out = setJsonStringField(out, "database_id", databaseId);
	if (databaseName !== undefined) out = setJsonStringField(out, "database_name", databaseName);
	if (assistantName !== undefined) out = setJsonStringField(out, "ASSISTANT_NAME", assistantName);
	if (vapidSubject !== undefined) out = setJsonStringField(out, "VAPID_SUBJECT", vapidSubject);
	if (vapidPublicKey !== undefined) {
		out = setJsonStringField(out, "VAPID_PUBLIC_KEY", vapidPublicKey);
	}
	if (llmProvider !== undefined) out = setJsonStringField(out, "LLM_PROVIDER", llmProvider);
	return out;
}

/** Checks whether a directory's wrangler.jsonc looks like an Orla checkout (`"name": "orla"`),
 * so re-running the installer against an existing clone reuses it instead of failing. Cheap
 * string check rather than a JSONC parse — good enough to distinguish "an Orla checkout" from
 * "some other directory" or "not a checkout at all". */
export function looksLikeOrlaCheckout(wranglerJsonc) {
	return /"name"\s*:\s*"orla"/.test(wranglerJsonc);
}
