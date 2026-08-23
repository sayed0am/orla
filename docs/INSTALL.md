# Installing Orla

Orla is fully self-hosted: the installer deploys everything into *your own* Cloudflare and
OpenRouter accounts. There is no shared Orla service, no central database — the project never
holds anyone's data (PRD G7).

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free plan is enough — see
  [Costs](#costs) below). **Turn on hardware-key two-factor authentication** on this account
  before installing (PRD §7); the installer cannot do this for you.
- An [OpenRouter account](https://openrouter.ai) with a little credit and an API key. After
  creating the key, go to **Settings → Privacy** (<https://openrouter.ai/settings/privacy>) and
  turn on **Zero Data Retention**, and disable logging/training. Orla enforces ZDR-only routing
  on every request it sends, but that only protects you if ZDR is actually enabled on your
  account — the installer cannot do this for you either.
- Node.js 20 or later, and `git`, on the machine you run the installer from (not required
  afterwards — Orla runs entirely on Cloudflare's edge once deployed).

## Install

```sh
npm create orla@latest
```

This clones the Orla repo, walks you through a few prompts (assistant name, Worker name,
OpenRouter key, notification email), and provisions everything via `wrangler`:

1. Logs in to Cloudflare (`wrangler login`, opens a browser) if you aren't already.
2. Clones the repo into `./orla`.
3. Creates a D1 database and writes its ID into `wrangler.jsonc`.
4. Uploads three secrets to the Worker: `OPENROUTER_API_KEY`, `VAPID_PRIVATE_KEY` (for push
   notifications), and `SESSION_SECRET` (signs the passkey session cookie).
5. Runs `npm ci`, applies the D1 migrations, and deploys.
6. Prints your Worker's URL.

Run with `--dry-run` to print every command it would run without executing any of them, or
`--help` for the full flag list (`--yes`, `--ref`, `--dir`, `--from <step>`).

If a step fails partway through, re-run with `npx create-orla --from <step>` (the failure message
prints the exact command) instead of starting over.

## What it creates in your account

| Resource | Purpose |
|---|---|
| 1 Worker | Runs the app (routes, cron triggers) |
| 1 D1 database | All your notes, conversations, and settings |
| 2 Durable Object classes | `Conversation` (per-chat state), `Scheduler` (reminders) |
| 2 Cron triggers | Nightly reorganization (03:00 UTC), morning brief (06:00 UTC) |
| 3 secrets | `OPENROUTER_API_KEY`, `VAPID_PRIVATE_KEY`, `SESSION_SECRET` |

## First use

Open the printed URL on your phone:

1. **Create a passkey.** The first passkey registered becomes the owner — there is no separate
   signup step, and no password.
2. **Add to Home Screen.** This is how the PWA installs on iOS and Android; there's no app-store
   listing.
3. Open **Brief** and enable morning push notifications.

## Costs

Idle cost is close to $0. Workers and D1 both have free tiers that comfortably cover personal
use (Workers: 100k requests/day free; D1: 5 GB storage / 5M rows read per day free); the only
recurring cost that scales with use is OpenRouter LLM spend, which is visible in-app under
**Costs** and is typically well under $5/month for daily personal use (PRD §10).

## Updating

```sh
cd orla && git pull && npm ci && npx wrangler d1 migrations apply orla --remote && npx wrangler deploy
```

(substitute your Worker/database name if you changed it from the default `orla` during install).

## Uninstalling

```sh
npx wrangler delete          # deletes the Worker
npx wrangler d1 delete orla  # deletes the D1 database and all its data — irreversible
```

Deleting the D1 database permanently removes every note, conversation, and memory fact stored in
it. There is no recovery once this is run.

## Privacy model

- Everything lives in *your* Cloudflare account and *your* OpenRouter account — this project
  holds none of it.
- **Zero Data Retention (ZDR) covers inference only.** Every chat and reorganization request sets
  `provider.zdr: true`, so OpenRouter only routes to providers that don't retain your prompts —
  but this only takes effect once you've enabled ZDR in your own OpenRouter account settings (see
  Prerequisites above).
- **MCP servers have their own policies.** If you connect a remote MCP server (e.g. calendar or
  email), that server processes whatever data you allow it to under its own privacy policy — ZDR
  routing does not extend to it. The app shows a plain-language disclosure before you connect one.
