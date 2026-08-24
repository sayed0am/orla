import { useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "orla-theme";

function readTheme(): Theme {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme) {
	if (theme === "dark") {
		document.documentElement.dataset.theme = "dark";
	} else {
		delete document.documentElement.dataset.theme;
	}

	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch (_) {}

	const meta = document.getElementById("meta-theme-color");
	if (meta) {
		meta.setAttribute("content", theme === "dark" ? "#000000" : "#f4f4f6");
	}
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
	const [theme, setThemeState] = useState<Theme>(readTheme);

	const setTheme = (t: Theme) => {
		applyTheme(t);
		setThemeState(t);
	};

	return { theme, setTheme };
}
