# Decision — Google Workspace through governed host tools

**Decided 2026-11-17 by the maintainer on [#4201](https://github.com/schlessera/brain-kit/issues/4201)**,
after three review rounds of the plan in
[`docs/plans/google-workspace.md`](../plans/google-workspace.md). Binds the
Gmail epic (#4201), the Calendar epic (#4220) and later Contacts and Tasks work.
Nothing here is built yet; this is the record the build is held to.

## The shape

Gmail and Google Calendar reach a hosted turn only through a fixed set of host
tools, modelled on the [host GitHub tools](governed-writable-workers.md#outward-actions-g5)
(#3791) and the [Apify front doors](apify-capability.md#front-doors-and-memberships-3162).
Operations, schemas, the effect classifier and the decision function live once
in `@schlessera/brain-common`; the UI server owns the credential, the principal
check, the approval exchange and durable recording. The worker never holds a
Google credential, a gog home or a `GOG_*` variable.

Every call carries an **effect class**, computed by the host per call from the
validated input and facts it reads itself, escalating only:

- `read`: changes nothing at Google;
- `reversible`: changes only the owner's own account, is invisible to anyone
  else, and has a recorded inverse brain-kit can execute;
- `irreversible`: visible to someone else, destroys what brain-kit cannot
  restore, or anything the classifier does not recognise.

Policy acts on the class, per operation and per entity, from a top-level
`google` block in `context/policies/governance.md`. Reversibility decides what
may be admitted without a card and what the journal can undo; it never grants
authority by itself ([voice-permission.md](voice-permission.md)).

## Rulings

1. **Taint.** A read whose result is composed only of host-validated structured
   values does not taint: Google-minted Gmail ids, label ids and names,
   host-minted handles for calendar objects and page cursors, RFC 3339
   timestamps, non-negative integers, size buckets, booleans, closed enums and
   free/busy intervals. A value that fails its validator is dropped. Email
   addresses, calendar ids and event ids are never structured: an address's
   local part is attacker-chosen, a calendar id is an address, and an inviter can
   choose an event id. Every other result taints the session as `google_result`
   before it returns. A structured read records no safety occurrence; its
   collector obligation is discharged with nothing to record. In a tainted
   session every Google write asks, and policy `allow` and remembered approvals
   do not apply, unless the owner grants a **session allowance** on a reversible
   card: "allow this operation on this entity for the rest of this session".
   An allowance lasts at most 24 hours and never past the host process that
   granted it, admits at most 100 items in all, is void on a policy-hash change,
   on loss of the principal's authority or when the session returns to normal
   policy, and never transfers on handoff, fork or import.

   This amends **G5**: an own-account reversible Google write with a recorded
   inverse is not an outward action, and may run without a card under policy
   `allow` or a remembered approval in an untainted session, or under a session
   allowance in a tainted one. Every other Google write stays outward, asks every
   time and is journaled as irreversible. It amends **G6**: a structured Google
   read is not untrusted input. Both amendments are recorded at their sections in
   [governed-writable-workers.md](governed-writable-workers.md).

2. **Transport.** gog (gogcli, MIT) drives every v1 operation, behind an
   unexported operation-level boundary so single operations can move to direct
   REST without touching the governance layer. The host accepts only listed gog
   versions, each with the sha256 of its release binary, starting with 0.48.1.
   The comparison and the triggers for moving an operation are in the plan's §8.
   gog's measured cost was about 2 s per invocation on a development machine.

3. **Integration branches.** Each landing increment of these epics is built on
   its own integration branch and lands on `main` as one ordinary PR, as an
   exception to the stack rules ([github.md](../process/github.md#integration-branches)).

4. **Standalone.** The `brain google` CLI offers reads and reversible writes.
   Reversible writes run only under `google.standalone.reversible: allow` where
   the operation's effective mode is also `allow`; a terminal never shows a card,
   so `ask` refuses. Irreversible operations never run standalone. A local agent
   with shell access is inside the standalone boundary, and the CLI says so.

5. **Label names.** Every label name in the account's label list counts as
   structured, capped at 225 characters, with control, bidirectional and
   zero-width characters escaped.

6. **Voice.** Voice never grants. A call that needs a card refuses in voice
   posture before the card is shown, as GitHub writes do. A call that standing
   admission already admits runs in voice, including under a session allowance
   the owner granted on screen.

## Adopted defaults

The epics assume these until the maintainer rules otherwise on #4201:

- No remembered approval for an irreversible operation; every irreversible call
  shows a card.
- A card-less write that sends model-written text to Google is routed under G2
  as recipient `google`; a write whose exact payload is on a card is gated by the
  card, as GitHub writes are (#4029).
- The Google tools serve the brain's owner only.
- A hosted account is connected by its operator from a shell
  (`brain google connect --remote`); an in-app OAuth flow is later work.
- `google.gmail.hidden_labels` keeps chosen threads out of every result and
  every write target. Mail the model reads otherwise reaches its provider.
- Inverses are recorded from the first write increment; undo from the journal
  ships after writes and never blocks them.
- No outbound attachments and no HTML drafts in v1; incoming attachments are
  metadata only.
- The policy block is top-level `google`, beside `apify`, because it governs
  reads and reversible writes as well as outward ones.

## Accepted residual risk

- Timestamps, counts, flags and whether a query matched are channels a sender
  can influence. They carry no instruction a model would follow.
- Label names created by another app, an IMAP client or a filter can carry text;
  ruling 5 accepts that.
- A draft can be edited by another mail client between the send card and the
  send. The host sends the exact bytes it showed, so an edit made after the card
  is not sent, but neither is it shown.
- On a standalone machine, a local agent can run gog or read its keyring itself.
  Read-only scopes by default are the only enforcement there.

## Stores chat-history deletion must cover

Session-keyed Google state lives in the UI server's database and is deleted with
its session under [chat-history-deletion.md](chat-history-deletion.md): session
allowances, inverses and their snapshots, send locks and calendar handles. The
common ledger holds only remembered approvals, sent-message digests and
standalone inverses, which hold no message bodies.

## Rejected

- **A relayed gog in the worker.** It would put the credential where the model
  runs, the alternative the GitHub ruling already rejected for `gh`.
- **Applying G6 as written with no exception.** Every Google read taints and a
  model needs a read to obtain any id, so policy `allow` and per-entity
  approvals would almost never apply.
- **A configuration-gated, session-stored roster.** The tool list never depends
  on configuration; the Google tools join every interactive roster, always
  loaded, and decide availability at call time.
- **Direct REST from day one.** Most of the work before the first read; kept as
  the per-operation migration path.
