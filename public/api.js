/** Shared fetch helper for `/api/*` calls: surfaces the signed-out banner on 401/403. */

import { reportAuthFailure } from "./app.js";

/**
 * Fetches `path` and, on a 401/403 response, shows the signed-out banner before
 * returning the response to the caller (which should still handle it as an error).
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function apiFetch(path, init) {
	const res = await fetch(path, init);
	if (res.status === 401 || res.status === 403) {
		reportAuthFailure();
	}
	return res;
}
