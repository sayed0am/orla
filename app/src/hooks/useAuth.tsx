import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type AuthStatus, fetchAuthStatus, setAuthFailureHandler } from "../lib/api";

interface AuthContextValue {
	/** `null` while the initial `GET /api/auth/status` request is in flight (booting). */
	status: AuthStatus | null;
	/** Access-mode "Signed out — reload" banner, shown after a 401/403 in access mode. */
	signedOutBanner: boolean;
	/** Call once passkey registration or sign-in succeeds. */
	onLoginSuccess: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<AuthStatus | null>(null);
	const [signedOutBanner, setSignedOutBanner] = useState(false);

	// Read from the auth-failure handler, which is registered once and must always see the
	// latest status (in particular its `mode`) without re-registering on every status change.
	const statusRef = useRef<AuthStatus | null>(status);
	statusRef.current = status;

	useEffect(() => {
		let cancelled = false;
		fetchAuthStatus().then((result) => {
			if (!cancelled) {
				setStatus(result);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		function handleAuthFailure() {
			const current = statusRef.current;
			if (current?.mode === "passkey") {
				// Session cookie expired or was revoked — swap the UI back to the login screen.
				setStatus({ ...current, authenticated: false });
				return;
			}
			// Access mode: Access already redirected before any JS ran, so just surface the banner.
			setSignedOutBanner(true);
		}
		setAuthFailureHandler(handleAuthFailure);
		return () => {
			setAuthFailureHandler(undefined);
		};
	}, []);

	function onLoginSuccess() {
		setStatus((prev) => (prev ? { ...prev, authenticated: true } : prev));
	}

	return (
		<AuthContext.Provider value={{ status, signedOutBanner, onLoginSuccess }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return ctx;
}
