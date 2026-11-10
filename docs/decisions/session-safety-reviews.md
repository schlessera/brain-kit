# Owner-reviewed session safety and prospective trust

**Maintainer decision, 2026-11-05:** individual finalized-trigger review may
restore normal policy, and Settings may manage future source trust with
separate recipient permission. The ruling is recorded in
[#3596](https://github.com/schlessera/brain-kit/issues/3596) and
[#3597](https://github.com/schlessera/brain-kit/issues/3597), with the
[complete design](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590345)
and [requested review disposition](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590730).
This ADR records that ruling and its binding constraints. It does not implement
an API, enable a trust rule or establish runtime qualification. The
[future implementation contract](../plans/reviewable-session-safety.md#proposed-version-1-data-contract)
pins DTOs, explicit numeric bounds, matching, ownership and proof obligations.

## Conditional G6 supersession

[G6](governed-writable-workers.md#untrusted-input-g6) now records every trigger
and restricts unknown/incomplete histories through the durable collection
foundation (#3600). The host-only verdict store (#3601) commits individual
decisions and durable receipts. The owner review transport (#3603) uses that
store through a strict two-phase HTTP boundary, with live password-mode human
authority checked on the acquired transaction and final delivery. Its
capability remains separate from read support and all standing-rule flags.
This ruling supersedes only
unconditional stickiness: a fully observed chat may return to normal **only
after every unresolved trigger has its own committed safe verdict**, complete
versioned detector coverage is established and no recording/capacity failure
remains. Trusted future inputs have immutable trust-decision evidence rather
than unresolved triggers. A human verdict accepts retained input; it never
removes that input from context or proves it objectively safe.

Every distinct signal is retained while already restricted. A, then B, then C
from A's origin have independent identities. Resolving A and saving its origin
rule leaves B and C unresolved; only future matching D can use that rule.
Resolving B leaves C. Resolving C can restore normal only with complete
coverage. There is no session-wide clear, historical origin/repository clear,
range verdict or verdict inherited by later input.

Only finalized bounded exposure is reviewable. Open streams/tunnels, delayed
results and interrupted/unknown delivery stay unresolved. Ending an operation
allows review only after host proof that delivery ended; later segments need
new occurrences. Evidence, lifecycle transitions, decisions and historical
policy hashes remain append-only host records.

## Coverage, identity and bounded evidence

Completeness is relative to the enumerated versioned detector contract, never
all possible untrusted content. Applicable input/output signals are independent;
trusted input does not suppress an untrusted search output or explicit user
mark. Disclose the proxied-shell local-read exclusion and opaque transport
limitations. Unsupported collectors prevent capability advertisement.

Every pre-upgrade history is classified, including those without old taint
rows. A first-taint row proves that event, not absence of later triggers.
Imported/resumed/forked histories and backend changes retain unknown epochs
unless explicit tested reconstruction proves completeness. Reviewing known
legacy events cannot clear unknown history; offer a new chat instead.

Use actual session/history owner, generation, native aliases and retirement
boundaries. Preserve provisional first-turn evidence through safe binding;
never guess correlation or create sessions from late callbacks. Auth revocation
and session deletion invalidate read cursors, subscriptions, pending reviews
and retries. Follow [local deletion](chat-history-deletion.md), including
permanent minimized non-content fences and retained independent audit owners;
this ruling grants neither recursive audit erasure nor fence expiry.

Aggregates are durable and independent of paginated detail. Page completeness
is distinct from detector completeness. Detail pruning never drops unresolved
IDs or minimal audit facts. Finite queues/rows/bytes, unbound retention and
idempotency lifetimes have explicit hard ceilings in the plan. Reserve verdict
and failure capacity before ingestion; stop/restrict before overflow loses a
signal. A failed pending write must not disappear into apparently normal state,
including across restart. No test count or arbitrary cleanup TTL proves safety.

### A recording failure restricts what it puts at risk (#3812)

Ruled by the maintainer on 2026-11-09, under
[proportionate containment](proportionate-containment.md). "Restricted" means
running under the tainted policy, not refusing.

- **Before delivery** (a failed collection begin, or a refused record of a
  tool's input, which the backend awaits before the tool runs): the one turn
  is refused with `SAFETY_RECORDING_UNAVAILABLE`. Nothing latches. A tool's
  result is never before delivery: its bytes exist when it is recorded, and a
  runtime may keep them in its own session (the Claude runtime replays them
  on resume), so a result that cannot be recorded is lost after delivery.
  A refusal for spent room says what frees it: a full chat needs a new chat
  (`safety_recording_chat_full`), and a full brain cannot be helped by a
  retry (`safety_recording_brain_full`). The room for first turns not yet in
  a chat is full only when ended collections alone fill it; room that a
  running turn or a pending write holds frees itself, so that refusal is a
  plain retry.
- **Lost after delivery**: the turn's own collection takes the failure and its
  first cause, so its chat keeps a permanent gap projected as
  `recording_failed` and that producer stops. Other chats are unaffected. A
  reservation still open when its collection ends becomes the same gap.
  Between a tool running and its result's record, nothing may skip both: a
  stopped turn still records the result (stopping refuses new tools, never a
  record, and a collection's end waits, bounded, for a record already under
  way), a report the host refuses before its record (a malformed or
  replayed Pi report) and a result for a call whose input record failed both
  leave the gap. The host does not rely on the runtime to report a result:
  the Claude runtime dispatches neither result hook for a turn stopped while
  a tool runs, and still keeps that call in its session. So every call
  `begin()` admits is an obligation, recorded before the tool runs, until its
  result is durably recorded or the backend refuses the call (a refusal, or
  a rejected `begin()`, proves it never ran). That proof holds only until
  the backend lets the call run: the Pi dispatcher's allow, the Pi gate's
  pass and the Claude permission callback's allow are noted before the call
  runs, and from then on a later refusal, rejected `begin()`, stopped turn or
  replayed request for the same call discharges nothing; only its recorded
  result does. A result's last record and its discharge commit together. A
  collection that ends owing one, however it ended, and an obligation still
  open at boot, leave the same permanent gap.
- **Evidence store unwritable** (the chat fact cannot commit): the brain
  latches through the emergency reserve, or, when even that fails, in the
  host process. New turns still begin, each with a permanent
  `recording_failed` gap committed before delivery, and run restricted. A turn
  is refused only when that restricted begin itself cannot commit
  (`safety_recording_paused`). The host keeps retrying, backing off to once a
  minute, and clears the latch itself with `recoverSafetyRecording` semantics
  once every producer that predates it has ended, failed or not; only turns
  begun restricted after that latch run beside it.
- **Boot** resolves a set latch and pending reservations after restart
  classification, gaps first. A legacy row that cannot migrate gaps its own
  turn. The server never boots into refusing every turn.

Every latch keeps its first cause (class, message, bounded stack, call site,
turn, time) and a count, logs one structured line, and is visible to the owner
on `/api/status`, also while only the host process holds it. Every recovery is recorded with its trigger, actor, time and
cleared cause. The owner route (#3810) is a fallback with the strict
quiescence precondition. Only a capacity check classifies a failure as
`capacity`. No gap ever clears, and nothing here lets an unrecorded input
become clean.

## Human authority and policy publication

Initially **only a live password-mode human owner** may commit a verdict or
change trust through Settings. Proxy, tailscale and local/no-auth ambient modes
are read-only until a separately qualified human-owner mechanism exists. Reads
remain within existing authenticated history/session visibility. Agent, voice,
model/tool, system, caller-supplied principal and forged UI/channel fields grant
no mutation authority. Bind and recheck brain, session generation, principal,
reviewed bytes/base and authority epoch at commit after asynchronous waits.
The [plan's matrix](../plans/reviewable-session-safety.md#authorization-and-admission-matrix)
also preserves current private reference-grant boundaries.

Protected Markdown is authoritative with empty built-in trust lists. Reuse or
extract the descriptor-bound protected publisher; no second privileged writer
and no fabricated agent turn. A human Settings operation has its own host audit
identity and exact reviewed policy bytes/base hash. No personal accounts,
configuration or real deployment details belong in the public tree.

Source trust and recipient permission are distinct. Incoming trust never
silently permits sending data while another trigger restricts the chat.
Recipient permission defaults off and needs its own explicit review. Exact
web origin, explicit opaque tunnel, verified repository and verified current
owner namespace are separate selectors. No wildcard, hostname-wide GitHub
exemption or timestamp/argv inference follows. Owner scope explicitly includes
future repositories in that current namespace; stable IDs plus approved-owner
boundaries prevent name reuse/transfer from silently inheriting exact-repo trust.

Rules apply only prospectively from publication revision; Settings CRUD clears
no past occurrence. Combined rule-plus-verdict first publishes/proves the exact
rule, then commits only the selected finalized verdict. Prepared, published,
verdict, partial and unknown stages are durable and recoverable. Equal file
bytes alone do not prove publication. Failed publication leaves the trigger
active; a later verdict failure returns partial/unknown and never blind replay.
Report if a different device has since removed the saved rule. Bound idempotent
request identity and reject changed-body/expired/deleted-session retries.

## Live enforcement and independent controls

One revisioned projection supplies proxy, backend outward admission,
policy-derived allowances and new journal attribution. Revalidate
`(evidenceRevision, trustRevision, authorityEpoch)` immediately before
irreversible dispatch, after every async wait. Pending input restricts
immediately; pending verdict never loosens before commit. Preserve original
journal/egress facts and historical approvals.

Admission's evidence revision follows the canonical session scope. Brain-wide
history/review revision changes from unrelated sessions retain pending authority.
Read the scoped aggregate, immutable append sequence and membership together;
history adoption and local pending/loss changes advance admission even when the
global cursor does not. Pending-input overlays and capacity grouping use the
same retained aliases. The history/review cursor keeps its existing meaning.

Only effective taint and the trust slice update live. Ordinary governance
budgets, profiles and commands keep turn-bound semantics. Trust removal fences
new active-turn dispatch before its enforcing receipt; ongoing input must split
or stop at the removed-rule boundary. Invalid publication retains last-valid
policy with an honest error. No retroactive recall or automatic operation replay
is implied; stale cards terminate through the existing coordinator.

Deny/allowlist rules, byte ceilings, credentials, provider routing, Git writes
and force-push approval, outward effects and voice authority remain independent.
Private Git still requires a live principal's repository/credential grant.
Repository rules cannot enforce until actual repo/ref/read transport and stable
identity are qualified. Initially only immutable managed-source bytes qualify;
mutable worktree lineage is insufficient. A bounded qualification may choose
explicit managed acquisition instead of transparent Git interception. Individual
recovery and origin Settings need not wait for repository transparency.

**Metadata authority ruling, 2026-11-05:** the maintainer selected a fixed
host-owned GitHub API metadata path for private repository identity in
[#3613](https://github.com/schlessera/brain-kit/issues/3613#issuecomment-6656692128).
It requires a live repository grant and separate credential-recipient checks;
an existing github.com credential grant does not implicitly authorize
api.github.com. Bind the operation to the canonical repository, brain and live
principal, recheck after waits before dispatch/publication, and include metadata
bytes/retries/cancellation in acquisition limits. No worker-selected URL,
generic authenticated relay or credential probing is authorized. Public metadata
remains anonymous; unknown, stale or mismatched identity supplies no trust.
This permits the bounded implementation, not an unqualified runtime exemption.

## Provider history and versioning

[Provider history](provider-history.md) stays byte-identical as a prefix: no
rewritten system prompts, tools, earlier messages or scripted answers. UI
annotations/decision receipts remain host-owned. A necessary changed fact may
appear once in the new tail; old sticky wording is not regenerated on upgrade.
Both keyless provider-history guards are implementation proof obligations.

Changing effective stickiness is **breaking before 1.0**. Each implementing
commit/PR must carry `CONTRACT:` metadata, same-commit authoritative contract
updates and `contract`; the semantic-break implementation also carries
`breaking`, this prior maintainer ruling recorded on its issue, and a minor
changeset naming the break, under [contract versioning](contract-versioning.md).
The proposed policy, SDK history/update and query/review contracts ship only
with their implementations and capability negotiation. This design-only ADR
changes no current schema, runtime behavior, package artifact or release version.
