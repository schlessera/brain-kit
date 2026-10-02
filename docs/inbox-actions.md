# Durable escalation and Action resolution

The UI operational database holds decisions and work; markdown remains the
source of truth for brain content. Resolving a decision changes operational
state and may enqueue a follow-up. It never invokes a backend, writes a policy,
starts an interactive session or remembers a standing grant.

## Escalation

The autonomous runner calls a synchronous checkpoint callback before denying
a permission and aborting the backend. The writer
(`escalateInbox`, `packages/ui-server/src/inbox/escalate.ts:21-53`) verifies the current
claim/version, lease, run and principal-bound active reservation. One immediate
SQLite transaction appends the checkpoint, validates and inserts the Action,
and blocks the source item. Checkpoint facts retain the requested operation,
paths and permission/question intent for audit; they cannot grant authority.

An insertion, validation or transition failure rolls back all three records
and their change cursors. The runner aborts on that failure and records an
error. On success the runner aborts the backend and waits for it to unwind;
no human approval promise remains parked. Terminal Activity accounting settles
the reservation after that unwind. A crash
after commit leaves a durable decision and releases conservative reservation
charges through the existing budget recovery path.

## Resolution and snooze

The resolver (`createInboxResolver`, `packages/ui-server/src/inbox/resolve.ts:34-114`)
rechecks the durable principal and derives the current operation
envelope from server code. It validates raw persisted options against the
strict v1 schemas, rather than trusting the permissive display projection.
Creation freezes the options in an immutable lifecycle context; application
also refuses an altered option set. Requested tool, full JSON input and target
must match the current envelope. Deferred effects and authority fields fail.

A final decision records one write-once resolution, supersedes every source
item blocked by that Action, and moves the Action to `resolved` or `dismissed`.
Only `enqueue` inserts executable work, with identity and dedup key derived
from `(action_id, option_id)`. All writes share the transaction. A replay of
the same decision returns the existing result; a different winning option or
feedback value cannot overwrite it. The operation is checked again even on
replay. Execution later requires its own budget admission and runtime authority.

Snooze is nonterminal and writes no final resolution. Low-stakes decisions
resurface at 08:00 on the next weekday in the configured timezone; higher
stakes use exponential one-to-eight-hour backoff. UTC epoch milliseconds are
stored. Retention for the Action and its blocked work extends through at least
one day after resurface, so expiry cannot erase the decision before it is due.
A deterministic sweep returns due Actions to `pending`; no model picks the
time or revalidates a premise. Dismissal needs no reason. The four optional
feedback reasons are audit data and confer no authority.

The existing authenticated WebSocket handles `inbox_resolve` and
`inbox_snooze`, publishing changes through the existing subscriptions. Refusal
returns the existing error envelope with `INBOX_DECISION_REFUSED`. Embedded
hosts without a decision handler return `INBOX_UNAVAILABLE`. Until the full
autonomous engine supplies current exact-operation authority, `createApp`
uses an empty operation envelope: operation-bearing approval fails closed.
Cancel, dismissal and deterministic snooze remain available. The default
timezone is UTC, or the configured inbox budget timezone.

## Cap, expiry and suppression

Every engine/budget decision admission enforces the default 60-open-decision
cap in its transaction. Pending and snoozed decisions count; FYIs do not count
and cannot evict a decision. Expired decisions retire first. Eviction chooses
the lowest current priority, then oldest creation time, then bytewise ID.
The incoming candidate participates in that ordering.

This implements the design's atomic compensation branch: a losing blocking
Action and every item it blocks commit as `dropped` and `superseded`, with
cleanup journaled when the thread has no remaining work or decisions. The
invariant holds even if all 60 incumbents block work or the incoming Action
loses. No committed blocked item points to an evicted Action, and admission
never requires a 61st open decision to preserve an outcome.

Each eviction or expiry emits one retained FYI and class-keyed suppression
with evidence boundary, expiry and a re-raise condition. Equal evidence before
suppression expiry cannot raise another open decision. Changed evidence or
expiry permits re-raise; a suppressed escalation still commits its checkpoint
and a terminal compensated outcome. FYI expiry does not recursively emit FYIs.
Queue expiry also reports one FYI. Active claims retain their lease until
unwind or lease recovery; no sweep removes a running worker's staging.

## Retry and filesystem compensation

Failure releases a claim into bounded exponential backoff: 60 seconds,
120 seconds, and so on, capped at one hour. Exhausted attempts remain failed
and produce one stable dead-letter Action. Cooperative yield returns unfinished work to ready after settlement; exhausted
yields use the same dead-letter path and retain completed-call receipts.
Dismissing that Action terminates its source and journals cleanup. Cleanup failure itself produces one FYI and
retains the failed compensation record for inspection/recovery.

`cleanup_pending` is server-owned work, not a model effect. Its compensation
(`createInboxCleanup`, `packages/ui-server/src/inbox/cleanup.ts:14-83`) counts no model
operation and takes no spend reservation. Compensation claims it before I/O,
removes the server-selected staging directory and partial directory
idempotently, then acknowledges `done` in a separate transaction. A crash
between removal and acknowledgement safely repeats removal after lease
recovery and backoff. Staging root symlinks and invalid IDs are refused; final
entry symlinks are unlinked rather than traversed.

Staging stays available while a thread has active work, a pending decision or
an acquired backend attempt awaiting unwind and accounting settlement.
Cancellation, dismissal, expiry and Action-cap eviction can retire Queue work
before that backend returns. Cleanup checks the actual attempt lifetime and
unsettled reservation both before admitting compensation and under its claim
transaction, including compensation already journaled. An enqueue-bearing decision
cannot resurrect staging after cleanup has started; it needs fresh intake.
Boot and drain maintenance reconcile these records without inference. The
complete production dispatcher, containment and system proof remain the
enablement gate described in the async-collaboration decision.
