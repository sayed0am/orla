// OpenRouter API key validation, and the PRD G6 ZDR reminder text. Real network I/O (fetch), so
// this is exercised by hand rather than unit-tested; keep the request shape here isolated from
// the prompt loop so a future test could inject a fetch stub if needed.

const AUTH_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
export const ZDR_SETTINGS_URL = "https://openrouter.ai/settings/privacy";

/**
 * Validates an OpenRouter API key via `GET /api/v1/auth/key` (per PRD F8 install flow). Returns
 * `{ ok: true, label }` on success (OpenRouter's `/auth/key` response includes a `label` for the
 * key) or `{ ok: false, reason }` otherwise — never throws, since a bad key during onboarding is
 * an expected, recoverable case (re-prompt), not a crash.
 */
export async function validateOpenRouterKey(apiKey, fetchImpl = fetch) {
	let response;
	try {
		response = await fetchImpl(AUTH_KEY_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
	} catch (err) {
		return { ok: false, reason: `network error: ${err instanceof Error ? err.message : err}` };
	}
	if (!response.ok) {
		return { ok: false, reason: `OpenRouter rejected the key (HTTP ${response.status})` };
	}
	let body;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "OpenRouter returned an unparseable response" };
	}
	return { ok: true, label: body?.data?.label ?? null };
}

export const ZDR_REMINDER = `Reminder (PRD G6): in your OpenRouter account, enable Zero Data Retention and disable
logging/training under Settings -> Privacy before using this key for anything sensitive:
  ${ZDR_SETTINGS_URL}
Orla enforces ZDR-only routing on every request, but that only helps if ZDR is actually turned on
for your account.`;
