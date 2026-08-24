/** Shared formatting helpers across Settings sections (mirrors brief.js's small date/time
 * helpers — formatRunWhen, formatMcpWhen, formatPasskeyWhen were all the same
 * `new Date(iso).toLocaleString()` pattern, so they're ported here once). */

export function formatDateTime(iso: string | null | undefined, fallback = "never"): string {
	if (!iso) {
		return fallback;
	}
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}
