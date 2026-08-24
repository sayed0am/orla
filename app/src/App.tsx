import { useEffect } from "react";
import BriefScreen from "./features/brief/BriefScreen";
import CaptureScreen from "./features/capture/CaptureScreen";
import ChatScreen from "./features/chat/ChatScreen";
import JournalScreen from "./features/journal/JournalScreen";
import LoginScreen from "./features/login/LoginScreen";
import SettingsScreen from "./features/settings/SettingsScreen";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { useHashRoute } from "./hooks/useHashRoute";
import { usePendingActions } from "./hooks/usePendingActions";
import type { Route } from "./routes";
import TabBar from "./ui/TabBar";

const DEFAULT_HASH = "#capture";

export default function App() {
	return (
		<AuthProvider>
			<Shell />
		</AuthProvider>
	);
}

function Shell() {
	const { status, signedOutBanner, onLoginSuccess } = useAuth();
	const route = useHashRoute();

	// Passkey mode with no session, or still booting, doesn't count as "showing the app".
	const showingApp = status !== null && !(status.mode === "passkey" && !status.authenticated);

	// Fetched here (not inside ChatScreen) so the Chat tab's badge is right even when another tab
	// is active — see app/src/hooks/usePendingActions.ts. Gated on `showingApp` so it doesn't fire
	// (and 401) before login/boot resolves.
	const pendingActions = usePendingActions(showingApp);

	useEffect(() => {
		if (showingApp && !window.location.hash) {
			window.location.hash = DEFAULT_HASH;
		}
	}, [showingApp]);

	// Booting: GET /api/auth/status hasn't resolved yet — match the old app.js behavior of an
	// empty <main> with the tab bar hidden until boot() decides what to show.
	if (status === null) {
		return null;
	}

	if (status.mode === "passkey" && !status.authenticated) {
		return <LoginScreen status={status} onSuccess={onLoginSuccess} />;
	}

	return (
		<>
			{signedOutBanner ? (
				<div className="banner glass">
					<p>
						Signed out — <a href="/">reload</a>
					</p>
				</div>
			) : null}
			<ActiveScreen route={route} />
			<TabBar active={route.tab} badge={pendingActions} />
		</>
	);
}

function ActiveScreen({ route }: { route: Route }) {
	switch (route.tab) {
		case "capture":
			return <CaptureScreen />;
		case "chat":
			return <ChatScreen />;
		case "brief":
			return <BriefScreen />;
		case "journal":
			return <JournalScreen sub={route.sub} />;
		case "settings":
			return <SettingsScreen sub={route.sub} />;
		default:
			return null;
	}
}
