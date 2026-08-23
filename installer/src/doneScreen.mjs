import { D1_BINDING } from "./deployStep.mjs";
import { ZDR_SETTINGS_URL } from "./openrouter.mjs";

/** Builds the final "you're done" screen text. Pure string-building so its content is
 * unit-testable without running the rest of the installer. */
export function buildDoneScreen({ url, dir }) {
	return `
Orla is live: ${url}

Next steps:
  1. Open the URL above on your phone.
  2. Create a passkey (the first passkey registered becomes the owner).
  3. Add to Home Screen (this is how the app installs on iOS/Android).
  4. Open Brief, then enable morning push notifications.

Two things this installer cannot do for you (PRD Sec.7 security prerequisites):
  - Turn on hardware-key 2FA on your Cloudflare account.
  - Enable Zero Data Retention and disable logging/training in OpenRouter:
    ${ZDR_SETTINGS_URL}

To update later:
  cd ${dir} && git pull && npm ci && npx wrangler d1 migrations apply ${D1_BINDING} --remote && npx wrangler deploy
`;
}
