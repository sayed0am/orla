/** Shared fetch helper for `/api/*` calls: surfaces the signed-out banner on 401/403. */

export type AuthFailureHandler = () => void;

let onAuthFailure: AuthFailureHandler | undefined;

/** Registers (or clears, with `undefined`) the handler invoked when `apiFetch` sees a 401/403. */
export function setAuthFailureHandler(handler: AuthFailureHandler | undefined): void {
	onAuthFailure = handler;
}

/**
 * Fetches `path` and, on a 401/403 response, notifies the registered auth-failure handler
 * before returning the response to the caller (which should still handle it as an error).
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(path, init);
	if (res.status === 401 || res.status === 403) {
		onAuthFailure?.();
	}
	return res;
}

export interface AuthStatus {
	mode: "passkey" | "access";
	has_credentials: boolean;
	authenticated: boolean;
}

const DEFAULT_AUTH_STATUS: AuthStatus = {
	mode: "access",
	has_credentials: false,
	authenticated: true,
};

/**
 * Fetches `GET /api/auth/status`. Unreachable or non-JSON responses (e.g. no server-side auth
 * route yet, or Access already handled auth) degrade to "access" mode so the app behaves exactly
 * as it always has.
 */
export async function fetchAuthStatus(): Promise<AuthStatus> {
	try {
		const res = await fetch("/api/auth/status");
		if (!res.ok) {
			return DEFAULT_AUTH_STATUS;
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return DEFAULT_AUTH_STATUS;
		}
		const data = (await res.json()) as unknown;
		if (
			data &&
			typeof data === "object" &&
			((data as { mode?: unknown }).mode === "passkey" ||
				(data as { mode?: unknown }).mode === "access")
		) {
			return data as AuthStatus;
		}
		return DEFAULT_AUTH_STATUS;
	} catch (err) {
		console.error("app: failed to fetch auth status, defaulting to access mode", err);
		return DEFAULT_AUTH_STATUS;
	}
}
