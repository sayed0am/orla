import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerServiceWorker } from "./lib/sw";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

registerServiceWorker();

// biome-ignore lint/style/noNonNullAssertion: #root is defined in app/index.html
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
