import { useEffect, useState } from "react";

/**
 * Shows an "Updated — reload" banner once a new service worker takes control (i.e. a fresh
 * deploy was installed). Never reloads automatically — the caller reloads only when the user
 * clicks the button, so an in-progress capture is never interrupted.
 */
export function useSwUpdate(): { showBanner: boolean; reload: () => void } {
	const [showBanner, setShowBanner] = useState(false);

	useEffect(() => {
		if (!("serviceWorker" in navigator)) {
			return;
		}
		function handleControllerChange() {
			setShowBanner(true);
		}
		navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
		return () => {
			navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
		};
	}, []);

	return {
		showBanner,
		reload: () => window.location.reload(),
	};
}
