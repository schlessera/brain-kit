---
date: 2026-08-26
topic: async-collaboration
plan: async-collaboration.md
revision: 2
---

# Async Collaboration: Queue and Actions

## Summary

A two-sided asynchronous work loop between the user and the brain agent, built on one
durable item store with two views. The **Queue** holds work the agent should do; **Actions**
holds decisions only the user can make. Work arrives from outside (shares, CLI, later
email), is drained by an in-server scheduler through a cost-tiered triage pipeline, and
escalates to Actions whenever the agent's authority or judgment runs out. Resolving an
Action applies a validated effect and, where applicable, mints the follow-up work from a
spec stored at escalation time — no model call. Repeated decisions become standing
**policies** in the brain repo in v2; v1 records feedback without creating standing
authority.

The feature generalizes two things that already exist: `bridge.requestPermission` (a
decision request with no answer when nobody is watching) and the Activity failure inbox
(a human-facing queue of things that went wrong).

**Revision 2** folds in an independent review (gpt-5.6-sol, read-only, against the code).
Three findings changed the design rather than adding detail to it: the restricted execution
profile R28 depends on **does not exist in the backend today** and is a build item, not a
configuration; the policy write path is **reopened by any ordinary interactive turn**, so
notify-on-change is not sufficient and unexpected policy content must be quarantined; and
model-authored `state_md` plus model-authored follow-up payloads form a **confused-deputy
escalation** unless trust class is server-owned and immutable per thread. The item state
model, the budget enforcement point, and the follow-up representation were also wrong in
revision 1 and are replaced here.

---

## Problem Frame

Collaboration with the agent is currently synchronous-only. The user must be present in a
chat session for the agent to ask anything, and the agent must finish or fail inside that
session. Three consequences:

1. **Background work cannot ask.** Cron runs (`sync`, `validate`, `maintain`, module jobs)
   have no human attached. `bridge.requestPermission` parks a promise that nobody will
   resolve (`requestPermission: (req) => {`, `packages/ui-server/src/ws/bridge.ts:138-229`), so autonomous work is confined to
   whatever is pre-approved, and anything requiring judgment is not attempted.
2. **Inbound material has no path.** A forwarded email, a shared link, a captured note has
   nowhere to land that the agent will act on later. The PWA share target stages into
   `.brain-ui/inbox/<id>/` and waits for a tap in a live session.
3. **Nothing accumulates.** Every decision is made fresh in a session and then lost. The
   same class of question is asked again next week at full cost.

The hygiene skill (`context/hygiene/{open,snoozed,resolved}.md`) is the closest prior art
and demonstrates the shape works: stable IDs, hand-editable, snooze by moving an entry,
resolved entries not re-raised. Deterministic hygiene reconciliation/listing, briefing and weekly scheduling now
exist (#395–#397); they do not provide the durable agent queue/Action transport.
#597 owns hygiene-specific selection/disposition semantics; reuse these primitives.

Single self-hosting user, phone-first for the Actions view. Cost matters: autonomous work
competes with interactive use for the same subscription credit.

---

## Actors

- A1. **The user** — resolves Actions, usually from a phone, in seconds per item. Also the
  operator. Existing server authentication still binds and revokes distinct credentials/principals.
- A2. **The drain** — the in-server ticking loop that claims ready Queue items, runs triage,
  and dispatches agent runs.
- A3. **The autonomous agent** — headless runs working Queue items under a restricted
  execution profile, with no human attached.
- A4. **The interactive agent** — an ordinary session, minted on demand when the user accepts
  a `discuss` Action.
- A5. **Intake sources** — the PWA share target and the `brain` CLI in v1; DKIM-verified
  approved senders over email in v2. All produce content the system treats as untrusted.

---

## Naming

`inbox` is taken twice already — `.brain-ui/inbox/` is share staging, and `notes/` is
described as the ingestion inbox in the brain repo's own instructions. This feature uses
**Intake** (untrusted arrivals, staged, not yet work), **Queue** (agent work items), and
**Actions** (user decisions). "Inbox" is not used as a surface name anywhere.

---

## Trust Model

Stated before the requirements because five of them derive from it.

- **T1. Trust class is a property of the source, assigned server-side, immutable for the
  life of the thread.** `trusted` (the user's own CLI invocation) or `untrusted` (everything
  that arrived from outside, including every v1 share). It is never present in any
  model-authored payload schema, and no model output can change it. The share manifest
  has its source selected server-side
  (`const result = await stageShareAt(`, `packages/ui-server/src/inbox/intake.ts:86`); this generalizes that.
- **T2. Model output is data, never authority.** `state_md`, T1 classifications, and
  follow-up payloads are authored by a model that has read attacker-controllable text. They
  may describe, request, and summarize. They may not select a tool profile, widen a
  capability, set a priority above a ceiling, or name a path outside the thread's envelope.
- **T3. A capability is minted per operation, never per role.** When the user approves an
  escalated action, the resulting run receives permission for *that operation on that path*,
  not a general elevation. The user is shown the exact effect — tool, input, target path —
  not only the option label.
- **T4. The trusted computing base is the server.** Every privileged write (policy files,
  trust class, capability grants, budget settlement) is performed by server code, never by
  an agent holding file tools.

---

## Key Flows

- **F1. Arrival → work.** A share or `brain queue add` stages bytes and creates a thread with
  a server-assigned `trust_class`, plus one Queue item of type `triage`. T0 triage
  (deterministic, zero tokens) drops duplicates on `dedup_key` and known noise.
- **F2. Drain.** The loop ticks; a SQL check for `ready` items gates everything — no ready
  item means no model call and no Activity run. Ready items are claimed under a lease and a
  budget reservation, batched into a T1 classification call, and routed: rule-satisfiable,
  needs a T2 agent run, or needs the user.
- **F3. Escalation.** An autonomous run reaches its authority boundary. It **checkpoints**
  (server-side, before the permission gate blocks), the server atomically creates the Action
  with its resolution effects, marks the Queue item `blocked`, unwinds the turn without parking for a human.
- **F4. Resolution.** The user taps an option. In one transaction the server records the
  resolution, applies the option's validated `resolution_effect`, transitions the blocked
  Queue item to `superseded`, and — for `enqueue` effects only — mints exactly one follow-up
  item with a dedup key derived from `(action_id, option_id)`. No model call. A fresh
  autonomous run later executes it under a capability minted for that operation.
- **F5. Later.** Snooze sets `wait_until` by deterministic rule. Premise revalidation on resurface is deferred to v2.
- **F6. Dismiss.** Records `dismissed` with an optional one-tap reason, writes a suppression
  record, and returns the outcome to the thread as data.
- **F7. Discuss** *(deferred)*. An accepted `discuss` Action mints a session seeded with the thread's
  derived state and run digest. The session carries `resolve_action`; the item is its
  contract.
- **F8. Policy formation** *(v2)*. The agent proposes; the proposal is an Action; the user's
  tap causes the **server** to write the policy file and record its expected hash. The agent
  never writes it.
- **F9. Closure.** Completed work files an `fyi`, which needs no response, does not count
  against the Actions cap, and is swept into the existing digest.

---

## Requirements

### Storage and model

- R1. Next-unused, append-only migrations add `inbox_threads`, `inbox_items`, `inbox_changes`, and
  `inbox_suppressions`. `inbox_changes(change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id, item_id, seq)` **carries `thread_id` explicitly** — activity stores its scope
  in the change row for exactly this reason
  ((`CREATE TABLE IF NOT EXISTS activity_changes (`, `packages/ui-server/migrations/007_activity.sql:58-66`),
  (`snapshotRun(runId) {`, `packages/ui-server/src/activity/store.ts:810-839`)), and deriving scope through a join on a
  mutable item is weaker and breaks tombstones. `change_id` is the global cursor, `seq` is
  per-thread order. Append-only checkpoints, unique resolution records, scheduler
  heartbeats and budget reservations also need explicit durable storage. The four
  named tables are not a sufficient schema. Choose ordinals at implementation
  time; current migrations extend through 019, with 011/012 already occupied.
- R2. What is reused from activity is the **cursor algorithm and the snapshot-then-delta
  contract**, not the stream module: `activity/stream.ts` is bound to activity-specific store
  methods and frame types. The inbox needs its own store with atomic item+change writes
  through one shared path, and a single-transaction snapshot with per-thread high-water
  marks.
- R3. **Threads are the context unit** and carry `trust_class` (T1), `state_md`, priority,
  source, and lifecycle status.
- R4. **`state_md` is derived, not authoritative.** Runs append immutable checkpoint events;
  `state_md` is a compact projection of them maintained for prompting. A mutable
  model-authored blob cannot be the audit record — the agent could overwrite history, omit a
  run, or carry injected instructions forward as "findings". Provenance and trust labels live
  in columns, never inside model-authored Markdown.
- R5. A fresh autonomous run's inbound context is: the derived state projection, the item
  payload, the resolved decision if any, the minted capability, remaining budget, attempt
  metadata, and (v2) the policy digest. Revision 1's "only `state_md`" was wrong. Everything
  dynamic in that list sits **after** the cache boundary (R44).
- R6. **Intake is not a separate table.** An arrival is a thread plus one `triage` Queue item;
  the bytes live in the staging directory. This removes a table and makes AE1 expressible.
- R7. **Two state machines**, not one chain.
  - Queue: `scheduled → ready → claimed → (done | blocked | failed | superseded | expired |
    dropped)`, with `claimed → ready` on lease expiry, `failed → ready` on retry backoff,
    `blocked → superseded` on resolution, `scheduled → expired` and `ready → expired` on
    deadline.
  - Actions: `pending → (snoozed ⇄ pending) → (resolved | dismissed | expired | dropped)`.
    Actions never enter `claimed` — nothing claims a decision.
  Each transition is guarded; no state is terminal that a requirement needs to resume.
- R8. **`resolution_effect`, not `follow_up`.** Each option carries a validated effect from a
  closed union: `enqueue` · `cancel_blocked` · `snooze` · `dismiss` · `write_policy` ·
  `open_session`. Only `enqueue` mints work. Revision 1's follow-up-spec-per-option could not
  represent snooze, dismissal, denial, policy acceptance, or discuss. Effect payloads are
  schema-validated per effect type at creation and again at application, and the schemas
  exclude every trust, profile, and tool-policy field (T2).
- R9. Resolution is **exactly-once and idempotent**: a unique constraint on the resolution
  write, and follow-up `dedup_key` derived deterministically from `(action_id, option_id)` in
  the same transaction. Two taps from two devices produce one follow-up.
- R10. Every item carries `dedup_key`; ingest is idempotent on it. Every item carries
  `expires_at` with a defined expiry transition, one `fyi`, and a suppression record.
- R11. `inbox_suppressions` is a real table (class key, evidence boundary, expiry, re-raise
  condition). Revision 1 required suppression without defining where it lives; a resolved
  item row cannot serve the role, because suppression outlives the item and is keyed by class
  rather than identity.

### Queue discipline

- R12. **Actions are capped at 60 open items** (configurable). At the cap, admitting a new
  Action evicts the lowest-priority open one — including the arriving item if it is the
  lowest. Eviction transitions to `dropped` with one `fyi` and a suppression record.
- R13. **`fyi` items do not count against the cap and are not evictable.** Otherwise the
  system recurses: eviction emits an `fyi`, `fyi` is an Action, every Action expires emitting
  another `fyi`. FYIs are digest material with a short retention, not decisions.
- R14. **An Action blocking a Queue item is not evictable** while the block stands. If it must
  go, eviction transitions the blocked item to `superseded` and enqueues a `cleanup_pending`
  compensation for its staging directory.
- R15. **Filesystem cleanup is never inside the DB transaction.** Staging lives on disk and
  cannot roll back with SQLite. Cleanup is an idempotent compensation state; the DB is
  authoritative after a crash and the staging directory is reconciled toward it.
- R16. Actions are ordered by a priority score and grouped by thread. Score inputs: deadline
  proximity, stakes class, thread freshness, attempt count. Model-suggested priority is
  clamped to a ceiling (T2).
- R17. **Deferred to v2.** On resurface after a snooze longer than the configured threshold, the premise is
  revalidated before display; a stale Action is refreshed or shown flagged
  premise-unverified.

### Execution

- R18. **The drain ticks in-server.** (`// manual triggers (triggerJob)`, `packages/ui-server/src/cron/scheduler.ts:10-13`) owns only manual triggers and
  history, but (`export function createActivityRuntime(`, `packages/ui-server/src/activity/runtime.ts:49-171`) already runs an interval tick with a boot sweep —
  that is the shape to copy, including its `close()` lifecycle.
- R19. **The cron backstop has independent authorization before the general guard.**
  Mount it on the existing listener before
  (`app.use("/api/*", authGuard(`, `packages/ui-server/src/app.ts:466`).
  Authorize a boot-minted ephemeral token, rotated each boot and stored in a
  0600 runtime file, with the actual socket address as an additional check.
  Proxy headers cannot authorize it. The poke succeeds in every auth mode
  without a cookie; missing/stale token or nonlocal socket must fail.
- R20. **The poke's recovery claim is bounded.** HTTP cannot reach a dead process or a blocked
  event loop; restarting a crashed server is the process supervisor's job, a
  hosting prerequisite. The poke detects a *stopped
  interval* via a persisted scheduler heartbeat, re-arms it or runs one drain, and prevents
  overlap. A hung event loop is a supervisor health concern, not this feature's.
- R21. The generated crontab gains the five-minute poke line (the deployment's
  entrypoint, owned by brain-hosting-template).
- R22. Claiming is `BEGIN IMMEDIATE`. WAL and `busy_timeout = 5000` are already set for
  two-process writes (`export function createUiDb(`, `packages/ui-server/src/db/client.ts:25-37`), so no posture change is
  needed — but the invariant is explicit: **an immediate transaction covers the claim or the
  settlement, never a model call or filesystem work.** A writer holding the lock past five
  seconds still yields `SQLITE_BUSY`. Test a cron heartbeat racing an inbox claim.
- R23. A boot sweep and a periodic sweep return expired leases to `ready`, mirroring the
  activity stale sweeper.
- R24. **Headless execution needs a new request shape.** `StartTurnRequest` is
  additive: `StartTurnRequest.autonomous` carries explicit persistence, origin, tool policy
  and prompt configuration alongside the required permission postures
  (`export interface StartTurnRequest {`, `packages/ui-sdk/src/server/backend.ts:298-372`); ordinary Claude turns create an SDK session, emit
  `session_info`, and persists history by default. The installed SDK supports
  `persistSession: false`; pi provides `SessionManager.inMemory`. Drive this mode
  with a synthetic checkpoint bridge and server-selected authority; the
  recorder accepts autonomous origin and keeps runtime identity separate from an interactive session
  (`export function createTurnRecorder(`, `packages/ui-server/src/activity/recorder.ts:80-144`).
- R25. **Autonomous work gets its own pool** (`MAX_AUTONOMOUS_RUNS`, default 2) — but a second
  counter alone does not deliver "interactive always wins". The host cap applies only when
  starting WS sessions (`const cap = host.maxConcurrentSessions();`, `packages/ui-server/src/ws/run-session.ts:642-652`), and an autonomous
  turn can hold a path write lock while an interactive turn waits or is denied at 30 seconds
  (`export function createTurnLockBinding(`, `packages/ui-backend-claude/src/turn-lock.ts:27-119`). Required: an admission controller
  with reserved interactive capacity and hybrid yield at an explicit denial-risk
  threshold (~20s of the 30s lock budget). Below it nothing yields; above it the
  holder checkpoints/unwinds/releases. Test both edges and independent paths.
- R26. **Abort-and-redo needs a checkpoint primitive.** `requestPermission` parks a bare
  promise (`return new Promise<PermissionDecision>((resolve) => {`, `packages/ui-server/src/ws/bridge.ts:173-228`) — while blocked on it the model cannot write anything, so
  "writes its findings, then aborts" has nowhere to run. The autonomous bridge must, in one
  server-side step: capture the checkpoint, create the Action and block the item, unwind without a live approval promise, preserving the tested timeout
  path's abort-then-drain order (`abortController.abort();`, `packages/ui-server/src/ws/run-session.ts:238-244`). Aborting does **not** undo completed tool side
  effects, so every attempt gets an isolated staging directory with idempotent cleanup. This
  does not reopen the abort-and-redo decision; it corrects revision 1's claim that the
  decision needed no new machinery.
- R27. Failure handling: `attempts` / `max_attempts` with exponential backoff, then
  dead-letter as one Action. Every item links its `run_id`.

### Trust and containment

- R28. **The restricted execution profile is a build item, not a configuration.** Today
  `DEFAULT_ALLOWED_TOOLS` auto-allows `Bash`, `Write`, `Edit`, `WebFetch`, `WebSearch`, and
  `Agent` (`export const DEFAULT_ALLOWED_TOOLS = [`, `packages/ui-backend-claude/src/tool-policy.ts:26-79`), and auto-allowed tools bypass
  `canUseTool` entirely — the backend says so where it explains why the write lock had to
  move into a `PreToolUse` hook (`const enforcementHook: HookCallback`, `packages/ui-backend-claude/src/permission-hooks.ts:104-127`). Existing mandatory tool/no-grant posture closes measured permission bypasses,
  but it does not express the full filesystem/network envelope. Building it requires: the SDK's tool **availability** control
  (`tools`, not merely `allowedTools`), a scrubbed environment carrying only inference
  credentials and minimum runtime variables (the current environment is filtered but retains operator/profile extras — (`export function envSnapshot(`, `packages/ui-backend-claude/src/config/env.ts:182-190`)),
  `strictMcpConfig`, fail-closed filesystem and network permission rules, and containment
  testing of each real runtime boundary against symlinks, shell indirection, `/proc`, Unix sockets,
  and DNS. Predicate-only tests do not establish containment — the same lesson
  AGENTS.md ("Testing expectations") records for the renderer.
- R29. **Autonomous runs do not inherit ambient project configuration.** Claude loads project
  settings/instructions and also appends explicit bridge tools
  (`export function createClaudeSdkTurn(`, `packages/ui-backend-claude/src/sdk-options.ts:54-218`). If containment fails once, `.claude/settings*`, `.mcp.json`,
  repo instructions, or a skill become durable escalation targets for later
  higher-privilege runs. Autonomous mode uses an explicit tool roster, `strictMcpConfig`, and
  a read-only trusted instruction snapshot.
- R30. **Trust class is inherited by every item and follow-up** in a thread, server-derived
  only (T1). Revision 1's follow-up shape carried no trust field, so a compromised T1/T2
  output could route its own follow-up as trusted work.
- R31. This is a narrow amendment to the binding decision that an arriving share is never
  acted on automatically. That decision holds for *acting*; what is permitted autonomously is
  triage and staging inside an envelope that cannot write the knowledge base, spend outside
  the budget, or reach unapproved egress (inference transport is explicitly authorized) — an envelope that R28 must actually build first.
  Anything beyond it crosses the user's thumb, now as an Action rather than a card.
- R32. Email intake (v2) admits **approved senders only**, keyed on the DKIM-verified domain
  or address, never the envelope `From`. Unknown senders produce an approve-sender Action and
  nothing else.

### Policies (v2, with one v1 obligation)

- R33. **v1 does not read `context/policies/`.** Nothing in that path carries authority until
  R34–R37 ship. Stated explicitly because the write path is open in v1 regardless (R35), and
  an unread file is inert while a read one is not.
- R34. Policies live in the brain repo: `context/policies/<slug>.md` with frontmatter (`id`,
  `scope`, `granted`, `from_item`, `active`), plus a deterministically-rendered
  `_index.md` digest. Rationale unchanged: history via git, survival of DB loss,
  hand-editability, greppability. None of the DB's advantages — leases, ordering, atomic
  claim, delta cursor — apply to an object written rarely and never claimed.
- R35. **The policy path is denied to every agent runtime**, including Bash and subagents;
  only a server-owned helper writes it. R22 of revision 1 removed only the *autonomous*
  agent's write path, but an ordinary interactive turn holds auto-allowed `Write`/`Edit`/
  `Bash`, and the backend itself notes that Bash confirmation is not containment because the
  same effect is reachable indirectly (`A Bash command the classifier misses`, `packages/ui-backend-claude/src/tool-policy.ts:215-220`). Without this, stored attacker
  text read by a normal session can write an active grant.
- R36. **Unexpected policy content is quarantined, not announced.** The server persists a
  per-policy expected hash and activation record transactionally; content that does not match
  is loaded **inactive** and raises an Action. Revision 1's notify-and-load meant a malicious
  grant reached the next autonomous prompt before the user read the FYI. This overrides
  revision 1's tell-only behavior; the cost is one confirmation tap after a legitimate hand
  edit or a `git pull`.
- R37. `active: false` is revocation with history intact. The rendered digest is stable and
  sorted; in v2 a policy change deliberately invalidates the prompt cache.

### Cost

- R38. **Tiered triage.** T0 deterministic (zero tokens) · T0.5 gate — a tick with no ready
  item makes no model call **and creates no Activity run** · T1 batch classification · T2 full
  agent run · T3 the user.
- R39. **T1 batches are bounded by tokens and bytes, not count.** One share's text may carry ~200 KB
  (`export const SHARE_MAX_TEXT_BYTES =`, `packages/ui-sdk/src/protocol.ts:1248`), so "up to 20 items" is ~4 MB before overhead.
  Per-item truncation, a batch token budget, and independent structured outputs per item.
- R40. **Every model-bearing operation is billed, recorded, classified, and counted**: T1
  batches, T2 runs, retries, redo re-derivation, state compaction, premise revalidation,
  policy proposals, and discuss-session digest construction when those v2 features ship. Revision 1's "T2 is the entire
  bill" was false.
- R41. **Budgets are enforced by reservation at claim time, not by summing history.**
  `rollupRun` runs in `finish()` (`store.rollupRun(runId);`, `packages/ui-server/src/activity/recorder.ts:451`), so cost exists only after a
  run ends: two runs can both start under the cap and finish over it, and unknown effective
  costs are excluded from the sum (`export function sumEffectiveCost(`, `packages/ui-server/src/activity/store.ts:177-192`) so the query **fails open**.
  Required: transactional reservations on claim, in-flight reservations counted, settlement at
  rollup, and the chosen unknown-cost rule: pessimistic reserve plus one suppressed-per-model
  Action; refuse a claim when neither price nor usage permits a conservative estimate.
- R42. **Two budgets: non-subscription effective spend (default $5/day) and autonomous turns
  per day.** Effective cost is a lower bound — it is null where pricing is incomplete and
  carries `pricing_estimate` (`ALTER TABLE activity_run_rollups ADD COLUMN effective_cost_usd`, `packages/ui-server/migrations/010_effective_cost.sql:17`), and it is genuinely
  zero on subscription billing, which is why the turn cap exists. The budget query filters
  autonomous origins, preserves `unpricedRuns`, and uses the configured local-day boundary.
- R43. **The caps are hard, with a named emergency reserve.** "Defer low-priority, keep
  high-priority" as written permits unbounded overshoot. High-priority work draws from a
  bounded reserve; when the reserve is spent, everything stops and one `fyi` is filed.
- R44. **Cache stability requires an autonomous prompt mode.** The current prefix is assembled
  per turn from client environment, turn budget, and bridge tool availability
  (`export function createClaudeSdkTurn(`, `packages/ui-backend-claude/src/sdk-options.ts:54-218`), and the SDK preset adds dynamic cwd/memory/git sections
  unless `excludeDynamicSections: true`. Required: a fixed tool roster, dynamic sections
  excluded, deterministic trusted-instruction render (policy digest is v2), and an explicit static/dynamic boundary with every
  per-item value after it. Whether the provider honors cache reads across independent SDK
  subprocesses is a runtime fact to measure, not to assume.
- R45. Snooze timing is rule-derived (backoff plus calendar-aware defaults); model overrides
  require a stated reason in v2 and are unavailable in v1. Times stored UTC, resolved against one configured timezone.
- R46. **T2 dominance is a measured claim, not a design assertion.** Most v1 shares are
  read-store-process requests (`export function buildSharePrompt(`, `packages/ui-react/src/lib/share-intake.ts:128-157`) that need
  a read plus a write tool, i.e. T2. Ship telemetry with acceptance targets — T2 rate, T1
  false-routing rate, cost per completed item — measured against a direct-to-T2 baseline. If
  T1 does not divert a meaningful fraction or materially shrink T2 context, it is theatre and
  should be cut.

### Surfaces

- R47. Reuse **Actions → needs you/running/done**, the existing D37 destination,
  for durable decisions and their badge. Preserve distinct card semantics for a
  failed run, live approval and durable Action. Queue is a secondary view; no new
  Actions/Activity destination or extra mobile tab is authorized.
- R48. The Queue is a secondary read-only view (pending, running, blocked, failed) drilling
  into existing Activity run detail.
- R49. Actions stream over the existing WebSocket as snapshot-then-delta with
  `capabilities.inbox` on `server_hello`.
- R50. **Escalation notices need an aggregate row.** `notification_intents` constrains `kind`
  to `failure|completion|stuck`, requires an activity `run_id`, coalesces only by dropping a
  later same-tag intent without updating a count
  (`function createIntent(input: {`, `packages/ui-server/src/activity/notify.ts:90-126`), and the sender emits one push per
  pending row (`async deliverPending(notifier) {`, `packages/ui-server/src/activity/push-sender.ts:185-232`). Reuse subscriptions, retry budget, and delivery
  status; add an Actions-aware aggregate carrying group key, count, priority, quiet-hours
  eligibility, and an Actions deep link. The
  [2026-10-02 Action notification decision](../decisions/action-notifications.md)
  selects a fixed 60,000 ms window from first eligibility, cross-thread grouping by
  recipient principal + existing channel + delivery class, inclusive push cutoff 12
  with the existing score/zero Action attempts, and immediately visible Actions.
  Strict quiet hours [22:00, 08:00) and in-app digest refreshes 09:00 and 17:00 use each
  client's validated, last reported IANA zone under authenticated ownership/refresh;
  missing usable metadata leaves new timed notices pending, without server-zone fallback.
  Digest B reports only unreported eligible lower-priority waiting episodes in that
  client context. New pending Actions and explicit snooze reactivation start episodes;
  clocks, ordinary version changes, retries and restart do not. FYIs remain separate
  new-only digest updates under F9/R13 and their existing validity/retention rules,
  never waiting-count constituents. Recompute state/score/authority and counts
  transactionally for each selection/attempt; retain constituent episodes and immutable
  per-destination attempts/known-success receipts. Consolidate only due unsent deferred
  work after each destination's quiet interval, preserving original deadlines. A later
  score promotion may receive its first push after digest inclusion; unresolved work
  alone causes no repeat push. Retry only components without known success, using
  bounded backoff and current checks. One current catch-up summary atomically commits
  durable client-context episode/FYI coverage without a first-run 24-hour loss. Keep
  global activity coverage/retention and budget/snooze timing independent and unchanged.
  Provider acceptance is not display/read proof; ambiguous outcomes are distinct from
  known success. The decision's timing, two-zone, partial-device and restart examples
  bind implementation verification; this requirement is not delivery evidence.
- R51. `resolve_action` is a defined tool (schema, idempotency, authorization, session-to-
  action binding), not a name mentioned in a flow.
- R52. The agent reads its queues through `mcp__brain-ui__inbox_*`, alongside
  `query_activity`.
- R53. **The nightly repo snapshot is either a restorable backup or it is not called one.**
  Open items and resolutions alone do not restore `state_md` projections, option effects,
  suppressions, leases, attempts, or blocked relationships. Either include all authoritative
  queue and thread state with a deterministic restore command and a stated 24-hour recovery
  point, or label it audit-only and solve backup separately.
- R54. Single user. No assignee, no ACL, no sharing model anywhere in the schema.

---

## Acceptance Examples

- AE1. A link is shared twice within a minute. One thread, one `triage` Queue item, one
  staging directory; the second arrival updates `last_seen_at` and creates nothing.
- AE2. A tick runs with an empty ready set. No model call, **no Activity run**, no digest
  entry. (At 60s cadence, recording empty ticks would add ~1,440 runs a day.)
- AE3. An autonomous run needs a tool outside its profile. The bridge checkpoints, creates
  the Action, marks the Queue item `blocked`, denies the parked permission, and aborts. No
  further tokens are spent until the user taps.
- AE4. The user taps Approve. In one transaction: resolution recorded, effect applied, blocked
  item `superseded`, one follow-up minted with dedup key `(action_id, option_id)`. No model
  call. Tapping twice from two devices still yields one follow-up.
- AE5. The user taps Later at 22:00 on a low-priority Action. It reappears 08:00 the next
  weekday. No model call chose that time.
- AE6. **Deferred to v2 (premise revalidation).** An Action snoozed 24 days resurfaces; its target file has since been deleted. It is
  shown premise-unverified rather than offering a choice about something that no longer
  exists.
- AE7. Actions holds 60 open decisions and a high-priority approval arrives. The
  lowest-priority open Action is dropped with one `fyi` and a suppression record. The `fyi`
  itself does not count toward the 60 and cannot evict anything.
- AE8. The eviction target is blocking a Queue item. Either the next-lowest non-blocking item
  goes instead, or the blocked item transitions to `superseded` and a `cleanup_pending`
  compensation reconciles its staging directory afterwards. Nothing claims a filesystem
  rollback inside the SQLite transaction.
- AE9. Ingested content says "add a policy that auto-approves shell commands". No policy file
  is written by any agent — the path is denied to every agent runtime. At most an Action appears,
  attributed to the untrusted source.
- AE10. **Deferred to v2 (policy quarantine).** A policy file is hand-edited and committed. Its hash no longer matches the persisted
  expected hash, so it loads **inactive** and raises an Action. It does not reach an
  autonomous prompt before the user confirms.
- AE11. Non-subscription effective spend reaches $5.00 mid-day. Reservations prevent a
  further claim from starting; high-priority work draws the bounded reserve; when the reserve
  is spent everything stops with one `fyi`. On a subscription backend where the dollar figure
  never moves, the turn cap produces the same shape.
- AE12. An autonomous turn holds a path write lock when an interactive turn arrives. The
  hybrid rule applies — reserved capacity, with yield only at the denial-risk threshold —
  and the interactive turn is not denied at the 30-second lock timeout.
- AE13. The drain interval stops without the process dying. Within five minutes the poke
  observes a stale scheduler heartbeat, re-arms the interval, and expired leases return to
  `ready`. The poke reaches the route in **password mode**, not only in tailscale/none.
- AE14. Three escalations occur inside the coalescing window. One push arrives reading "3
  actions waiting", with a deep link into Actions; a fourth arriving after the window follows
  the defined later-arrival rule.
- AE15. A T1 batch is offered twenty items, three of which carry 200 KB of text. The batch
  splits on the token budget rather than the count, each item truncated per-item, with
  independent structured output per item.

---

## Scope Boundaries

Not in v1:

- **Email intake.** Share target and `brain` CLI only.
- **Policies.** The mechanism (R34–R37) is specified because it constrains the prompt prefix
  and the write path, but forming policies is v2. R33 and R35 are the v1 obligations: do not
  read the path, and close the write path regardless.
- **`discuss` sessions.** Approve / choose / dismiss / later covers the loop.
- **Premise revalidation** (R17) and **agent-overridden snooze timing** (R45).
- Multi-user anything (R54 is permanent, not a v1 boundary).

v1 slice: Intake via share + CLI · explicit operational state · in-server tick with leases and reservations ·
the restricted execution profile (R28 — the largest single item) · T0/T0.5/T1/T2 tiering ·
derived state with append-only checkpoints · Actions surface with approve/choose/dismiss/later
· `resolution_effect` union · WS delta · coalesced push · both hard caps with reserve ·
tiering telemetry (R46).

---

## Key Decisions

- **One store, two views.** Two literal inboxes would duplicate scheduling, dedup, retry,
  provenance, and delta streaming, and the copies would drift.
- **Threads are the context unit, but the audit record is append-only.** Revision 1 made
  `state_md` both the prompt payload and the history; a model-authored mutable blob cannot be
  history. Checkpoints are immutable; the projection is for prompting.
- **Abort-and-redo over park-and-resume.** Parking needs durable LLM conversation state and
  SDK support the project does not own. Confirmed as the right call — with the correction
  that it requires a checkpoint primitive (R26), which revision 1 denied.
- **Resolution is free; execution is not.** Storing validated effects at escalation time makes
  the phone interaction a DB write. This is what makes a 60-item cap survivable.
- **DB owns state that moves; the repo owns judgment that accumulates.** Queue mechanics need
  leases, ordering, atomicity, and a delta cursor — git is poor at all four. Policies need
  history, portability, and hand-editing — the DB is poor at all three.
- **Containment is built, not configured.** The single largest correction in revision 2. The
  current backend auto-allows every tool R28 must remove, and auto-allowed tools never reach
  the permission callback. Treating the envelope as a config flag would have shipped an
  autonomous agent with `Bash`, `WebFetch`, and the host environment over attacker text.
- **Quarantine beats notification.** Fail-closed on unexpected policy content follows the
  binding "fail loud, secure by default" decision; notify-and-load is exactly the
  silent-substitution shape that decision was written against.
- **The agent may request a capability; only the server grants one.** Removes the
  confused-deputy path from model-authored state and payloads.
- **Budgets are reserved, not observed.** A retrospective sum cannot gate admission and fails
  open on unpriced runs.
- **The cap forces judgment.** At the cap the agent must decide autonomously using the
  lower-stakes default and file an `fyi` — the constraint is what pushes it to get better at
  judging what is worth an interruption.
- **Tiering is a hypothesis with a kill criterion.** If T1 does not measurably divert work or
  shrink T2 context, it is removed rather than kept for tidiness.

---

## Decisions and remaining design work

[The durable ruling](../decisions/async-collaboration.md) and the companion plan
settle: read-time priority components/clamps; 4 KB projection/next-use compaction;
internal token route before the guard; 40k-token T1 batch/4k per-item bounds;
four-way optional dismissal reasons; hybrid interactive priority; pessimistic
unknown-cost reservations; and generic, explicit nonpersistent headless requests.
Both first-party backends require actual containment evidence. An unsupported
platform cannot silently substitute a weaker profile.

The historical model/effort preference is benchmark evidence, not an unverified
current deployment default. U6 supplies production accounting; U18 is reused.
Interaction design for durable cards/Queue and exact notification aggregation
policy remain scoped design inputs on their GitHub tasks. U10 produces the
process-boundary proof before implementation. #597 retains its own hygiene
priority/disposition ruling; it is not a blocker for all of #51.

Use the sole Odysseus example world under the September 30 maintainer ruling.
Repository-wide corpus conversion is #625. Plans hold design; GitHub owns task
status, dependencies and completion evidence.
