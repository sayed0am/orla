# Orla — Phase 1 implementation plan

Derived from `personal-assistant-prd.md` §5 and §9. Phase 1 exit: *I chat with it and capture notes daily.*

## Toolchain (frozen)

| Package | Version | Notes |
|---|---|---|
| wrangler | 4.125.0 | deploy/dev; bundles workerd 1.20260820 |
| typescript | 5.9.3 | |
| @biomejs/biome | 2.5.10 | lint + format (tabs, 100 cols) |
| @cloudflare/vitest-pool-workers | 0.9.14 | pins its own miniflare 4.20251011 / wrangler 4.44 |
| vitest | 3.2.7 | last 3.x; pool 0.9 peer range is `2.0.x - 3.2.x` |
| react | 19.2.8 | added 2026-08-24 — see toolchain amendment below |
| react-dom | 19.2.8 | added 2026-08-24 |
| vite | 6.4.3 | added 2026-08-24; builds `app/` to `dist/` |
| @vitejs/plugin-react | 4.7.0 | added 2026-08-24 |
| @types/react | 19.2.18 | added 2026-08-24 |
| @types/react-dom | 19.2.5 | added 2026-08-24 |

Exact versions are pinned in `package.json` and `.npmrc` has `save-exact=true`. Upgrading the pool to
≥0.10 requires vitest 4 (see `npm view @cloudflare/vitest-pool-workers peerDependencies`).

**Toolchain amendment (2026-08-24):** the frontend moved from the plain TS/HTML shell in step 7
below to Vite + React (`app/`, builds to `dist/`, served by wrangler's assets binding). Driven by
the design revamp plus the maintainability cost of the imperative-DOM `public/` shell, which had
grown to ~5k lines (`brief.js` alone was 1.4k lines). `public/` is retired; see NOTES.md for the
dev-loop and service-worker details this introduced.

Known constraint: tests run at `compatibilityDate: 2025-09-01` (see `vitest.config.ts`) because the
pinned pool's workerd fails with `nodejs_compat` at newer dates. Deploy uses `wrangler.jsonc`'s date.

## Commands

- `npm run dev` / `npm run deploy` / `npm run types` (regenerates `worker-configuration.d.ts`)
- `npm run check` — tsc for `src/` and `test/`
- `npm run lint` / `npm run format`
- `npm test`

## Milestone steps

1. **Provision** — D1 `orla` created (binding `ORLA_DB`);
   `wrangler secret put OPENROUTER_API_KEY`; `wrangler d1 migrations apply orla`.
2. **D1 schema** — `migrations/0001_init.sql` has `raw_notes` and `llm_calls`. Add `conversations`,
   `organized_notes`, `action_items`, `memory_facts` (Option A) as they are needed; keep `raw_notes`
   append-only.
3. **Auth** — Cloudflare Access in front of the Worker first (zero code; verify the `CF-Access-JWT-Assertion`
   header). Passkeys later if Access proves awkward on mobile.
4. **Capture API (F2)** — `POST /api/notes` → insert into `raw_notes`; no LLM on the write path.
5. **Conversation DO (F1)** — `src/conversation.ts`: SQLite-backed turn history, one OpenRouter
   `session_id` per DO, `POST /api/conversations/:id/messages` → SSE stream. Prompt builder in
   `src/prompt.ts` ordered static system → memory block → history → dynamic tail; `cache_control`
   breakpoints; no timestamps in the prefix.
6. **OpenRouter client** — `src/llm.ts` via AI Gateway URL; log `prompt_tokens` / `cached_tokens` /
   `completion_tokens` / cost to `llm_calls` on every call.
7. **PWA shell** — `public/`: manifest, service worker (offline capture queue → background sync),
   chat view, capture box. Plain TS/HTML, no framework until a real need appears.
   (Superseded 2026-08-24 — see the toolchain amendment above: `public/` was retired for a Vite +
   React `app/`.)
8. **Tests** — pool-based integration tests per route; D1 migrations applied in `vitest.config.ts`
   setup once the schema stabilises.

Phase 2 (cron handlers in `src/index.ts` are stubbed: `0 3 * * *` reorganize, `0 6 * * *` brief)
starts only after Phase 1 is in daily use.

## Decisions that override the PRD

- **No first-party calendar or email readers** (PRD §12 listed ICS and Gmail/Graph as compiled-in).
  Decided 2026-08-22: calendar and email are consumed as remote MCP servers like everything else.
  The only tool surface is the MCP client (P2); the morning brief's calendar section waits for it.
- **Auth end state is passkeys, not Access** (decided 2026-08-22). Wrangler's OAuth has no
  Zero Trust scope (`wrangler login --scopes-list`), so a one-line installer (F8) cannot create an
  Access application. Phase 1 keeps the Cloudflare Access gate (manual dashboard setup, ~5 min);
  Phase 3 replaces `src/auth.ts` with WebAuthn passkeys + a `credentials` table so install needs
  no dashboard steps. Routes only call `requireAuth`, so the swap is contained to that file.

## Phase 2 status (2026-08-22)

| Feature | Status | Notes |
|---|---|---|
| F3 nightly reorganization | done | `POST /api/reorganize/run` to backfill; quarantine + 3-strike give-up |
| F4 morning brief + Web Push | done | deterministic brief, no LLM; VAPID keys via `npm run vapid` |
| F6 cost dashboard | done | Costs tab |
| F7 journal views | done | FTS5 over organized notes; export |
| F5 reminders | done | Scheduler DO alarm, chat "remind me…" pre-step |
| Memory Option A | done | nightly pass proposes, user confirms; active facts only in prefix, 1500-char cap |

Deploy checklist after pulling: `npm run vapid` → public key into `wrangler.jsonc`, private via
`wrangler secret put VAPID_PRIVATE_KEY`; `wrangler d1 migrations apply orla --remote`; `wrangler deploy`.

Loose ends closed 2026-08-23: history compaction (§5), Markdown export (§7), "Organize notes now"
button. Still open: ZDR provider-pinning script (§5), manifest screenshots, AI Gateway (optional).
