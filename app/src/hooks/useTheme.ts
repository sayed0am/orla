import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "orla-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "dark" || stored === "light") {
			return stored;
		}
	} catch (_) {}
	return "system";
}

function resolve(theme: Theme): "light" | "dark" {
	if (theme === "system") {
		return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
	}
	return theme;
}

function applyResolved(resolved: "light" | "dark") {
	if (resolved === "dark") {
		document.documentElement.dataset.theme = "dark";
	} else {
		delete document.documentElement.dataset.theme;
	}

	const meta = document.getElementById("meta-theme-color");
	if (meta) {
		meta.setAttribute("content", resolved === "dark" ? "#000000" : "#f4f4f6");
	}
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
	const [theme, setThemeState] = useState<Theme>(readTheme);

	// Sync on mount (the index.html boot script only sets data-theme, not the meta color) and
	// follow OS changes live while in system mode.
	useEffect(() => {
		applyResolved(resolve(theme));
		if (theme !== "system") {
			return;
		}
		const query = window.matchMedia(DARK_QUERY);
		const onChange = () => applyResolved(resolve("system"));
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [theme]);

	const setTheme = (t: Theme) => {
		try {
			localStorage.setItem(STORAGE_KEY, t);
		} catch (_) {}
		applyResolved(resolve(t));
		setThemeState(t);
	};

	return { theme, setTheme };
}
