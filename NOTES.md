# Orla — open items

_Last updated 2026-08-23. Phases 1–2 are live at orla.sayed0am.workers.dev._

## Phase 3 (in progress)

1. **Passkeys replace Cloudflare Access** — WebAuthn in the Worker (`src/auth.ts` swap),
   `AUTH_MODE` switch so Access stays usable until passkeys are verified on-device.
2. **F8 one-line installer** — `npm create orla`: `wrangler login` → provision D1/DO/cron/secrets →
   OpenRouter key → deploy → first-visit passkey registration. Blocked on 1.
3. **MCP client (§12)** — the only tool surface (calendar and email ride on it). Schema snapshot in
   D1 rendered into the cached prefix; tap-to-confirm for acting tools; never in background jobs.
4. **Memory decision revisit (§8)** — after a few weeks of real use; compare Option A against gaps.
5. **Name / domain / npm checks** — `npm view orla`, `create-orla`, domains, trademark classes 9/42.
6. **Docs** — README setup guide, prerequisites (Cloudflare 2FA, OpenRouter ZDR toggle).

## Smaller loose ends

- **ZDR provider-pinning script (§5)** — pick the cheapest ZDR endpoint reporting
  `supports_implicit_caching` from `GET /api/v1/endpoints/zdr`; write the provider into config.
- **Manifest `screenshots`** — upgrades Android Chrome's install prompt to the rich dialog.
- **AI Gateway** — optional observability proxy; set `OPENROUTER_BASE_URL` to the gateway URL.
- **Brief narrative (LLM)** — the brief is a deterministic template today; an LLM narrative is optional.
- **Reminder UI** — list/cancel reminders in the PWA (API exists: `/api/reminders`).
- **Search includes raw notes?** — FTS currently covers organized notes only.
- **Journal: mark a raw note private after capture** — no edit path yet (raw notes are immutable by
  design; a separate `private` toggle would need a decision).

## Known constraints

- `@cloudflare/vitest-pool-workers` 0.9.14 → tests run at compat date 2025-09-01 and with
  `isolatedStorage: false` (SQLite DO `-shm` assertion). Upgrading requires vitest 4.
- Wrangler OAuth has no Zero Trust scope, so Access apps can't be scripted — why passkeys win.
- iOS: no install prompt exists; "Add to Home Screen" is the install. Web Push needs the installed app.
