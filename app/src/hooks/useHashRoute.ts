import { useEffect, useState } from "react";
import { type Route, routeFromHash } from "../routes";

/** Tracks `location.hash`, parsed into a Route, updating on `hashchange`. */
export function useHashRoute(): Route {
	const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

	useEffect(() => {
		function onHashChange() {
			setRoute(routeFromHash(window.location.hash));
		}
		window.addEventListener("hashchange", onHashChange);
		return () => {
			window.removeEventListener("hashchange", onHashChange);
		};
	}, []);

	return route;
}
