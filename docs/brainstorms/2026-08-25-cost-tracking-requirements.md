---
date: 2026-08-25
topic: cost-tracking
---

# Cost Tracking: Dynamic Pricing and Effective Spend

## Summary

Dual cost accounting for the activity layer: every run keeps the backend-reported list-price reference and gains an **effective cost** — what the deployment actually pays out of pocket beyond its subscriptions — computed from per-model token usage priced through a **dynamic pricing service** that refreshes from remote data (LiteLLM's community pricing JSON + OpenRouter's models API), cached with TTL and a bundled offline snapshot. Both numbers surface in the Activity UI, the daily digest, and the agent's `query_activity` tool, with unknown always rendered as unknown — never as zero.

---

## Problem Frame

The activity layer records one `cost_usd` per run — the backend's own list-price accounting (the Claude Agent SDK's `total_cost_usd`, pi's `Usage.cost`). This number is blind to billing reality: a turn on the Max-subscription OAuth costs $0 out of pocket, while an OpenRouter or Gemini-key run is real money. The operator sees "constantly rising cost" with no way to tell reference accounting from actual incremental spend. Compounding it, the pricing knowledge that exists (the SDK's internal table) is static per release, covers only Anthropic models, and three aggregation sites already collapse unknown cost into $0 — violating the repo's own binding fail-loud decision.

The triggering question: "Am I paying for this, or is it inside my subscription?" should be answerable from the Activity surface in one glance.

---

## Actors

- A1. The operator: single self-hosting user on a Claude Max subscription plus pay-as-you-go capability keys (OpenRouter/Cerebras, Gemini, OpenAI, Deepgram), checking spend from the PWA.
- A2. Agent backends: Claude Agent SDK (ambient OAuth or declared profiles incl. OpenRouter endpoints) and pi — the producers of per-model token usage and backend-reported cost.
- A3. Scheduled jobs: cron runs reporting usage through the span-sink JSONL contract, with no backend accounting of their own beyond what the wrapper records.
- A4. The agent as consumer: answers "what did last week actually cost me?" via `query_activity`.
- A5. Remote pricing sources: LiteLLM's `model_prices_and_context_window.json` and OpenRouter's `GET /api/v1/models` — community/vendor data, unauthenticated, occasionally wrong or stale.

---

## Key Flows

- F1. Priced run
  - **Trigger:** A turn or cron run finishes.
  - **Steps:** Rollup computation reads the run's per-model token usage → classifies the run's billing mode from its resolved inference profile → subscription runs get effective cost 0 ("genuinely free"); API-billed runs get tokens priced through the pricing service → rollup row stores effective cost + billing mode + estimate flag, frozen at first successful computation.
  - **Outcome:** Every new run carries both numbers; re-rollups (sweeps, cascade closes) never silently rewrite historical spend.
  - **Covered by:** R4, R5, R6

- F2. Spend glance
  - **Trigger:** A1 opens the Activity surface (or reads the 07:30 digest, or the agent runs `query_activity`).
  - **Steps:** "Spend (7d)" shows list vs effective side by side → aggregates sum only priced runs and show the unpriced count ("≥ $X · N unpriced") → run rows render three-state cost (unknown / free / $X, with ~$X for estimates).
  - **Outcome:** Actual incremental spend is legible in one glance; unknown is never disguised as zero.
  - **Covered by:** R7, R8, R9

- F3. Pricing lifecycle
  - **Trigger:** Boot, then TTL expiry.
  - **Steps:** Service loads the disk cache (or the bundled snapshot on true cold start) → serves synchronously, never blocking on network → refreshes lazily, single-flight, keeping the last good data on any failure and surfacing staleness as state.
  - **Outcome:** Pricing follows new models and price changes without a release; offline deployments still price from the snapshot (flagged as estimate).
  - **Covered by:** R1, R2, R3

- F4. Billing override
  - **Trigger:** A1's billing reality differs from the heuristic (e.g. prepaid credits).
  - **Steps:** Settings → Models exposes a per-profile billing-mode override persisted in the settings table → future rollups classify with the override.
  - **Outcome:** Classification is correctable without code; already-frozen rollups stay as recorded.
  - **Covered by:** R10

---

## Requirements

- R1. A pricing service lives in `@schlessera/brain-ui-server` (deployment-wide, backend-agnostic), modeled on the model-discovery source: versioned JSON cache at `$BRAIN_PATH/.brain-ui/model-pricing.json`, synchronous reads that never touch the network, cold-start-only await, single-flight background refresh on TTL expiry, serve-stale-on-error with `state()` exposing freshness/error, injected fetch and clock seams for tests.
- R2. Two merged remote sources: LiteLLM's `model_prices_and_context_window.json` (per-single-token floats; input/output/cache-read/cache-write rates; bare keys for Anthropic/OpenAI, `gemini/` prefix for Gemini) and OpenRouter's `GET /api/v1/models` (string per-token prices, `vendor/model` keys; catalog price is the default provider's — `:nitro` variants have no own catalog price). OpenRouter entries win for `openrouter`-routed profiles; LiteLLM covers the rest. A bundled snapshot ships in the package as the offline/cold-start fallback.
- R3. Price resolution: exact model id → canonicalized alias (reusing the discovery canonicalization for dated Anthropic ids) → miss = unknown. A model with token usage but no resolvable rate — including a missing cache rate when cache tokens were consumed — prices the whole run as unknown (NULL), never partially or as zero. Prices from the bundled snapshot, and OpenRouter default-provider prices applied to `:nitro` variants, set an estimate flag.
- R4. Effective cost is computed inside the rollup transaction: session runs from the root span's per-model usage attribute; cron-origin runs by summing child spans (the sink contract stays unchanged — cron children are not double-counted in their root, unlike SDK subagents). Values freeze at first successful computation; later re-rollups preserve them.
- R5. Billing classification: declared profiles carrying `apiKeyEnv`/`authTokenEnv` are `api`; builtin/discovered ambient-credential profiles are `subscription` when the OAuth token is present and `ANTHROPIC_API_KEY` absent, else `api`; the settings override (R10) wins over both. The recorder receives the **resolved** profile (after pin-drop fallback), not the requested one. Cron runs classify from the server's own environment at run start.
- R6. Semantics: `effective_cost_usd` NULL = unknown; 0 = genuinely free (subscription-billed, regardless of token counts); `cost_usd` (list) stays the backend's authoritative number, with the pricing service filling it only where the backend reported none (pi without snapshots, cron runs).
- R7. Wire protocol: run summaries, rollups, aggregates, and the digest gain optional additive fields (effective cost, billing mode, estimate flag, unpriced-run count). No breaking frame changes.
- R8. Aggregation (Spend cards, day/job/session rollups, digest, `query_activity`) sums only priced runs and carries an explicit unpriced count. The three existing unknown-as-zero sites (digest sum, query rollups, activity-page cards/rows) are fixed as part of this feature.
- R9. UI: three-state cost rendering — unknown ("—"/"unpriced"), free, priced (with "~" for estimates) — on run rows, Spend cards, and the digest card; a staleness indicator on the Activity surface when the pricing cache is past TTL and refresh is failing.
- R10. Settings → Models gains a per-profile billing-mode override (`models.billing` settings key, typed accessors, REST seam mirroring the hidden-models flow).
- R11. Migration adds nullable columns to `activity_run_rollups`; existing rows stay NULL (unknown) — no backfill. New env vars (`BRAIN_UI_PRICING_*` kill switch + TTL) join the env descriptor array.
- R12. No test touches the network or needs a key; pricing fetches are fixture-injected. `query_activity`'s description documents the dual numbers and NULL semantics; if its schema is part of the compatibility contract, the contract doc rides the same commit.
- R13. Run detail (spans/events) survives a minimum retention window — `activity.retention.detailDays` in the settings table, default 7 — in addition to the digest floor: a run is detail-pruned only when the digest has covered it **and** it is older than the window (the hard ceiling still prunes regardless). Today the floor alone gates, so nightly cron runs lose detail within an hour of the morning digest while same-day session turns keep theirs — the asymmetry this fixes.
- R14. Tool-call spans record their input arguments and output payloads as span events (clipped, with an explicit truncation marker), so the Activity drill-in can expand a tool call the way the chat timeline can. Applies to session-origin recording (the recorder observes the frames that carry payloads); the bounded event size rides the existing event chunking, and the detail-retention window (R13) bounds storage. Cron/sink-origin payload capture is a wrapper-side follow-up, not part of this.

---

## Acceptance Examples

- AE1. A cron `sync` run on the subscription-billed default profile finishes with 2M cache-read tokens: rollup shows list cost from the wrapper's accounting, effective cost **$0.00 (free)** — not NULL, not the cache-read price.
- AE2. A turn on the `openrouter-glm` profile consumes 100k input / 5k output tokens: effective cost = the OpenRouter catalog rate × tokens, flagged **estimate** (nitro variant), shown as "~$X".
- AE3. A run on a model absent from both sources: effective cost renders "—", the 7d Spend card shows "≥ $X · 1 unpriced", and the digest reports the unpriced count — nowhere does a $0 appear for it.
- AE4. The server boots with no network: pricing serves from the bundled snapshot, runs price normally but flagged estimate, and the Activity header shows the staleness indicator once TTL has lapsed with refresh failing.
- AE5. A stale sweep re-rolls a run three days after a pricing refresh changed rates: the run's effective cost is unchanged (frozen at first computation).
- AE6. A nightly cron run's full span tree is still viewable in the Activity surface five days later (default window), even though the digest covered it the same morning; at day 8 only the rollup remains.
- AE7. Expanding a tool call in the Activity drill-in (subagent view or run detail) for a session run recorded after this ships shows its input arguments and output payload, clipped at the cap with a visible truncation marker; a pre-feature run's tool calls state that no payload was recorded rather than offering an empty expander.

---

## Scope Boundaries

- Deepgram voice and image-API (Gemini/OpenAI capability key) spend — not in the span/usage system; a later feature can record them as runs.
- Exact OpenRouter per-generation accounting (their generation endpoint returns real routed cost) — v2 candidate; v1 flags nitro prices as estimates.
- Backfilling historical rollups — pre-feature rows have no per-model breakdown; they stay unknown.
- Budget alerts/limits on effective spend — future; the notification-intent layer is the obvious seam when wanted.
- Long-context (>200k) and 1h-cache pricing tiers — v1 prices with the base rates; the LiteLLM fields exist if a tier-aware v2 wants them.

---

## Key Decisions

- **Effective cost freezes at first computation.** Re-rollups happen on sweeps and cascade closes; recomputing against refreshed prices would silently rewrite history. (Q1 of the flow analysis; default accepted.)
- **Cron runs price by child-span sum, not a sink contract change.** The sink's one-model-per-span shape stays; cron children aren't double-counted in the root, so summing them is safe where it isn't for SDK subagents. (Q2; default accepted.)
- **The backend's reported cost stays "list".** LiteLLM recomputation would contradict it (different tables, drift); the service only fills gaps. (Q3; default accepted.)
- **Aggregates are sum-of-knowns plus an unpriced count.** Extends the binding unknown≠0 decision to the aggregation layer, and keeps the deploy-week Spend card honest when most rows are pre-feature NULLs. (Q4; default accepted.)
- **Missing cache rate → whole run unknown.** Cache reads dominate Claude usage; pricing them at zero or input-rate would understate real spend by a large factor. (Q5; default accepted.)
- **Estimate flag: bundled-fallback yes, within-TTL stale no.** Serve-stale is normal operation; the snapshot shipped at build time is genuinely dated. (Q7; default accepted.)
- **Detail retention decouples from digest coverage.** The digest floor was designed as "safe to prune once summarized", but summarization is not the only reader — drill-in debugging of a nightly job needs the span tree days later. The window ANDs with the floor (never prune what the digest hasn't covered), and the hard ceiling stays the independent backstop.
- **Pricing service lives in ui-server, not a backend package.** Billing is a deployment property spanning backends and cron; model discovery stayed in ui-backend-claude because it is Anthropic-credential-bound — pricing is not.

---

## Outstanding Questions

None blocking. Deferred to implementation: exact settings-key shape for per-profile overrides; whether the pricing state is exposed on `/api/models` or its own route; LiteLLM entry validation depth (the source has known cross-key drift — v1 validates shape and positivity, not cross-checks).
