# Decision — scheduled work uses Queue and bounded recurring approval

The maintainer selected six policies on [#913](https://github.com/schlessera/brain-kit/issues/913),
within [#912](https://github.com/schlessera/brain-kit/issues/912). This record binds
the implementation; it introduces no scheduler, grant, executable endpoint or
production dispatch. The [prepared consumer contracts](../integration-contract.md#scheduled-task-contract-preparation-913)
name future interfaces, not capabilities of the installed packages.

| Choice | Ruling | Rejected alternative |
| --- | --- | --- |
| Execution A | [One existing Queue/AgentBackend path](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5974684125). | Independent cron/core-runner dispatch or an interim migration. |
| Authority A | [Approve a bounded recurring envelope at creation](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5974737271). | Approval before every occurrence or mandatory approval of every final effect as the default. |
| Budget A | [Ten minutes per attempt, three model operations per occurrence](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5974870223). | Two minutes/one operation as the default, separate unaccounted capacity. |
| Timing A | [One latest catch-up within 24 hours](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5974916570). | Skip every missed occurrence, replay every missed occurrence. |
| Delivery A | [Success notices opt in per schedule](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5975000150). | Success notices on by default, including a one-off exception. |
| Store B | [Markdown definitions and a host operational ledger](https://github.com/schlessera/brain-kit/issues/913#issuecomment-5975512157). | Authoritative definitions in SQLite or an offline/core-runner fallback. |

## Existing mechanics and the evidence boundary

Source inspected at `b5c30c180df5584584f261b446c4d440380d2441`:

- Queue lifecycle promotes an existing scheduled item at its due time
  (`else if (item.status === "scheduled"`, `packages/ui-server/src/inbox/actions.ts:176-177`).
  The runtime ticks every minute (`INBOX_TICK_MS`, `packages/ui-server/src/inbox/runtime.ts:11-13`).
- Production app wiring supplies recovery and budgets, without a dispatcher
  (`// Recovery/heartbeat only.`, `packages/ui-server/src/app.ts:288-293`).
  A scripted nonempty ready-item test still reports no claim, attempt or
  Activity root. That proves disabled wiring, not safe execution of a schedule.
- Headless plumbing checks backend support, a usable principal, lifetime and
  reservation ownership (`runAutonomousTurn`, `packages/ui-server/src/inbox/autonomous-turn.ts:54-75`).
  Capability flags and these checks do not prove credential/configuration,
  filesystem or egress containment at the actual backend boundary.
- The generic core runner has a different interface
  (`AgentRunner`, `packages/core/src/lib/seams.ts:46-61`); its helper forwards
  no autonomous authority/admission controls (`runAgent`, `packages/core/src/cli/agent.ts:39-66`).
  Existing static nightly sync is not authorization for arbitrary stored prompts.
- The existing operational database is concrete WAL SQLite
  (`createUiDb`, `packages/ui-server/src/db/client.ts:25-37`). The
  [complete backup](../inbox-recovery.md) and [reservation accounting](../inbox-budget.md)
  are available precedents; their existing tests cannot prove new schedule relations.
- Notification kinds are already failure/completion/stuck
  (`IntentKind`, `packages/ui-server/src/activity/notify.ts:30-30`), with bounded
  suppression/retry (`MAX_INTENTS_PER_HOUR`, `packages/ui-server/src/activity/notify.ts:68-74`).
  Job-name success opt-in (`if (span.outcome === "success"`, `packages/ui-server/src/activity/notify.ts:171-184`)
  does not implement schedule/occurrence preferences or correlation.

Production execution requires [#689](https://github.com/schlessera/brain-kit/issues/689)
and the full-v1 evidence in [async collaboration](async-collaboration.md).
A new definition, cron expression, stub or timer cannot satisfy that gate.
No provider evaluation, cost saving, completion-rate or deployed-host claim
follows from the selected numeric limits.

## One execution owner

The server's existing lifecycle/tick creates eligible occurrences and uses
Queue admission, leases, lifetime, budgets and autonomous AgentBackend execution.
Its existing boot/recovery and supervisor/backstop infrastructure remain the
owners. A cron poke may wake that same path; it never dispatches a second core
AgentRunner operation. Empty/not-yet-due ticks perform no inference and create
no Activity root or result intent. Due time means eligibility, not an exact-second
start guarantee. No new daemon, transport provider or scheduler account is needed;
ordinary configured inference authentication/network/billing still applies.

The authenticated CLI, bridge tools and PWA reach one concrete host service.
Unavailable storage/transport is an explicit error. Disabled execution remains
visible on an otherwise valid stored task; storage does not enable dispatch.

## Approval is an immutable recurring envelope

The host obtains the creator from authenticated request/turn context, and the
approver from a verified operator decision. Neither prompt nor a client field
can select principal, trust, profile, billing, emergency capacity or approval
provenance. An authenticated agent's proposal is not an operator grant.

Review includes the self-contained prompt, timing/zone, operation, exact supported
tools and input bounds, root-bound targets, permitted egress (including the
host-selected inference audience), limits and success-notice preference. The
host can reject an unsupported or broader proposal. Host code resolves each
canonical public tool name to the actual backend descriptor/name; model aliases,
wildcards or a declared allowlist never supply that mapping. Verify membership
and bounded inputs at the actual registered executor in both runtimes. Every varying input is
explicitly declared and constrained; undeclared variation fails closed. Changing
prompt/scope/timing/notification metadata requires cancel-and-create and fresh
approval. Lower approved execution limits are allowed; they cannot be raised
by a later model call or an ordinary remembered chat grant.

The proposal/approval protocol in the prepared contract separates authentication,
review and publication. CLI review uses an explicit operator confirmation and
server-verified operator credential; bridge review uses the existing trusted
permission/Action decision path. A bare boolean, principal string, copied
fingerprint, model-produced approval ID or terminal prompt is not proof of an
operator. Terminal review is usability; host credential/decision checks and
runtime credential containment supply authority. A delegated agent cannot
mint operator approval by choosing an approval channel. Ambient auth modes keep
their existing server-resolved operator semantics; no new auth mode is introduced.

The recurring capability is the immutable approved envelope intersected with
current usable creator/approver authority and host policy. Revalidate before
admission/start and before effectful calls; revocation, expiry, file drift or
narrower permissions stop/refuse further work. No credential renewal implicitly
transfers the grant to a new principal. Principal attribution is not containment;
[session principals](session-principals.md) retain that distinction.

When a run needs additional permission or an ordinary answer, commit its
checkpoint and durable Action, then deny/unwind. Validated human resolution
can create at most one separately admitted continuation, linked to the same
occurrence and remaining limits. Human wait holds no live backend promise.
Completed effects are retained; abort does not undo them. A later answer cannot
revive cancelled/expired work, widen scope or blindly repeat an unknown effect.

[Voice may refuse, never grant](voice-permission.md). Schedule creation is absent
from auto-allowed voice membership; a spoken request can propose work but cannot
approve recurrence. Visual/authenticated operator review remains necessary.
Scheduling does not alter the named voice/unattended membership or its one
containment mechanism, or activate general `context/policies/` authority.

## Definition files and host-owned state

Use `context/scheduled-tasks/definitions/<taskId>.md` inside the canonical brain
root, and retain retired definitions under `context/scheduled-tasks/retired/`.
These are Git-tracked definition data, not scratch files under an ignored
`.brain/` directory. The host refuses ignored/untracked-only publication policies
that would make a promised content backup omit definitions. It never commits or
pushes Git on the operator's behalf. Existing valid content in this namespace
is not overwritten or reclassified silently: validate ownership before creating it.

The reserved directory is excluded from ordinary content taxonomy/index scans
by the implementing core path, while schedule parsing remains explicit.
It does not add a compile-time document-type union. Today the Markdown scanner
only applies taxonomy exclusions (`getMarkdownFiles`, `packages/core/src/lib/indexer/scan.ts:21-30`);
this record does not claim it already excludes the new namespace. Rebuilding
`brain.db` cannot erase definitions or recreate approvals/occurrences.

Parse with the package's cache-free `parseFrontmatter`, validate strict schema
and UTF-8 size bounds, reject duplicate/unknown fields and malformed documents.
Validate the final serialized file size before approval/publication, not after
committing a grant that cannot be stored.
No YAML tag, frontmatter actor or file permission constitutes approval. Files
contain immutable definition fields only; creator, approval, enabled/cancelled
control state, counters, next/last occurrences and outcomes come from the
operational ledger. The example uses the existing read tool's actual path input
(`"brain_read"`, `packages/core/src/mcp-server.ts:366-382`):

```yaml
---
schedule_schema: 1
id: task_ithaca_review
when:
  kind: cron
  cron: "0 7 * * 1-5"
  timeZone: Europe/Athens
  endAt: null
scope:
  operation: "Report outstanding Ithaca checks"
  tools:
    - name: brain_read
      inputs: {path: notes/ithaca.md}
  targets: [notes/ithaca.md]
  egress: []
  variableInputs: []
limits: {attemptTimeoutMs: 600000, maxOperations: 3}
notifyOnSuccess: false
---
Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.
```

The inference audience is server-selected and recorded with approval separately;
`egress: []` denies additional tool egress, not the configured model connection.
An operator must see both audiences. IDs in examples are fictional; real IDs
are host-minted. Prompt text is the body, preserved as approved data.

The approval fingerprint is lowercase SHA-256 of `brain.schedule.v1\n` plus
canonical JSON of `{definition, rootIdentity, creatorPrincipalId, executionPolicy}`. The definition
contains every decoded schema field and exact prompt. Normalize CRLF to LF at
proposal time only; do not trim/repair stored input at dispatch. Canonical JSON
recursively sorts object keys by code-point order, preserves array order, and
encodes validated finite JSON numbers/strings/booleans/null only. Limits,
counters and timestamps are safe integers; negative zero canonicalizes to zero. Reject duplicates
before canonicalization. Defaults, resolved zone and the host-reserved task ID are materialized in the
proposal before approval. The stored definition is exactly
`{schedule_schema:1,id,prompt,when,scope,limits,notifyOnSuccess}`. Root identity is host-owned and bound to the canonical root; restore
to a different root requires explicit reconciliation/reapproval, not a claimed
matching fingerprint. The host-selected execution policy freezes backend/profile and allowed inference
audiences; it is reviewed with the definition and cannot be supplied by a model.
The host stores that immutable snapshot and fingerprint alongside approval
actor/channel/time/receipt. Recomputed equality binds data;
it does not mint authority or activate a general policy file.

Reject absolute paths, `..`, backslashes, NUL, URL paths, symlinks at any directory
component and file escapes. Targets are normalized exact brain-relative paths;
no wildcard target or caller-selected root. Protected configuration, credentials,
operational state, policies and schedule-definition directories are not writable
targets for an agent. Stable identity plus containment at actual file/tool access
must survive rename/symlink races; a `realpath` check alone is insufficient.
The backend executes the approved snapshot, never reparses edited prompt data
into wider authority. Drift before an effectful call denies/aborts further work.
Missing, edited, restored, unapproved or conflicting files quarantine dispatch
and expose a durable reason/Action. Matching data cannot revive a cancelled ID.

## File/database compensation and restore

Creation first commits an immediate operational transaction holding the
principal/root/request-key receipt, immutable approved snapshot and a publication
journal in non-dispatchable `publishing` state. Write a private temporary definition
inside the verified directory, sync it, atomically publish without replacing an
unowned file, sync the directory, then mark publication complete transactionally.
Return created success only after both stores agree. A retry/crash reconciles
that journal by exact fingerprint and bytes; mismatch quarantines and never
silently overwrites content. Compensation uses the original approved snapshot;
model output cannot choose recovery bytes. Orphan files have no approval.

Cancellation commits its retained tombstone/receipt before moving the definition
to `retired/`. An already-started attempt retains its bounded approved snapshot;
the host-authorized retirement of unchanged bytes is not definition drift and
does not revoke that attempt. Its file checks follow the recorded publication/
retirement journal and verified file identity. Cancellation gates new admission/
continuation only; other authority, expiry and real drift checks still apply. The same transaction invalidates unstarted occurrences and stale
Action continuations; claim-versus-cancel ordering decides whether an attempt
actually started. A retirement journal retries the file move durably. A failed
move does not undo cancellation; status exposes pending compensation. Recreated
active files with that ID remain retired. Keep cancelled definitions, request
receipts, approval and occurrence history; hard delete/purge/import is outside
this policy. New intent requires a new ID/key and fresh approval.

Definitions travel with content Git backup; the complete operational image keeps
approvals, journals, identity links, occurrences, claims/counters/reservations,
Actions, tool receipts, results and notification correlation. Extend schema and
relationship validation before calling schedule backup supported. Preserve the
24-hour recovery-point objective and dispatch-blocking restore marker. Reconcile
matching definitions, tombstones, current principal validity, lost workers,
charges and pending compensation before opening admission. A stale image cannot
prove later external effects complete: investigate unknown effects and pause
that schedule. Matching old files/image is not proof that later cancellation or
revocation never occurred. Require authoritative later receipts or fresh verified
operator reconciliation of that uncertainty before dispatch; unresolved tasks
stay paused. Backup retention/operator glue belongs in brain-hosting-template.

## Budgets, time and recovery

An occurrence may consume at most three separately admitted model-bearing
operations, each with a host-owned 600000 ms elapsed deadline. Initial dispatch,
retry/redo, yield, separately dispatched compaction and approved Action continuation
share that occurrence counter even across new Queue items, restarts and restore.
Increment durably with admission; never reset a counter/deadline to get work
through. Preserve earlier attempt deadlines/charges during recovery. Internal
SDK loops/subagents remain in the admitted operation's conservative estimate
and deadline; they are not free additional operations.

Use shared operator-configured autonomous daily spend/operation limits, charged
usage plus active reservations. Zero/absent operations disables admission. No
schedule-only pool or privileged emergency reserve. Subscription work consumes
operation capacity; unknown usage/prices retains pessimistic charges, and observed
overruns remain charged in full. Admission is not an invoice ceiling. Deadline,
expiry, stop and revocation abort the actual backend and await unwind before
lifetime/claim/accounting release; a hung backend requires the existing supervisor
recovery. Three ten-minute attempts are not a proven hard 30-minute wall-clock
bound. Human wait counts toward freshness, not active execution time.

Maintain one outstanding occurrence per task, including queued/running/retrying,
unwinding or human wait. When none exists, choose only the latest missed due
instant satisfying `dueAt <= now < dueAt + 24h`; older missed instants are
coalesced/skipped. Instants arriving during outstanding work are recorded as busy,
not replayed later as a hidden backlog. Persist the evaluated-through cursor and
original UTC due identity transactionally. Occurrence ID is deterministic from
task ID plus original due instant; request keys and attempt/run IDs are distinct.
A unique task/nonterminal ownership constraint guards concurrent ticks/processes.

Freshness never moves on retry or resolution. At the 24-hour boundary, invalidate
unstarted/Action work and abort/drain a started attempt; retain its actual effects.
One-offs finish as completed/failed/cancelled/expired/unknown and never recur.
Cancellation stops future/unstarted work; it does not stop a running backend.
Distinct authenticated stop uses host cancel/drain and reports actual outcome.
Neither operation claims undo. An optional explicitly approved recurring endAt
uses the same future/unstarted-only boundary: at now >= endAt no new occurrence
or continuation starts; a started attempt can finish within its existing limits.
The configuration becomes expired, with no fabricated successful run. A possible effect without authoritative completion
or idempotency evidence pauses the task for investigation. Safe reads/proven
idempotent effects can resume only with current authority and remaining limits.

Explicit valid IANA zone wins; else validated client zone; else disclosed UTC.
Explicit invalid zones fail. Resolve/persist zone at first creation, not from
prompt text or the viewer's later zone. A one-off requires a valid future ISO
instant with `Z` or numeric offset. Look up matching create receipts before
rechecking whether that original appointment is now past.

Recurrence uses five numeric minute/hour/day/month/weekday fields with `*`,
comma lists, inclusive ranges and positive range/star steps. No seconds, macros,
commands, names or extensions. Minute/hour/day/month/weekday ranges are
0–59/0–23/1–31/1–12/0–7; both 0 and 7 mean Sunday. If either day field begins
with `*`, both day predicates must match, including a stepped wildcard. Otherwise
either day predicate may match. This follows the upstream numeric
[field grammar](https://github.com/cronie-crond/cronie/blob/master/man/crontab.5)
and [day-match implementation](https://github.com/cronie-crond/cronie/blob/master/src/cron.c),
whose [star flags](https://github.com/cronie-crond/cronie/blob/master/src/entry.c)
test the first character; a later wildcard in a list does not set that flag.
Reject invalid or permanently impossible expressions. The chosen DST rule is
explicitly different from cron implementations that repeat a fold: skip missing
local wall times, and run a repeated local time once at its earlier UTC instant.
Persist due identity across fold/restart recovery. Expression validation and due
search are bounded and deterministic; implementation must prove leap days,
month lengths and zones through actual parser/clock controls.

## Results, delivery and the remaining proof

Authenticated Activity/schedule detail retains bounded inert results and actual
schedule/occurrence/run correlation, with origin `autonomous`. Skipped/coalesced
or blocked unstarted work is scheduling history, not a fabricated model run.
Unknown/pruned/unavailable results are explicit. No original Chat insertion,
extra model turn, new intent kind or notification service is introduced.

Success completion intents require schedule opt-in. Failure/stuck/Actions reuse
existing watching/debounce/suppression and push permission/retry behavior. One
final occurrence outcome has at most one correlated completion/failure intent;
intermediate attempt roots cannot duplicate it. Stuck is not terminal. Retain
results even when notices are suppressed/acknowledged/denied/unavailable. Push
uses fixed generic scheduled-work labels and authenticated tap-through; never
prompt/title/path/tool/result bytes by default. Intent, delivery attempt, provider
acceptance and reading are separate facts.

The future CLI/store implementation belongs to #914, runtime/activity/delivery
to #915, SDK and both actual bridge executors to #916, and reviewed PWA inspection/
cancellation design to #917. The record answers #913 only. Their remaining
prerequisites, including #689 and #917's design, stay in the tracker. A fake-clock
or keyless source observation cannot discharge actual backend containment or
running-host proof.

Implementation must exercise nonempty CLI/host/file/store and both backend paths:
authentication/revocation/forged provenance, concurrent create/cancel/tick and
receipt conflict/replay, interrupted publication/retirement, drift/symlink races,
whole-occurrence caps across restart/new items/continuation, actual timeout/unwind,
24-hour cutoff/busy/coalescing/DST, effect-before-receipt/stale restore, read-only
due, result/intent dedup and payload minimization. Mutations must fail the named
observable behavior rather than load errors or an earlier auth guard. Keyless
fixtures prove their controlled boundaries; production proof and any separately
authorized inference measurement remain distinct.
