---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
---

Cost tracking: dynamic pricing and effective spend, plus activity-detail quality-of-life.

- **Dynamic model pricing** (ui-server): a TTL-cached pricing service merging
  LiteLLM's community price table with OpenRouter's live catalog, cached at
  `$BRAIN_PATH/.brain-ui/model-pricing.json` with a bundled offline snapshot;
  `BRAIN_UI_PRICING_DISCOVERY` / `BRAIN_UI_PRICING_TTL_HOURS` control it.
- **Effective cost** (ui-server, migration 010): every run's rollup gains
  `effective_cost_usd` + `billing_mode` + `pricing_estimate`, computed inside
  the rollup transaction and frozen at first computation. Subscription-billed
  runs (ambient OAuth) are $0 out of pocket; API-key/OpenRouter runs are
  priced from per-model token usage. Unknown stays NULL — never $0.
- **Billing classification** (ui-server): resolved per inference profile at
  run start (declared-credential profiles → api; ambient → subscription iff
  the OAuth token is the credential), overridable per profile from
  Settings → Models (`PUT /api/models/billing`).
- **Dual-cost surfaces**: Activity spend cards, day/job/session rollups, the
  daily digest, and `query_activity` all carry effective cost plus an
  explicit unpriced-run count ("≥ $X · N unpriced"); run rows render
  three-state cost (unknown / free / priced, "~" for estimates); a staleness
  indicator appears when pricing refresh is failing (`GET /api/models/pricing`).
- **Detail retention window** (ui-server): span trees survive at least
  `activity.retention.detailDays` (default 7) instead of dying at the next
  morning digest — nightly cron runs stay drillable.
- **Tool I/O capture**: tool calls record clipped input/output payloads as
  span events, expandable in the Activity drill-in (subagent view and run
  detail); pre-capture runs state that no payload was recorded.
