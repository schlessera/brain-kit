---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Agent observability: a full activity layer across the stack.

- **Activity record** (ui-server): an OTel-GenAI-aligned span store in the
  server SQLite records every turn, tool call, subagent run and cron run as
  a tree — written at start, closed write-once with a six-outcome taxonomy
  (`denied` and `interrupted` are first-class), with boot/staleness sweepers
  (heartbeat-keyed), a stuck-run watchdog, per-run rollups that survive
  pruning forever, and a digest-floor + hard-ceiling retention policy.
- **Wire protocol** (ui-sdk, rev 3 additive): view-scoped
  `activity_subscribe`/`activity_snapshot`/`activity_delta` frames with a
  seq-discard ordering contract, a `usage` block (per-model token/cost
  breakdown) on `result`, and subagent linkage (`parentToolUseId`) on tool
  frames. `server_hello` advertises `capabilities.activity`.
- **Backends**: the Claude adapter stops flattening subagent activity
  (task lifecycle, per-subagent usage, forwarded transcripts to the new
  bridge side channel; `forwardSubagentText` on; SDK floor 0.3.241) and
  reports full `modelUsage`; the pi backend reports per-turn token usage
  from its event stream. The new read-only `mcp__brain-ui__query_activity`
  tool lets the agent answer "what ran / what is running?" from the record.
- **UI** (ui-react): live subagent rows with a stacked drill-in view
  (observation-shaped; approvals actionable there and in the chat), one
  server clock for live and reloaded duration badges, and a first-class
  Activity surface — live runs, history, rollup cards, failure inbox with
  nav badges, a while-you-were-away digest card, and a three-state web-push
  toggle. Activity takes the mobile tab-bar slot; Graph moves to More.
- **Notifications** (ui-server): persisted intents (at-least-once, storm-
  capped, watched-suppressed) with an in-app inbox as the guaranteed tier
  and web push (generated VAPID keys in a secret-classified table,
  per-device subscriptions, minimized payloads, 404/410 pruning) on top.
- `getCronStatus` now lists every recorded job name, closing the gap that
  hid module jobs from `/api/status`; the sessions listing merges stored
  cost accounting over backend zeros.
