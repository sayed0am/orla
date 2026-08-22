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

Exact versions are pinned in `package.json` and `.npmrc` has `save-exact=true`. Upgrading the pool to
≥0.10 requires vitest 4 (see `npm view @cloudflare/vitest-pool-workers peerDependencies`).

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
8. **Tests** — pool-based integration tests per route; D1 migrations applied in `vitest.config.ts`
   setup once the schema stabilises.

Phase 2 (cron handlers in `src/index.ts` are stubbed: `0 3 * * *` reorganize, `0 6 * * *` brief)
starts only after Phase 1 is in daily use.

## Decisions that override the PRD

- **No first-party calendar or email readers** (PRD §12 listed ICS and Gmail/Graph as compiled-in).
  Decided 2026-08-22: calendar and email are consumed as remote MCP servers like everything else.
  The only tool surface is the MCP client (P2); the morning brief's calendar section waits for it.
