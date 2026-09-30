# Decision — complete async collaboration with Queue and Actions

The maintainer's [2026-09-28 ruling on #51](https://github.com/schlessera/brain-kit/issues/51#issuecomment-5865507741)
chooses the complete autonomous collaboration loop. This record captures that
ruling and the source audit requested by #533 on 2026-09-30. Detailed flows,
requirements and design identifiers remain in [the design](../plans/async-collaboration.md)
and [its requirements](../plans/async-collaboration-requirements.md); implementation
scope and dependencies belong to #51's GitHub children. This ruling makes no
release commitment and is not evidence that autonomous execution is safe to enable.

## The outcome and its ownership

A shared arrival becomes durable queued work, is triaged unattended inside a
restricted envelope, and escalates a decision when authority or judgment runs
out. The user can leave, return and resolve it; validated resolution produces
at most one follow-up, which executes later under authority for that operation.
Restart recovery, reservations, escalation and adversarial containment belong
to this one v1. A smaller non-autonomous release does not meet this outcome.

Markdown owns brain content, including the existing hygiene finding log.
`brain.db` remains disposable. Claims, leases, checkpoints, reservations,
resolution records and stream cursors belong to the UI server's operational
store (`createUiDb`, `packages/ui-server/src/db/client.ts:25-37`). They are not
an alternate authoritative content index. A checkpoint is append-only history;
`state_md` is a bounded projection for prompting. Server-owned columns retain
trust and provenance even when a model compacts that projection.

Queue work and human Actions have different state machines. Claiming a human
decision is meaningless: Queue items acquire leases; Actions stay pending or
snoozed until a validated disposition. Every mutation emits its change row in
the same transaction. Reuse the activity cursor algorithm and transactional
snapshot discipline, rather than importing its activity-specific stream
(`createActivityStream`, `packages/ui-server/src/activity/stream.ts:158-174`).

## Authority and containment

The source assigns each thread's immutable trust class. Shares remain
untrusted; an authenticated CLI operation may establish a trusted origin.
Neither a request body nor model output can choose trust, profile, principal,
allowed tools or a wider target path. A capability describes one approved
operation with its exact tool, input and target. A label such as “Approve”
never grants general authority. Authorization and principal revocation still
apply in this single-user product; single user does not mean one undifferentiated
credential.

The share-confirmation decision is amended narrowly: unattended triage and
isolated staging are permitted only once the restricted profile proves it cannot
write the knowledge base, exceed its reservation or reach unapproved egress.
Filing content and other effects outside that envelope still require the user's
explicit bounded approval. This does not make every staged share permission
to act on its contents.

Containment is built early and gates enabling the autonomous system. Its proof
must exercise the actual execution boundary: tool availability, ambient
configuration, credentials, filesystem escapes and every reachable egress path.
A filtered roster or an allowlist predicate alone proves none of those things.
The v1 obligation also denies agent writes to `context/policies/`, including
interactive shells and child processes; v1 never reads that path for authority.
Policy formation, hash-based activation/quarantine, email and discuss sessions
remain deferred. No dismissal reason is a standing grant.

[The voice decision](voice-permission.md#containment-shared-with-51-deliberately-not-identical)
requires one enforcement mechanism with different named memberships for voice
and unattended work. Keep that requirement when implementing availability
control. Existing mandatory backend conformance supports safe rejection of an
unsupported restricted request; silently ignoring it is forbidden. The current
optional inputs are (`enforceAllowedTools?: boolean`, `packages/ui-sdk/src/server/backend.ts:318`) and (`noGrantSurface?: boolean`, `packages/ui-sdk/src/server/backend.ts:342`). These are permission primitives,
not a claim of filesystem or network containment.

The current Claude assembly loads project settings and appends bridge tools
(`createClaudeSdkTurn`, `packages/ui-backend-claude/src/sdk-options.ts:50-183`).
Its environment is already filtered (`envSnapshot`,
`packages/ui-backend-claude/src/config/env.ts:173-183`), with profile credentials
and operator extras. An autonomous envelope needs its own narrower credential
and configuration audience; the old plan's “full host environment” description
is historical. Preserve subscription billing and the selected runtime identity.

Pi disables built-in tools but currently loads resources and extensions
(`createSessionResources`, `packages/ui-backend-pi/src/session-resources.ts:31-147`)
and gates extension calls (`createPermissionGate`,
`packages/ui-backend-pi/src/permission-gate.ts:75-142`). Removing four curated
tools cannot prove that extensions, MCP, scratch writers or in-process code have
no egress or write access. Both first-party runtimes owe executable evidence;
the plan's earlier “pi is easy” claim is not a containment result.

## Escalation and deterministic resolution

Escalation checkpoints before the permission boundary parks the run. Server
code atomically creates the Action and blocks its Queue item, then denies the
permission and unwinds the turn. Already completed side effects are not undone
by an abort. Attempt staging and cleanup therefore need idempotent recovery,
with filesystem compensation outside SQLite transactions. Ordinary permission
parking still exists (`requestPermission: (req) => {`,
`packages/ui-server/src/ws/bridge.ts:116-209`); it is not a durable Action store.

Resolution validates the stored effect again, checks current authority, records
one resolution and applies the guarded state transition in one transaction.
Only an `enqueue` effect creates work, using a deterministic Action/option dedup
key. Replayed taps, two devices and crash recovery cannot mint two follow-ups.
No inference call runs during resolution. A subsequent execution may use a model
and consumes its own reservation. Deferred `write_policy` and `open_session`
effects are unavailable in v1, not dispatch paths that accidentally grant authority.

Actions are bounded, priority-ordered decisions; FYIs do not count against the
cap and cannot recursively evict decisions. Protected blocking Actions, expiry,
suppression and compensated cleanup must remain consistent under cap pressure.
Snooze is deterministic; premise revalidation and model-chosen snooze timing
remain deferred. Dismissal can record “don't ask again”, “wrong call”, “need more
info” or “no longer relevant”; those are feedback, not policy activation.

## Scheduling, budgets and evidence

The drain ticks inside the server and closes with the app. It creates neither a
model call nor an Activity run for an empty ready set. A boot/periodic lease sweep
and persisted scheduler heartbeat repair stopped scheduling, while the process
supervisor owns dead-process and blocked-event-loop recovery. An internal poke
uses a boot-minted ephemeral token, with the actual socket address as an
additional check; proxy headers cannot authorize it. Mount and test it in every
auth mode. The generated host owns token-file provisioning and the cron backstop,
so its glue belongs in brain-hosting-template. No new daemon or transport seam
is authorized by this design.

Reserve both non-subscription spend and autonomous turns at admission, including
in-flight reservations and every model-bearing retry, triage, compaction or
redo. A hard cap has a bounded named emergency reserve; exhaustion stops work
with one FYI. Unknown API cost consumes a pessimistic reserve and raises one
suppressed-per-model Action; unknown usage cannot become a guessed zero.
Subscription billing moves the turn counter even when spend is zero. The activity
sum exposes unpriced runs (`sumEffectiveCost`,
`packages/ui-server/src/activity/store.ts:176-187`) and settles only after execution
(`store.rollupRun(runId);`, `packages/ui-server/src/activity/recorder.ts:442`).
Retrospective totals alone cannot enforce admission.

Interactive work reserves capacity. On a shared target, the chosen hybrid yields
autonomous work only at the explicit denial-risk threshold; below it there is
no speculative preemption. Yield must checkpoint/unwind, release the lock and
reservation, and return recoverable work without replaying completed effects.

T0 is deterministic. T1 uses bounded bytes/tokens, independent per-item output,
completeness checks and individually retried missing IDs before escalation.
T1 model choice comes from the existing opt-in triage harness, not a new ranking
claim. Its recorded preference is historical evidence about a synthetic dataset;
current provider availability, model/effort support and prices require verification
when enabling it. No paid benchmark was run for #533. The shipped scorer/gate
and keyless fixtures are reused (`verdict`,
`packages/ui-server/evals/triage/score.ts:126-139`); unjudged configurations do not pass.
Measure T1 diversion and cost against direct-to-T2 before retaining tiering.

An autonomous prompt has a fixed trusted prefix and dynamic item context after
an explicit boundary. The installed Claude SDK exposes a boundary marker, tools,
`strictMcpConfig` and `persistSession`; pi exposes `SessionManager.inMemory`.
Those declarations settle the old no-persistence API question, not runtime
behavior. Cache hits, TTL, credential scope and minimum prefix depend on the
provider/runtime and need measurement; never pad a prefix to make a cache test
pass. Cache optimization cannot weaken authority or budgets.

## Surfaces, recovery and the scope that remains separate

D37 binds the five destinations: reuse Actions (`needs you`, `running`, `done`)
for durable decisions, and make Queue a secondary view with links to existing run
detail. Do not add a second Actions/Activity destination. The current page's
notification acknowledgement is not resolution (`ActionsLens`,
`packages/ui-react/src/components/activity/activity-page.tsx:47-48`). Exact effects,
reconnect convergence, accessible focus and visible failure are required; new
cards need an interaction design that fits the current kit.

Streams reuse snapshot-then-delta ordering, with capability negotiation and
principal-scoped access. Agent tools use the same state/authority rules. An export
called a backup must include all authoritative async state and have a deterministic
restore path into an empty store; otherwise call it audit-only and keep recovery
open. Restored leases/reservations must reconcile before any dispatch, and lost
staging bytes must cause a visible blocked state rather than blind execution.

The hygiene CLI, briefing and weekly schedule already satisfy #395–#397. Do not
rebuild them. #597 owns hygiene-specific priority/disposition policy and cards;
it consumes the shared store, resolution and streaming prerequisites without
blocking all of #51 or moving markdown findings into this operational store.
Odysseus is the sole example world under the September 30 ruling on #51/#533;
the repository-wide conversion is #625, not an extra task here.

## Alternatives rejected

- **Only staged-share listing, approval pushes and a hygiene UI.** Useful slices,
  but they omit unattended triage and durable continuation. The maintainer chose
  the complete lifecycle and accepted its greater implementation commitment while
  architecture remains inexpensive to change. Reuse shipped hygiene instead of
  substituting it for autonomy.
- **Park a live agent until the user returns.** This depends on a process,
  conversation and permission promise surviving an arbitrary absence. Checkpoint,
  abort and fresh bounded execution provide durable waiting without token usage.
- **Resolution asks a model what to do.** This adds latency/cost and lets untrusted
  context influence authority again. Store validated effects at escalation time;
  execute only the effect the user selected.
- **Put operational decisions in the disposable core index or make a skill own
  claims/dedup/retries.** Reindexing must not erase pending work, and deterministic
  mechanics belong in code. Operational SQLite and authoritative content files
  have different responsibilities.
- **Notify after loading an unexpected policy, or infer grants from model state.**
  Both grant authority before confirmation. Policy activation remains deferred
  and quarantined by design; v1 closes agent write paths and reads no policies.
- **Enable trusted-only autonomy if containment slips.** This was an old risk-table
  suggestion, not the approved full v1. A scope fallback requires a new maintainer
  ruling; a green surface suite cannot substitute for containment evidence.
