# Orla

Orla is a truly personal AI assistant that lives on Cloudflare's edge: no server to maintain, no company holding your journal. Capture messy notes instantly from a PWA; Orla reorganizes them overnight, briefs you every morning, and remembers what matters. Costs almost nothing while idle. Named for the orle, the border at the shield's edge.

## Model & provider

The LLM is OpenRouter-only, and both the model and the routed provider are config, not code:

- **Model** — `LLM_MODEL` (interactive chat) and `LLM_MODEL_BATCH` (nightly reorganization, PRD §5) are `vars` in `wrangler.jsonc`. Swap either at any time; nothing else in the Worker changes.
- **ZDR enforcement** — every chat request sets `provider.zdr: true`, so OpenRouter only ever routes to Zero Data Retention endpoints, regardless of which provider is pinned.
- **Provider pin** — `LLM_PROVIDER` (also a `wrangler.jsonc` var, optional) pins a specific ZDR provider slug into `provider.order` with `allow_fallbacks: false`, instead of leaving the choice to OpenRouter on every request. Pick it with:

  ```sh
  export OPENROUTER_API_KEY=sk-or-...   # not read from .dev.vars
  npm run zdr-pin -- deepseek/deepseek-v4-flash-0731
  ```

  This calls `GET /api/v1/endpoints/zdr`, keeps the endpoints that report `supports_implicit_caching` (falling back to all ZDR endpoints for that model if none do), ranks the rest by a prompt-heavy blended price (80% prompt / 20% completion — chat turns are mostly cached history, not generated output), and prints the exact line to paste into `wrangler.jsonc`'s `vars`:

  ```jsonc
  "LLM_PROVIDER": "<provider-slug>"
  ```

  Add `--json` for machine-readable output (used by the F8 installer). Leaving `LLM_PROVIDER` unset is safe — requests still enforce ZDR, just without a pinned provider.
- **Drift** — the cost dashboard (F6) logs `cached_tokens` and cost per call from D1, so if the routed provider's pricing or caching support drifts, it shows up there; re-run the pin script and update the var.
