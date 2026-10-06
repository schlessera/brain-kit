# Decision — dynamic pricing and effective cost

Why a run carries both a list price and an effective cost, and why unknown cost
is never rendered as zero. Shipped in 0.22.0; this is the design record, not a
status file.

Route-aware price resolution shipped as a follow-up (#57) and is recorded
below. One follow-up from this work is still open and tracked in the issue
tracker: exact per-generation accounting for OpenRouter.
## Summary

Build a TTL-cached, remote-refreshed model-pricing service in `ui-server` (mirroring the model-discovery source shape), classify every run's billing mode from its resolved inference profile, compute a frozen `effective_cost_usd` inside the rollup transaction, and surface dual cost (list vs effective, with explicit unknown counts) through the wire protocol, Activity UI, daily digest, and `query_activity` — while fixing the three existing sites that render unknown cost as $0. Rides along: a minimum detail-retention window so nightly cron runs stay drillable instead of losing their span trees to the morning digest's prune (U7).

---

## Problem Frame

Runs record only backend list-price accounting; subscription-billed work is indistinguishable from real pay-as-you-go spend, and unknown cost already collapses to $0 in three aggregation sites. See origin for the full frame.

---

## Scope Boundaries

- Deepgram voice / image-API spend (not in the span system)
- Exact OpenRouter per-generation accounting (v2; nitro prices flagged estimate in v1)
- Historical rollup backfill (pre-feature rows stay unknown)
- Budget alerts on effective spend
- Long-context / 1h-cache pricing tiers (base rates in v1)

### Deferred to Follow-Up Work

- ~~Provider-route-aware price selection~~ — **shipped in #57**, see below.
- The initial design relied on cron environment classification. #293 removes that assumption; the recorded-billing rule below supersedes it.

---

## Key Technical Decisions

- **Service in `ui-server`, not `ui-backend-claude`**: billing is a deployment property spanning backends and cron; discovery stayed backend-side only because it is Anthropic-credential-bound. (see origin)
- **Freeze-on-first-computation** via COALESCE-preserving upsert of the new columns: re-rollups (sweeps, cascade closes) must not silently reprice history. (origin Key Decisions / AE5)
- **Cron child-sum instead of a sink contract change**: keeps the span-sink JSONL shape stable (it ships first, per its own discipline) and is double-count-safe for cron origins.
- **Backend cost stays authoritative "list"**; the service fills `cost_usd` only when the backend reported none — two disagreeing numbers on one run would be worse than a gap.
- **Billing mode resolves at run start and rides the root span** (attr + profile id): the rollup then reads it locally, keeping `rollupRunInTx` free of registry/service lookups except the pure pricing table read.
- **Aggregates carry `unpricedRuns`**: sum-of-knowns everywhere; the UI and digest render "≥ $X · N unpriced" whenever the count is nonzero.
- **Missing cache rate → whole run unknown**: cache reads dominate Claude usage; partial pricing would systematically understate. (origin AE-relevant decision)
- **Price by route, not by model id** (#57): the two catalogs carry some of the
  same ids at different rates — OpenRouter resells what the model vendor also
  sells directly — so an id does not identify its own price. The backend
  classifies each profile's route (`classifyRoute`, beside `classifyBilling`),
  it rides the root span as `brain.pricing_route` exactly as billing does, and
  `resolve(modelId, route)` reads the billing catalog first. Three properties
  hold it together: an unknown route resolves as it did before routes existed
  (OpenRouter leads) rather than going unpriced; a rate borrowed from the
  catalog the run did *not* go through still prices the run but is flagged
  `estimate`; and there is deliberately **no ambient route fallback** — this
  process's environment says nothing about which endpoint another
  backend's turn went out on, and a guessed route would freeze the wrong
  catalog's rate into the rollup.
- **Route awareness and exact OpenRouter accounting were separated** (#57): the
  plan paired them, but they turn out to be independent. Route awareness picks
  which list-price table to read and is fully testable against fixtures;
  per-generation accounting replaces list-price math with amounts fetched from
  OpenRouter's generation API, which needs a live key and a network call. The
  first has no dependency on the second, so it shipped alone.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart LR
  subgraph remote [Remote, TTL-refreshed]
    LL[LiteLLM prices JSON]
    OR[OpenRouter /models]
  end
  subgraph server [ui-server]
    PS[pricing service<br/>cache + snapshot fallback<br/>sync reads, single-flight]
    RS[run-session<br/>resolved profile → billing mode]
    REC[recorder<br/>root attrs: per-model usage,<br/>profile, billing mode]
    RU[rollupRunInTx<br/>price + freeze<br/>effective_cost_usd]
    AGG[routes/digest/query<br/>sum-of-knowns + unpriced count]
  end
  UI[Activity UI<br/>list vs effective,<br/>3-state rendering]
  LL --> PS
  OR --> PS
  RS --> REC --> RU
  PS --> RU
  RU --> AGG --> UI
```

Initial billing mode decision (superseded by #253 and #293 below): declared profile with `apiKeyEnv`/`authTokenEnv` → `api`; ambient profile → `subscription` iff OAuth present and no `ANTHROPIC_API_KEY`; settings override wins over both.

---

## System-Wide Impact

- **Interaction graph:** rollup writes now consult the pricing service (pure in-memory read inside the tx); run-session → recorder gains profile/billing pass-through; WS snapshot/delta and REST widen additively — old clients ignore the new optional fields
- **Error propagation:** pricing failures degrade to state, never into the rollup transaction or a request path; a disabled/cold service yields NULL effective cost, which every surface renders as unknown
- **State lifecycle risks:** freeze semantics guard against sweep-driven repricing; the settings override deliberately affects only future rollups (frozen history documented)
- **API surface parity:** query_activity, REST rollups, WS frames, and the digest all gain the same triple — one surface lagging would resurrect the unknown-as-zero bug there
- **Integration coverage:** migration-on-existing-DB, explicit/unknown cron-origin billing, and the digest-window-straddling-deploy case are the cross-layer scenarios unit tests alone won't prove
- **Unchanged invariants:** `cost_usd` remains backend-authoritative; the span-sink JSONL contract is untouched; rollup root-span-only aggregation stands (cron child-sum is an origin-scoped exception, not a new rule); rollups still outlive detail forever. Retention changes in exactly one way (U7): the detail-prune predicate gains a minimum-age AND-condition — the digest floor's never-prune-uncovered guarantee and the hard ceiling's independence both stand

---

## Sources & References

- **Origin:** a requirements pass on 2026-08-25, not kept — this record is what survived it.
- Related code: `packages/ui-backend-claude/src/model-discovery.ts`, `packages/ui-server/src/activity/store.ts`, `packages/ui-server/src/activity/recorder.ts`
- Related: [agent-observability.md](agent-observability.md) — the layer this extends.
- External: LiteLLM `model_prices_and_context_window.json` (raw.githubusercontent.com/BerriAI/litellm/main/…), OpenRouter `GET /api/v1/models`

## Recorded billing is the rollup source of truth (#293)

The maintainer chose this rule on 2026-09-30: only a valid
`brain.billing_mode` on the root span establishes a run's billing. Every
origin, including cron, stays unknown without it. The previous environment
fallback could label a subscription-enforced Claude child as API-billed after
#253 cleared that child's API credentials; other runners may use entirely
different credentials. Observing a runtime name/version does not establish
billing, and a sync that invokes no agent may still pay for judge/enrichment
calls. No runner, version or no-agent heuristic replaces the fallback.

Unknown billing leaves effective cost and its estimate flag null. List-price
math and authoritative backend cost remain available independently; aggregates
exclude unknown effective costs from their sum and count the runs as unpriced.
Explicit valid subscription/API classifications keep their existing behavior.
The rollup reads the root attribute and prices child usage for cron locally
(`const attrBilling`, `packages/ui-server/src/activity/store.ts:526-527`).

This is a change to the evidence used for new computations, not a historical
backfill. First non-null billing, list cost, effective cost and estimate values
remain frozen. Later valid evidence may fill still-null slots; an effective
cost/estimate fill must agree with any frozen billing classification
(`upsertRollup`, `packages/ui-server/src/activity/sql.ts:19-50`). Recorded
history is never silently rewritten from the current server environment.
