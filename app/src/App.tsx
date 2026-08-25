import { useEffect, useState } from "react";
import CaptureScreen from "./features/capture/CaptureScreen";
import ChatScreen from "./features/chat/ChatScreen";
import ExportMenu from "./features/journal/ExportMenu";
import JournalScreen from "./features/journal/JournalScreen";
import LoginScreen from "./features/login/LoginScreen";
import SettingsScreen from "./features/settings/SettingsScreen";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { useHashRoute } from "./hooks/useHashRoute";
import { usePendingActions } from "./hooks/usePendingActions";
import { useSwUpdate } from "./hooks/useSwUpdate";
import type { Route } from "./routes";
import BackButton from "./ui/BackButton";
import HomeShell from "./ui/HomeShell";
import { IconJournal, IconMenu } from "./ui/icons";

const DEFAULT_HASH = "#capture";

export default function App() {
	const { showBanner: showUpdateBanner, reload } = useSwUpdate();

	return (
		<>
			{showUpdateBanner ? (
				<div className="banner glass">
					<p>
						Updated —{" "}
						<button type="button" onClick={reload}>
							reload
						</button>
					</p>
				</div>
			) : null}
			<AuthProvider>
				<Shell />
			</AuthProvider>
		</>
	);
}

function Shell() {
	const { status, signedOutBanner, onLoginSuccess } = useAuth();
	const route = useHashRoute();

	// Passkey mode with no session, or still booting, doesn't count as "showing the app".
	const showingApp = status !== null && !(status.mode === "passkey" && !status.authenticated);

	// Fetched here (not inside ChatScreen) so the chat mode dot's badge is right even when another
	// mode is active — see app/src/hooks/usePendingActions.ts. Gated on `showingApp` so it doesn't
	// fire (and 401) before login/boot resolves.
	const pendingActions = usePendingActions(showingApp);

	useEffect(() => {
		if (showingApp && !window.location.hash) {
			window.location.hash = DEFAULT_HASH;
		}
	}, [showingApp]);

	// Booting: GET /api/auth/status hasn't resolved yet — match the old app.js behavior of an
	// empty <main> until boot() decides what to show.
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
			<ActiveScreen route={route} pendingActions={pendingActions} />
		</>
	);
}

function ActiveScreen({ route, pendingActions }: { route: Route; pendingActions: number }) {
	switch (route.tab) {
		case "capture":
		// #brief (manifest shortcut, old bookmarks) is Jot with the brief day-sheet open.
		case "brief":
			return (
				<HomeShell
					mode="capture"
					badge={pendingActions}
					leftSlot={
						<a className="icon-btn" href="#journal" aria-label="Open journal">
							<IconJournal width={16} height={16} />
						</a>
					}
				>
					<CaptureScreen briefOpen={route.tab === "brief"} />
				</HomeShell>
			);
		case "chat":
			return <ChatMode pendingActions={pendingActions} />;
		case "journal":
			return (
				<HomeShell
					mode="journal"
					badge={pendingActions}
					leftSlot={<BackButton href="#capture" />}
					rightSlot={<ExportMenu />}
				>
					<JournalScreen sub={route.sub} />
				</HomeShell>
			);
		case "settings":
			return <SettingsScreen sub={route.sub} />;
		default:
			return null;
	}
}

// Chat mode's threads toggle lives in HomeShell's header leftSlot, so its open state is lifted
// here and shared with ChatScreen (which renders both the message view and the Threads view).
function ChatMode({ pendingActions }: { pendingActions: number }) {
	const [threadsOpen, setThreadsOpen] = useState(false);

	return (
		<HomeShell
			mode="chat"
			badge={pendingActions}
			leftSlot={
				<button
					type="button"
					className="icon-btn"
					aria-label="Threads"
					onClick={() => setThreadsOpen(true)}
				>
					<IconMenu width={16} height={16} />
				</button>
			}
		>
			<ChatScreen threadsOpen={threadsOpen} onThreadsOpenChange={setThreadsOpen} />
		</HomeShell>
	);
}
