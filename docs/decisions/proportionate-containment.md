# Fail-closed guards contain proportionately

brain-kit fails closed: when it cannot tell whether something is safe, it does
not proceed as if it were. That stays. This record is about the other half of
the rule, which was missing: **how much** a guard shuts down when it fires, and
**how** it gets back.

Ruled by the maintainer on 2026-11-09 (#3812). Tracked under #3813.

## What went wrong

A hosted instance refused every turn in every chat. One turn's safety-recording
write had failed, and the guard reacted by setting one durable flag for the
whole brain (`latchSafety`,
`packages/ui-server/src/governance/safety-store.ts:115-125`). From then on, turn
admission threw for every chat, including new chats that had never seen
untrusted input (`beginSafetyCollection`,
`packages/ui-server/src/governance/safety-store.ts:183-192`). The error that
set the flag was recorded as "capacity" while the store was at a fraction of a
percent of its limits, and its real cause was never stored. The only way back
was to stop the server and run `recoverSafetyRecording` from a script, a
function with no production caller, which needs no judgment: it marks the
affected chats with a permanent gap, so they stay restricted, and clears the
flag.

Each part of that was defensible on its own terms: an unknown must not become
clean. Together they turned one recoverable error into an outage, and nothing
gained any security for it. Audit of the other guards then found the same
shape in several places (#3815, #3816, #3817).

## The rule

A fail-closed guard answers five questions, and the answers are part of its
design, not an afterthought.

1. **Scope: the narrowest thing whose state is uncertain.** Restrict the turn,
   chat, record, allowance or backend that the failure actually touches. A
   brain-wide or process-wide state is justified only when the failure really
   is brain-wide, such as the evidence store itself being unwritable.
   - Proportionate: a lost taint record marks *that chat* with a permanent gap.
   - Disproportionate: a lost taint record refuses every chat in the brain.
2. **Restrict before refusing.** Where a restricted mode satisfies the threat
   model (the tainted policy, read-only, degraded health, one item dropped),
   use it. Refuse outright only when the restriction itself cannot be
   enforced, and say in code which case that is.
   - Proportionate: a chat with incomplete taint coverage runs under its
     tainted policy.
   - Disproportionate: the same chat is refused with "requires recovery".
3. **Recover automatically when recovery needs no judgment.** If the recovery
   step is mechanical (rebuild a derived index, retry an idempotent delete,
   record the gap and clear the flag once writers have drained), the host does
   it. Keep conservative charges and permanent gap facts while it does. Never
   stop at a fixed retry count and wait for a restart. Keep reconciling at a
   lower frequency instead.
   - Proportionate: an uncertain worker cleanup stays charged and is retried
     until a close is confirmed.
   - Disproportionate: after five refused closes, the allowance stays charged
     until the server restarts (the terminal give-up removed by #3815).
4. **Boot.** A recoverable historical record (a corrupt object, a malformed
   intent, an interrupted cleanup) is quarantined and marked, and the host
   boots. If it must, it boots restricted, with the unsafe operation still
   refused and authenticated diagnostics available. A configuration error
   that degrades one optional capability degrades that capability, not boot.
   - Proportionate: one corrupt undo object makes the entries that reference it
     non-restorable.
   - Disproportionate: one corrupt undo object stops the server from starting
     (`recover(objects)`,
     `packages/ui-server/src/brain/journal-accounting.ts:231-245`).
5. **Diagnosable.** Every latch, give-up, quarantine or restricted boot records
   its cause durably (error class, message, call site, scope, time), writes one
   structured log line, and is visible to the owner. A cause that is only in a
   container log is lost on the next redeploy. Never classify an error you did
   not test for as a known reason.

## What this does not change

- **An unknown never becomes clean.** A gap fact is permanent on what it
  covers; an uncertain charge is never released before the uncertainty
  resolves; a restricted chat stays restricted until reviewed.
- **Exposure guards stay absolute.** A publicly reachable UI without auth still
  refuses to boot, and the renderer is still denied egress
  ([ROADMAP "What binds future work"](../../ROADMAP.md#what-binds-future-work), item 5). Those refuse the
  thing that is exposed, which is already the narrowest scope.
- **Recovery that needs judgment stays manual.** When a human must decide
  something (which version of a conflicting file wins, whether to trust a
  source), the guard stops and asks. This rule removes manual steps only where
  the human adds nothing.

## Checklist for a new or changed guard

A PR that adds or changes a fail-closed guard answers these in its body:

- What exactly triggers it, and which failures does it *not* cover?
- What does it restrict, and why is nothing narrower enough?
- What restricted mode was considered before refusing, and why was it rejected?
- How does it clear: automatically (where?), or by which owner action, and
  why does that action need a human?
- Where is the cause recorded, and how does the owner see it?
- Which test shows a failure in one scope leaves another scope usable?

## Alternatives rejected

- **Fail open on recorder errors.** Rejected: an unrecorded untrusted input
  would let a prompt-injected chat run with full permissions.
- **Keep brain-wide latches and add an owner recovery button.** Rejected as
  the whole answer: it shortens the outage but keeps it, and the human pressing
  the button decides nothing. An owner recovery route remains as a fallback
  (#3810).
- **Restart the server on latch.** Rejected: a durable latch survives restart
  by design, and a process-lifetime one hides the cause.

## The two historical boot gates traced in #3817

The acceptance criteria permit retaining a boot refusal where tracing shows
that the current host cannot enforce the proposed restricted mode. These two
refusals remain; they are not covered by secondary-backend degraded health.

**Failed protected-file quarantine.** The result is a protected executable
input still in the brain, not merely a missing history record. The host
reconciles before it prepares the boundary or invokes the brain's CLI;
`reconcileExisting` refuses before installing its writer gate
(`reconcileExisting()`, `packages/ui-server/src/brain/host-execution.ts:100-113`).
The CLI version probe itself evaluates the brain's execution environment.
A read-only UI that continued this normal startup would already have crossed
the forbidden evaluation boundary before serving diagnostics. Neither a
strict turn profile nor a writer lock makes that configuration trusted.
Therefore the full app still refuses when quarantine cannot move the input.
The manifest retains the failed paths and error text with an open end record;
reconciliation retries the move on the next start
(`const close`, `packages/ui-server/src/brain/governed-manifest.ts:258-267`).
Repairing the quarantine destination preserves the bytes and permits that
retry; removing a protected input requires the owner's judgment. A separate
boot path that never evaluates the brain would be needed to serve recovery
while this guard is active; removing the assertion alone is unsafe.

**Interrupted operational restore.** This is an incomplete replacement of the
whole operational database and staging tree, including principals, schedules,
retained dialogue authority and budget reservations. It is not a single inbox
item. Resume accepts only the original snapshot checksum and root and an
unchanged logical database
(`restoreInboxSnapshot`, `packages/ui-server/src/inbox/snapshot.ts:428-445`).
Even ordinary authentication writes would make that target fail the equality
check. The final transaction settles reservations conservatively, pauses
schedules and invalidates old dialogue authority before marking it ready
(`const recovered`, `packages/ui-server/src/inbox/snapshot.ts:463-480`).
Starting the regular authenticated app over the pending database cannot
preserve this recovery contract, so its refusal remains. The existing local
`brain-ui-inbox restore --db <database> --brain-root <brain> --file <snapshot>
--json` operation resumes the same snapshot without starting the app. Choosing
the snapshot is an owner action; the snapshot bytes are not retained by the
pending row, so startup cannot reconstruct them automatically. Serving a
recovery UI here would require authentication independent of the database
being restored, rather than treating its historical principals as current.
