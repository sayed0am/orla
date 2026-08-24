# Orla — open items

_Last updated 2026-08-24. Phases 1–2 are live at orla.sayed0am.workers.dev._

## Phase 3 (in progress)

1. **Passkeys replace Cloudflare Access** — DONE 2026-08-23 (verified on-device; Access app to be deleted; `AUTH_MODE=passkey`).
   `AUTH_MODE` switch so Access stays usable until passkeys are verified on-device.
2. **F8 one-line installer** — DONE (code) 2026-08-23, not yet run against a live account.
   `installer/` is a standalone zero-dependency npm package (`create-orla`, `bin/create-orla.mjs`)
   that runs `npx wrangler@4.125.0` (pinned to match root `package.json`, checked for drift by
   `test/installer.test.ts`) against a fresh `git clone` of this repo: preflight (Node/git/
   `wrangler login`) → clone → prompts (assistant name, Worker name, OpenRouter key validated via
   `GET /api/v1/auth/key`, VAPID subject) → `d1 create` + comment-preserving `wrangler.jsonc`
   rewrite → three secrets piped via stdin (`OPENROUTER_API_KEY`, `VAPID_PRIVATE_KEY`,
   `SESSION_SECRET`) → `npm ci` → `d1 migrations apply --remote` → `deploy` → optional ZDR
   provider pin (`scripts/zdr-pin.mjs --json`) → done screen. `--dry-run` prints the full command
   list with no wrangler/git/network calls (verified locally); `--from <step>` resumes after a
   failure; `--yes` skips prompts. Tests: `npm run test:installer` (plain vitest, node
   environment, `installer/vitest.config.mjs` — not the workers pool) cover output parsing (both
   the current JSON-snippet and legacy TOML `d1 create` formats), the `wrangler.jsonc` regex
   rewrite (run against a copy of the real root file, comments verified intact), deploy-URL
   parsing, VAPID key shape, step-resume ordering, and the `--dry-run` command list, with wrangler
   itself mocked via an injectable runner. Docs: `docs/INSTALL.md`; linked from README.
   Still needed before calling this done for real: one live end-to-end run against a throwaway
   Cloudflare account (not done here — no account writes were made producing this code), and the
   name/domain/npm-publish checks in item 4 below (package is named `create-orla` but unpublished).
3. **Memory decision revisit (§8)** — after a few weeks of real use; compare Option A against gaps.
4. **Name / domain / npm checks** — `npm view orla`, `create-orla`, domains, trademark classes 9/42.
   Needed before `npm create orla` actually works for a stranger: `create-orla` isn't published yet.
5. **Docs** — DONE 2026-08-23: `docs/INSTALL.md` (prerequisites, what's provisioned, costs,
   updating, uninstalling, privacy model), linked from README.
6. **Installer follow-ups** (not required for F8's exit criterion, deferred):
   - Publish `create-orla` to npm (blocked on item 4's name check) and wire up `npm create orla`
     to actually resolve to it — today it's runnable as `node installer/bin/create-orla.mjs`.
   - Tag releases instead of always cloning `main` (installer already has `--ref`; just needs the
     first tag once Phase 3 ships and a default other than `main` becomes appropriate).
   - Custom domain option in the installer (currently only the `*.workers.dev` URL from `wrangler
     deploy`; `wrangler deploy --domain` exists but needs a zone already on the account, which the
     installer doesn't prompt for).
7. **Frontend revamp — Vite + React** — DONE (code) 2026-08-24; `public/` (the old imperative-DOM
   shell) is retired. `app/` builds via `npm run build` (`vite build app`) into `dist/`, served by
   the `ASSETS` binding wrangler.jsonc already points at. Dev loop is `npm run dev:app` (`vite
   build app --watch`) run alongside `npm run dev` (`wrangler dev`, serving `dist/`) on one
   origin — deliberately not a Vite dev server on :5173, because WebAuthn's rpId/origin is
   request-derived; a separate dev-server origin would break passkeys and need an SSE proxy for
   the chat stream. The service-worker precache list is generated at build time by the `orlaSw()`
   plugin in `app/vite.config.ts`, which emits `sw.js` and `outbox.js` unhashed at the `dist/`
   root. Theme is manual light/dark (`localStorage` key `orla-theme`, light default) instead of
   `prefers-color-scheme`. Installer gained a `build` step (between `install` and `migrate`) to
   run `npm run build` before deploying. Follow-ups (not required for this to be done):
   - Regenerate the app icons to match the new monochrome+accent design.
   - Add `apple-touch-startup-image` splash screens.

## Smaller loose ends

- **MCP tools/list caching within `withSession`** — `listTools`/`callTool` each redo a full
  `initialize` -> `notifications/initialized` handshake (PRD's "no persistence needed" for the
  session id, but it does mean every single tool CALL during a chat turn's tool loop re-initializes
  the remote server first). Fine for the bounded, few-calls-per-turn loop today; if a future tool
  loop needs many calls in one turn against the same server, batch them under one `withSession` in
  `src/conversation.ts` instead of one per `runToolCall`.
- **MCP resumable SSE streams** — the spec's `Last-Event-ID` resumability is unimplemented; a
  dropped SSE response from a remote MCP server just surfaces as an `McpError`, no retry/resume.
- **MCP first-party templates** — PRD §12's "preferred pattern: user deploys the MCP server to
  their own Cloudflare account" has no starter template yet; today the user brings their own URL.
- **Pending action results aren't re-surfaced to the assistant** — by design (keeps the tool loop
  bounded), but there's no UI nudge suggesting the user mention the outcome back in chat either.
- **Calendar/email as first-party MCP servers** — PRD §12 lists calendar (ICS) and email
  (Gmail/Graph OAuth) as *compiled-in* first-party tools, separate from the generic MCP client
  built here; those still need their own modules once scoped.
- **Manifest `screenshots`** — upgrades Android Chrome's install prompt to the rich dialog.
- **AI Gateway** — optional observability proxy; set `OPENROUTER_BASE_URL` to the gateway URL.
- **ZDR provider pin** — decided 2026-08-23 to leave `LLM_PROVIDER` empty (OpenRouter routes among ZDR endpoints); revisit when an implicit-caching ZDR endpoint appears for the model.
- **Brief narrative (LLM)** — the brief is a deterministic template today; an LLM narrative is optional.
- **Reminder UI** — list/cancel reminders in the PWA (API exists: `/api/reminders`).
- **Search includes raw notes?** — FTS currently covers organized notes only.
- **Journal: mark a raw note private after capture** — no edit path yet (raw notes are immutable by
  design; a separate `private` toggle would need a decision).

## Done

- **MCP client + bounded tool loop (§12)** — the only tool surface. `src/mcp.ts` is a dependency-free
  Streamable HTTP JSON-RPC client (`initialize`/`tools/list`/`tools/call`, JSON or SSE response,
  session id kept in memory only). `src/tools.ts` is the registry: capability tiers (`readOnlyHint`
  && `!destructiveHint` → read, everything else → act, fail safe), deterministic `tools` +
  system-prompt rendering from the D1 `schema_json` snapshot (never a live `tools/list` mid-turn),
  name mangling (`<serverId>__<toolName>`), and the `mcp_servers`/`pending_actions` tables
  (migrations/0009_mcp.sql). `src/conversation.ts#send` runs up to 4 tool-calling rounds per user
  message: read-tier tools execute immediately (SSE `tool` event); act-tier tools queue a
  `pending_actions` row and pause (SSE `confirm` event) — `POST /api/actions/:id/confirm|reject`
  (`src/routes/mcp.ts`) resolve them out of band, the result is never fed back into the
  conversation automatically. Tool-round messages live only in the in-memory request for that turn;
  `turns` only ever gets the user message and the final concatenated assistant text, so the cached
  prefix stays append-only. `src/routes/mcp.ts` is server CRUD (create does a live `tools/list`
  before saving; refresh is the only other place the snapshot changes) plus the actions queue.
  PWA: `public/chat.js` renders `tool`/`confirm` SSE events inline and a pending-actions badge;
  `public/brief.js` has an MCP servers card (enable toggle, tier breakdown, refresh/test/remove, add
  form with the PRD §12 data-disclosure line) below Passkeys.
- **ZDR provider-pinning script (§5)** — `scripts/zdr-pin.mjs` ranks a model's `GET
  /api/v1/endpoints/zdr` endpoints by blended prompt/completion price, preferring ones that report
  `supports_implicit_caching`, and prints the `LLM_PROVIDER` value to add to `wrangler.jsonc`.
  `src/llm.ts`'s `LlmConfig.provider` pins that slug into the chat request's `provider.order` with
  `allow_fallbacks: false`.

## Known constraints

- `@cloudflare/vitest-pool-workers` 0.9.14 → tests run at compat date 2025-09-01 and with
  `isolatedStorage: false` (SQLite DO `-shm` assertion). Upgrading requires vitest 4.
- Wrangler OAuth has no Zero Trust scope, so Access apps can't be scripted — why passkeys win.
- iOS: no install prompt exists; "Add to Home Screen" is the install. Web Push needs the installed app.
