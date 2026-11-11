# Reviewable session safety and trusted sources

## Outcome and authority

A person can inspect the inputs that put a chat into tainted mode, mark one
trigger safe, and manage the origins and GitHub repositories or owners they
trust. Clearing one trigger never clears another trigger, including a later
one from the same source. A chat returns to its normal policy only when every
recorded trigger is resolved and the host knows its trigger history is complete.

The maintainer requested these semantics on 2026-11-05. The settled boundaries
are recorded in [the decision](../decisions/session-safety-reviews.md). This deliberately
supersedes G6's unconditional session stickiness once implemented. It preserves
append-only evidence and provider history, restrictive admission on uncertainty,
ordinary deny/allowlist rules, budgets, credential boundaries and outward-action
approvals. This is a design for future implementation; the current runtime is
not changed by this document. Work and readiness belong in the issue tracker.

Trust configuration belongs to the served brain, with empty built-in lists.
Actual accounts, organizations and deployment configuration never appear in this
public design or its fixtures. Fictional examples use the Odysseus world.

## Existing boundaries at the reviewed base

- Taint recording retains every independently observed signal and reads a
  durable revisioned aggregate, including pending/failure and explicit unknown
  coverage (`safetyProjection`,
  `packages/ui-server/src/governance/safety-store.ts:415-420`). Legacy rows prove
  their own event, never a complete history. Owner review transport and its
  mutation capability remain disabled by this foundation.
- Tool ingestion collects input and output signals independently (`inputTaintSignals`,
  `packages/ui-server/src/activity/ingestion-taint.ts:150`;
  `outputTaintSignals`, `packages/ui-server/src/activity/ingestion-taint.ts:172`).
  Workspace paths taint regardless of repository ownership. Awaited backend
  hooks commit before tool dispatch/result delivery; display frames alone
  never prove finalized delivery or complete coverage.
- The turn proxy records each admitted non-provider connection and terminal
  exposure observation (`prepareTurnEgress`,
  `packages/ui-server/src/brain/turn-egress.ts:84-272`). Relay admissions join
  this proxy's submitted terminal observations and its own announced session
  binding before reading fresh safety (`settleTurnSessionBinding`,
  `packages/ui-server/src/ws/bridge-session-binding.ts:14-28`), without excluding
  independent pending input. A raw CONNECT reveals
  only an authority and opaque bytes, not a repository path or inner protocol
  (`startEgressProxy`, `packages/ui-sdk/src/server/egress-proxy.ts:124-359`).
- Outward decisions read session taint at admission (`prepareOutwardPlan`,
  `packages/ui-sdk/src/server/outward-policy.ts:47-94`). Existing historical
  steering attribution must remain attribution at the time of a write.
- Governance policy is protected Markdown, validated by a strict schema
  (`GovernancePolicySchema`, `packages/common/src/governance-policy.ts:101-130`).
  The privileged proposal writer already provides exact-base review,
  descriptor-bound publication, authority rechecks and crash receipts
  (`createPolicyProposals`, `packages/ui-server/src/brain/policy-proposal.ts:76-240`).
- Private reference access already matches canonical repository prefixes and
  live principal grants; that is access authority, not content trust
  ([reference-source grants](../decisions/reference-source-grants.md)). Its
  fixed Git transport separates network acquisition from credential-free,
  network-free checkout (`createReferenceTransport`,
  `packages/ui-server/src/brain/reference-transport.ts:97-170`).
- The Security and Devices & agents surfaces already exist; policy facts are
  currently read-only (`AgentPolicyGroup`,
  `packages/ui-react/src/components/settings/agent-policy-group.tsx:8-51`).

The original source review used main
`35217d283b849b5ef81700d5d4c2ec7486405d12`; the current collection path retains
input **and** output signals (`if(!safetyHooked&&ingestion)`,
`packages/ui-server/src/activity/recorder.ts:384`). These collectors provide the internal coverage/projection foundation. The
read-only history DTOs and recovery follow the [authoritative wire contract](../integration-contract/wire.md#session-safety-history-additive-3604); public
review and Settings mutation remain prospective. The earlier design
comment also inspected local #3595 work; this document does not assume that
work has merged. #3595 is adjacent scoped network approval, not persistent
trust or taint resolution. The extraction-classifier spike #3434 remains separate.

This plan transcribes the [complete reviewed design](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590345)
and [review disposition](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590730).
The concrete DTOs and bounds below refine that future design; neither the
comment's source review nor this plan is runtime qualification. Implementation
scope and dependencies live in [#3596](https://github.com/schlessera/brain-kit/issues/3596),
[#3597](https://github.com/schlessera/brain-kit/issues/3597) and
[#3598](https://github.com/schlessera/brain-kit/issues/3598).

## Every trigger, plus an effective state

Keep an append-only ledger of taint occurrences and explicit owner decisions.
An occurrence has a stable host-issued identity, session/history-owner and turn
identity, server sequence and time, source kind, bounded/redacted evidence,
operation identity when provable, and verified provenance when available. A
trusted operation still has an auditable trust decision and policy hash; it
never becomes an unrecorded assertion that the source was safe.

Persist every distinct occurrence, even after the session is already tainted.
Each occurrence has `open`, `finalized` or `interrupted/unknown` exposure state.
Only a finalized, bounded input exposure may be marked safe. A stream/tunnel
remains unresolved until it closes; the UI explains why review is unavailable.
Stopping the operation permits review only after the host proves input delivery
has ended. Later segments/results become new occurrences rather than inheriting
a previous verdict. A lost host or uncertain completion remains restrictive.

Deduplicate only the same host operation/occurrence identity, never by hostname,
repository, command text or a time window. Unknown attribution stays unknown.
Several signals may be displayed together only when their relationship is
proven; grouping never discards their independent identities.

A resolution references exactly one occurrence identity and the reviewing
principal, idempotent request identity, channel, timestamp and explicit safe
verdict. It never deletes or rewrites an occurrence. A compact, versioned
projection reports unresolved count, earliest unresolved source, history
coverage, durable revision and current restriction state. Repeated submission
of the same request returns its receipt; reuse with a changed body is refused.

Current state is normal only with complete coverage and zero unresolved
occurrences. Otherwise it is restricted, with distinct reasons for recorded
unresolved triggers and incomplete history. Pending new occurrences restrict
admission immediately. Pending safe verdicts never loosen admission before
commit. Database/write failures stop affected admissions rather than showing
success or treating unknown as normal.

The reducer and write worker serialize occurrence and resolution updates per
session. New events committed while a review is open remain unresolved. A safe
verdict authorizes only its immutable selected ID; a client cannot send a range,
"clear through", origin-wide historical update or session-wide clear.

## Persistent trust rules

Add a bounded `taint.trusted_sources` policy section with typed entries and
stable opaque rule IDs: exact web origin, explicit tunnel authority, exact
GitHub repository, or GitHub owner/organization. Include a user label, with
matching entirely independent of that label. The settings API exposes these
as the two requested lists: **Trusted origins** and **Trusted repositories &
organizations**. Defaults are empty; no personal account is compiled in.

An origin is a canonical scheme, hostname and effective port. Accept HTTP and
HTTPS origins without paths, credentials, query or fragments; define IDNA,
trailing-dot DNS, IPv4/IPv6 and unsupported-proxy forms in the canonical parser; lowercase DNS
names and normalize default ports. No substring, implicit subdomain or wildcard
matching. A raw CONNECT endpoint is shown separately as `host:port · tunnel`;
it cannot borrow a web-origin rule or pretend to establish HTTPS. No origin
rule covers a redirect destination automatically. Unknown or unverified
provenance offers only an occurrence-specific review.

A GitHub selector is exact `github.com` plus either one owner or one owner/repository,
matched at path-segment boundaries with GitHub's case-insensitive identity
semantics. Normalize an optional `.git` suffix through a single canonical
parser. Reject lookalike hosts, credentials, encoded separators, traversal,
extra path components and ambiguous remote helpers. Pin identity semantics in the repository qualification: owner rules explicitly
cover current and future repositories currently owned by that namespace. Exact
repo rules require a verified stable repository identity plus the approved
owner boundary: name reuse or transfer must not silently inherit a grant.
Rename, transfer and metadata unavailability need tested behavior before these
rules enforce. A name parsed from a worker-provided remote is not identity proof.
Supporting another Git host is a later concrete implementation, not a new seam.

A trusted source does not produce a new unresolved taint when a verified future
input matches its incoming-content capability. It still records the matched rule
ID, exact policy hash, collection revision and provenance, surviving subsequent
rule deletion. Auto-trusted input can be collapsed by default in history while
remaining inspectable. No origin rule overrides ordinary egress deny/allowlist
settings, byte ceilings, provider routing, credentials or outward write approval.
Repository trust never becomes a host-wide GitHub exemption or a Git push,
force-push or arbitrary configured `pull` permission.

Source trust and destination permission are separate capabilities on a rule.
**Trust incoming content** is the source-trust choice; **Allow sending data while
restricted** is an additional explicit origin/tunnel capability, off by default.
A source-only rule never bypasses a taint-network card after another trigger.
The review names that broader recipient effect in its primary control when
selected, not merely in helper text. Repo/owner rules grant source trust for
qualified Git reads only, never general recipient permission. #3595's one-time
and chat-session network grants remain independent, narrower-lifetime approvals.

Rules apply prospectively from their recorded publication revision. Creating,
editing or deleting a rule never reclassifies previously recorded occurrences.
Removing a rule affects future matching; it does not undo a person's historical
safe verdict. Changing a rule's target is a reviewed remove/add, retaining the
old audit identity. Duplicate/equivalent normalized entries are rejected or
returned as the existing entry, never shadowed silently.

## Repository identity must be enforced, not guessed

Raw Git shell commands and the existing shared TLS proxy cannot prove which
repository supplied a connection. A familiar directory name, `origin` string,
GitHub hostname or an overlapping tool-call window is insufficient. Checking
an argv then exempting the next GitHub connection would allow unrelated traffic
to borrow the decision.

Use a fixed, host-mediated Git read path with a canonical owner/repository
bound to the actual transport. Reuse managed reference acquisition and its
credential/grant checks where it fits. Qualify how ordinary `clone`, `fetch`
and `pull` reach that path without disabling existing raw Git behavior. An
owner-scoped smart-HTTP read relay plus injected Git URL rewrites is a concrete
candidate, not yet an accepted implementation: qualification must prove its
Git configuration, private-access, push, protocol, redirect and concurrency
behavior against installed Git. The spike must also prove that arbitrary worker clients
cannot use the relay as generic authenticated HTTP, credential probing,
receive-pack/upload or unrestricted object/ref acquisition. Every request binds
the live principal, allowed repo/ref/read operation, byte accounting, cancellation
and credential grant. Test protocol v2, URL-rewrite precedence, push URLs,
configuration overrides and revocation during parallel requests. If that candidate cannot enforce the boundary,
use an explicit managed operation rather than a hostname exemption.

The delivered [Git qualification](../../experiments/git-read-qualification.md)
selects explicit managed acquisition: the endpoint-only relay admitted an
unauthorized PR ref. Transparent rewriting remains unsupported for trust.
The maintainer's [metadata ruling](../decisions/session-safety-reviews.md#live-enforcement-and-independent-controls)
permits a fixed host-owned GitHub API metadata path with a live repository grant
and separate credential-recipient checks. Existing github.com authority does
not implicitly cover api.github.com. Recheck principal/grant/recipient authority
after waits before dispatch/publication; keep public metadata anonymous and
unknown/stale/mismatched identity restrictive. Metadata bytes, retries and
cancellation count toward acquisition limits. This design choice exposes no
generic relay or worker-chosen credential request and still needs production proof.

Private access continues to require the existing principal/credential grant;
trust is never permission to acquire a private repository. SSH, LFS, submodules,
redirects, custom helpers and fork/PR refs require independently proven provenance
and explicit handling. Initially only qualified ordinary branch/tag acquisition
may be trusted; PR/fork refs cannot inherit owner trust. Trusting accepted branch
content also accepts that it may include upstream contributions. `pull` is a
local mutation/configured execution as well as acquisition, so only a separately
qualified read phase is eligible. Unsupported paths retain their restrictions and
are surfaced as such. A trusted parent never grants a foreign submodule/fork.

The host records acquisition provenance and the immutable revision/root
identity. Initially only immutable managed-source bytes may inherit repository trust.
Directory lineage alone never blesses mutable content. Writable worktrees need
a separate bounded qualification of per-file/read-bound content provenance and
invalidation on edits, copies, merges, generated files and refresh. Until that
is qualified and implemented, their reads retain current restrictions. Rewriting local remotes or naming a
directory after a trusted owner cannot establish it. Symlink/hard-link escapes,
new nested repositories and foreign mounts cannot inherit trust. Explicit
user-untrusted file marks take precedence and need their own selected review.

## Mark as safe: resolve one event, optionally trust future operations

In the chat's host-owned history, render each restriction-triggering event
beside its operation where correlation is authoritative, otherwise as a named
network/source event within its turn. Show the reason, time, source, evidence
coverage and current verdict. Never identify an opaque connection as a specific
Git command merely because their timestamps overlap.

**Mark as safe** opens one compact scope chooser:

- **Only this trigger** is the default: resolve the selected finalized occurrence
  only. Display authoritative operation grouping and per-trigger counts, without
  promising that resolving one signal resolves every signal from the operation.
- **Trust this origin** is offered only with verified web origin, or an explicitly
  labelled tunnel destination. It saves incoming-content trust for the future and resolves only the
  selected finalized occurrence; destination permission is a separate unchecked
  choice with its own explicit effect.
- **Trust this repository** is offered only with host-verified repository
  identity. Organization-wide trust is managed separately in Settings so this
  action does not silently widen a one-repository decision.

The review shows the exact target, the standing rule's effect and the current
remaining-trigger count. Marking an input safe is a human risk decision: its
content remains in the model context. Other occurrences, including later occurrences from
that same origin or repository, remain unresolved. A settings-only CRUD action
changes no occurrence. After a decision, annotate the original event **Marked
safe by you**, append the human decision receipt, and show either **Normal
policy restored** or **Still restricted · N other triggers**. Coverage gaps have
separate wording; never print normal merely because a fetched page is empty.

Only the live owner can save trust or resolve taint in password mode. For the initial implementation, proxy, tailscale and local/no-auth modes are
read-only for trust mutation and safe verdicts until an independently qualified
human-owner mechanism exists; a proxy username or network location is not that
mechanism. Explicit capabilities explain this limitation. The access contract
pins read visibility, browser-origin/CSRF policy, commit-time revocation and
private-acquisition behavior for each mode. Existing reference-grant restrictions
are not bypassed for ambient principals. An agent credential, model
tool call, voice transcript, request-body principal, or a forged `channel: card`
never supplies that authority. Recheck authority/brain/session identity and the
auth epoch at commit. Auth revocation clears pending UI work without replay.

Reuse/extract the existing descriptor-bound protected publication core rather
than adding a second file writer or fabricating an agent turn. Settings review
has a host-owned operation identity bound to principal, brain, selected trigger,
exact reviewed bytes and policy base hash. Durable stages distinguish prepared,
file-published, verdict-committed, partial and unknown. Publication proof must
survive a restart; matching current file bytes alone is not proof that this
operation published them. Unproven crash completion remains unknown and needs
fresh review, never blind replay. For a combined rule-and-resolution request, publication is a recoverable
ordered operation: save the reviewed rule with an exact-base check, then commit
the single-event verdict. A crash/failure between those commits leaves the
original taint active. Return an explicit partial receipt when the rule was
saved but the event was not resolved; an idempotent retry must not silently
republish or clear a different event. If another device removes the rule
before verdict completion, the receipt states its current absence rather than
claiming that future trust remains enabled. A failed rule publication leaves the
original occurrence unresolved. No successful all-or-nothing claim spans the
Markdown and SQLite authorities without proof.

## Settings and transcript interaction

Place both trust lists in **Settings → Security**, separate from passkeys and
sign out, following the existing kit typography and controls. Each list has an
empty explanation, **Add origin** or **Add repository or organization**, full
canonical targets, and **Edit**/**Remove** actions with accessible names. Forms
use persistent labels, target-type validation and a specific Save/Remove review
that states the effect. Invalid policy and stale-base errors preserve the draft
and link to the enforcing policy. Show last-valid/default policy honestly.

At 320px, rows become stacked target/detail/actions with 44px targets and wrapped
host/repository text; desktop uses the same records with inline actions. No
settings rebuild or new visual language is needed. Preserve focus across edit,
removal, error recovery, drawer width changes and background invalidation.

Each affected entry has a compact indicator using the existing kit `policy`
icon (Lucide `ShieldAlert`) for unresolved taint, `secure` (`ShieldCheck`) for
an explicitly reviewed safe occurrence, and `unverified` (`CircleHelp`) for
incomplete/unknown evidence. Use these states with accessible text, never color
alone. The safe shield means **Marked safe by you**, not **Verified safe**.
A count represents multiple independently reviewable triggers on the same entry;
a collapsed tool run retains a summary indicator so hiding steps hides no risk.

Hover and keyboard focus expose the short reason and scope. Click, Enter/Space
or tap opens a persistent anchored details panel with source, timestamp,
provenance/coverage, verdict and the **Mark as safe** action. The indicator is a
44px reachable button with a state-and-count accessible name, expanded state and
focus return. Do not put actionable controls inside a tooltip. Touch details
stay open until explicit close or outside dismissal; Escape closes them. A
resolved marker remains in history and still opens its decision evidence.
Attach to the exact tool/message entry only with authoritative correlation;
otherwise use a separate turn-scoped network event, without blaming the nearest
message. Examples of accessible names are **Safety restrictions: 2 unresolved
triggers** and **Marked safe by you: show details**. Reuse the kit's icon map
(`ICONS`, `packages/ui-kit/src/primitives/Icon.tsx:131-193`).

The transcript uses a compact safety notice, not an assistant-generated message
or modal interruption. It records every new trigger even when another trigger
already restricts the session. Mark-as-safe pending/error/partial/safe states and
the session restriction count are shared between devices and recovered after
reload. A stale device cannot optimistically label the chat normal. A browser
with insufficient authority sees the event and its reason without grant buttons.

A 320px event can read:

    Safety restrictions enabled
    Git read · github.com/odysseus/navigation
    Source: fetched repository · 12 Jul, 10:00
    2 unresolved triggers
    [Mark as safe]

After reviewing this one event:

    Marked safe by you · 10:05
    Still restricted · 1 other trigger

The UI must also handle unavailable provenance, duplicate deliveries, unbound
first-turn session identities, rapid consecutive triggers, deleted sessions,
expired/pruned Activity detail, auth loss and cancelled requests. Structured
host evidence is text, never trusted HTML or model-provided instructions.

## Admission, history and compatibility

Remove sticky in-memory taint booleans and route proxy admissions, backend
outward decisions, policy-derived allowances and new journal attribution through
one revisioned live projection. Resolve-versus-new-event races must remain
restrictive. Pin an admission commit point immediately before irreversible
dispatch, using the tuple of session-evidence revision, trust-policy revision
and authority epoch. Revalidate after every async wait; an old `granted` boolean
cannot stand in for a live standing rule. Distinguish an explicit once grant
from authority derived from a rule that has since been removed. Failed
occurrence recording leaves a durable restriction/coverage latch until recovery,
not a pending entry that disappears while another turn can dispatch.

Only taint evidence and the new trust-policy revision become live within this
feature. Ordinary governance budgets/commands/profiles keep their admitted-turn
semantics; broad policy hot reload is out of scope. Successful Remove fences new
dispatch on active turns before its receipt reports enforcement; already
irreversibly dispatched operations cannot be recalled. Source-rule removal
while input is still arriving must finalize/split that exposure at the rule
boundary or interrupt it; later input never inherits the removed source grant.
Invalid trust publication retains last-valid policy and honest error facts.
A mid-turn human clear changes only later admissions; already
denied, approved or in-flight operations are not replayed automatically. Stale
pending approval cards are withdrawn/expired through the existing coordinator
before a covered operation is retried, with a visible terminal receipt.

Keep all historical egress/approval decisions, journal taint attribution and
policy hashes as facts at their original times. UI security annotations and
future human decision receipts live in host-owned storage. They never edit the
provider's system prompt, tools, earlier messages or scripted answers. If the
agent must learn a state change, only a necessary new tail event/tool result
may say it; do not inject internal ledger data into provider history.

Add bounded authenticated safety-history snapshots and incremental revisioned
updates to the SDK/host/client contract, using existing session/history identity
and replay boundaries. Include coverage, cursor/high-water identity and deletion
semantics. Define pagination and a complete-snapshot marker so page omission is
not mistaken for zero unresolved events. Auth revocation and history retirement apply to this host evidence too.
Keep aggregate unresolved state independent of paginated detail. Bound rows,
bytes, write queues and idempotency retention: capacity exhaustion stops/restricts
new ingestion before it can lose evidence, never silently drops a trigger.
Unresolved state and minimal audit/tombstone metadata survive detail pruning and
unbound-row retention until safe binding or explicit session retirement. Late
callbacks and expired request IDs cannot recreate a deleted session. Deletion
removes private evidence per the existing history contract while retaining only
the permitted bounded retirement tombstone for stale-reply refusal.

Coverage means completeness relative to a versioned enumerated detector
contract, never all actual untrusted input. Preserve and disclose the existing
proxied-shell local-read exclusion unless a separately qualified detector closes
it. Record all applicable input and output signals independently; a trusted
input does not suppress an untrusted output. Pin granularity for multi-file
searches, mixed sources and redirects; enumerate mandatory detectors and known
exclusions. Backend changes, resumed/imported/forked histories and pre-session
binding carry collection-epoch and coverage facts rather than an assumed clean
start. All pre-upgrade sessions need classification, including those with no old
taint row. Newly instrumented sessions have complete collection only after every
mandatory detector reports the new recorder/epoch; never claim exhaustive
content safety. Legacy first-taint rows cannot prove the
absence of later triggers: migrate them with incomplete coverage. A retained,
fully verifiable history may be reconstructed by an explicit tested migration;
otherwise resolving the known legacy event leaves history-unknown restrictions,
with a clear option to start a new chat. Do not fabricate missing events or
provide a disguised global clear. Changing trust rules does not fix old coverage.

Contract additions include the policy section, review/query receipts, event
schemas and history/update DTOs. Changing effective taint stickiness is a
breaking-before-1.0 behavior change requiring the maintainer ruling, `breaking`
and `contract` labels, a `CONTRACT:` commit, a minor changeset naming the break,
and a dated G6 supersession. Update provider capability wording without mutating
an existing provider conversation prefix. Existing sessions can still carry old sticky-policy
wording: do not regenerate their system prompt on upgrade. Only a necessary
once-only tail fact can communicate changed enforcement.

## Sequencing and proof

First pin the decision, ownership/auth matrix, identities and compatibility
contracts. Recording every occurrence and trustworthy coverage must land before
any feature can clear a trigger. In parallel, define the protected policy trust
model and qualify repository-scoped transport/provenance. Then integrate the
live effective state and verified source matching into every enforcing path.
Expose owner review and Settings/history controls only when their host reports
that complete enforcement is available. Occurrence-specific review can ship independently of persistent trust, and
origin trust can ship independently of repository transparency. Cross-device
recovery and legacy rollout proof qualify each advertised capability before
personal configuration is enabled. The tracker uses separate outcomes for
individual reviews, persistent settings and verified repository trust rather
than blocking the entire feature on transparent Git interception.

Each implementation task supplies its own meaningful failing-first or mutation
receipt. Integration proof uses real loopback transport and Git fixtures with
multiple owners/repositories, real browser tests at 320px/desktop in both themes,
real write-worker failure/restart injection, and both keyless provider-history
guards. No network or provider key is needed in tests.

The decisive scenario has A, then B, then C from A's same origin. Resolving A
and saving its future-origin rule leaves B and C active; a future matching D
creates no new unresolved occurrence. Resolving B still leaves C active; only
resolving C can restore normal policy with complete coverage. Repeat with
simultaneous tool and proxy events, a late write, a stale tab, origin/repository
rule revocation, a crash between file and ledger commits, legacy incomplete
history, a redirected Git request and a repository-identity spoof. Deny rules,
byte ceilings, private-access requirements, outward writes and voice authority
remain independently enforceable throughout.


## Proposed version 1 data contract

This section specifies the version 1 design. The read-only history subset is
refined by the [implemented wire contract](../integration-contract/wire.md#session-safety-history-additive-3604), including provisional identities,
cursor ordering and the actually retained record variants. The review, trust
and publication DTOs below remain **prospective**, not registered routes or
accepted policy keys. Implementations must add runtime schemas and the
authoritative HTTP/wire/package/policy contract with code. Strict objects reject unknown keys. No client fields supply principal,
brain, author, channel, authority epoch or operation provenance. Time is host
UTC epoch milliseconds; strings below are UTF-8 byte bounded, never HTML.

### Primitives and limits

These are version 1 hard ceilings, not claims about existing storage. A host
may advertise lower effective limits and must enforce them before accepting
work. Raising a ceiling requires a reviewed contract update and capacity proof;
never silently trim identities or drop security evidence to meet a limit.

| Value | Version 1 bound and semantics |
| --- | --- |
| `Id` | Host-minted opaque ASCII `[A-Za-z0-9_-]`, 1–128 bytes; never a path or user label. |
| `Revision` / sequence | Decimal string, canonical `0` or nonzero without leading zeros, at most 20 digits and at most `18446744073709551615`; compare as integers, never JSON doubles. Exhaustion fences collection before wrap. |
| Hash | Lowercase SHA-256, exactly 64 hex characters; policy absence uses `null`, not an empty hash. |
| Time | Safe integer 0–9007199254740991, milliseconds; not an identity or ordering substitute. |
| Reason / evidence summary | 512 / 2048 bytes; escaped/redacted text. No credentials, bodies, raw commands or file contents in public receipts. |
| Target / relative path / label | 2048 / 1024 / 128 bytes; reject an oversized canonical identity rather than shorten it. |
| Enum lists / coverage epochs | At most 32 detector IDs and 128 epochs per session; overflow is `coverage_capacity`, never complete collection. |
| Query / mutation body | 8192 / 65536 bytes after decoding; enforce transport limits before buffering. |
| Detail page | `limit` integer 1–100, default 50; response at most 262144 bytes including projection; stop before a row that would exceed it. |
| Incremental update | At most 100 records and 262144 bytes per frame; gap or overflow sends resync-required, never drops records while claiming continuity. |
| Per occurrence | At most 8192 bytes including identities, provenance and summary. Content bodies are not required. |
| Per session ledger | At most 100000 occurrence/decision/trust-audit records and 67108864 bytes, including compact unresolved and resolved audit rows. Reserve space for verdicts before ingestion. |
| Per brain ledger | At most 1000000 such records and 536870912 bytes; protected Markdown and existing independent stores retain their own limits. |
| Pending writes | At most 256 records / 1048576 serialized bytes per session and 4096 records / 16777216 bytes per brain; fail/restrict before accepting the next exposure. |
| Unbound collection | At most 1024 turn bindings / 8388608 bytes per brain; no time-based eviction of unresolved evidence. Stop the affected producer until binding or explicit retirement. |
| Trust rules | At most 256 total entries across both Settings lists, 1024 bytes per canonical selector and 262144 bytes for the trust section. Empty by default. |
| Request / review lifetime | Host-issued request handle valid for 900000 ms (15 minutes); at most 32 outstanding per principal, 256 per brain. Expiry invalidates an uncommitted review. |
| Idempotency receipts | Retain exact result for 86400000 ms (24 hours) after terminal commit, at most 10000 receipts / 16777216 bytes per brain. At capacity refuse new requests, never evict a live receipt. |
| Detail retention | Redacted detail may be pruned after 2592000000 ms (30 days); minimal unresolved state and verdict/trust audit survive for the session lifetime. No expiry clears a restriction. |

The event ceiling reserves one future verdict slot for every unresolved
occurrence and terminal capacity for each open exposure/request. These reserved
slots count toward both byte and row ceilings. An attempted exposure that
cannot reserve its occurrence and verdict must not deliver bytes: synchronously
latch restricted state, persist a coverage-gap fact using separately reserved
capacity, stop the producer and require recovery. Writer failure or exhaustion
of that emergency capacity stops all affected ingestion/admissions; restart
begins restricted until the host proves recovery. No admission can turn an
unrecorded input into normal state by losing an in-memory pending entry.
At capacity, reviewing already retained finalized events is still possible;
starting a new chat does not bypass brain-wide capacity.

The scope and recovery of that latch follow
[proportionate containment](../decisions/proportionate-containment.md):
"restricted" means running under the tainted policy, not refusing; a failure
before any bytes are delivered refuses only its turn; lost evidence after
delivery restricts only its chat; only an unwritable evidence store restricts
the brain, and the host clears that itself once the gap facts are durable
(maintainer ruling, 2026-11-09, #3812). Under that latch a new turn still
begins, its permanent gap committed before delivery; only a turn whose
restricted begin cannot commit is refused. Restart resolves the latch and any
pending reservations itself, so "begins restricted" never means "refuses"
([the ruling as built](../decisions/session-safety-reviews.md#a-recording-failure-restricts-what-it-puts-at-risk-3812)).

Permanent content-free retirement fences belong to the existing chat lifecycle,
not a TTL cache. Never expire or evict them to fit the limits above. Enforce
capacity before admitting new session identities if that owner cannot retain
another fence. [Deletion policy](../decisions/chat-history-deletion.md#permanent-fences-and-recovery-limits)
continues to govern which minimal identities survive. Aggregate counters and
minimal audit consume the ledger bounds even after detail pruning.

### Identities, immutable records and projection

`SessionKey = {sessionId: Id, historyOwnerId: Id, historyGeneration: Revision}`
uses the existing host catalog, resolved dialogue/native aliases and retirement
generation. A provisional first turn instead has
`{turnId: Id, bindingId: Id}` assigned before delivery; binding is an atomic,
once-only host mapping into a `SessionKey`. Retain every early signal and its
sequence. Contradictory ownership refuses binding and stays restrictive. Never
create a session from a callback, query, verdict, request retry or alias guess.

`SafetyOccurrence = {id: Id, session: SessionKey, turnId: Id,
sequence: Revision, observedAt: Time, epochId: Id, detector: DetectorId,
source: SourceKind, operationId: Id|null, signalId: Id, exposureId: Id,
summary: string, provenance: Provenance|null}` is immutable. `SourceKind` is
`web_fetch | web_search | staged_share | chat_attachment | workspace_read |
mcp_document | user_marked | fetching_command | unclassified_command |
compute_output | egress_connection | legacy_unknown`. Every signal has its
own ID; host retry deduplication uses `(epochId, operationId, signalId,
exposureId)` only when authoritative, otherwise allocates a new signal.

An append-only `ExposureTransition = {id: Id, occurrenceId: Id, sequence: Revision,
state: open|finalized|interrupted_unknown, observedAt: Time}` describes delivery,
not a changed original row. A proved bounded input may be created finalized.
Only a terminal finalized exposure with proved end-of-input accepts a verdict.
A cancellation acknowledgement alone is not that proof. Interrupted/unknown
exposure stays restrictive unless host recovery proves finalization; a human
cannot guess it complete. Later input creates a new occurrence/exposure.

`SafeDecision = {id: Id, occurrenceId: Id, session: SessionKey,
sequence: Revision, requestId: Id, principalId: Id, decidedAt: Time,
verdict: safe, channel: owner_settings|owner_history}` is host-stamped and
immutable. No delete, undo or rewrite API exists in this design. A verdict is
a human acceptance of retained context, never evidence that the content was
removed or objectively safe. Historical egress/approval/journal facts remain
at their original revisions.

`TrustAudit = {id: Id, session: SessionKey, sequence: Revision, turnId: Id,
occurrenceId: Id|null, operationId: Id|null, observedAt: Time, ruleId: Id,
capability: incoming_content|recipient_while_restricted,
trustRevision: Revision, policyHash: Hash, epochId: Id,
provenance: Provenance}` records a verified rule match without creating an
unresolved trigger for that matched signal. Other signals still create their
own occurrences. Publication audit is operation-scoped in `ReviewReceipt`,
not forced into a fabricated session/turn.

`SafetyProjection = {session: SessionKey, evidenceRevision: Revision,
trustRevision: Revision, policyHash: Hash|null, authorityEpoch: Revision,
unresolvedCount: integer, earliestUnresolvedId: Id|null,
coverage: Coverage, pendingCount: integer,
restriction: normal|restricted,
reasons: (unresolved|coverage_unknown|recording_pending|recording_failed|capacity)[]}`.
Counts are 0–100000 and 0–256 respectively; `reasons` is unique, at most five.
The aggregate is authoritative independently of the requested detail page.
Every admission-relevant append/binding/coverage/latch change advances evidence
revision; publication advances trust revision even if the projection was normal.
Normal requires complete coverage, zero unresolved and pending records, no
failure/capacity latch, and a usable last-valid enforcing policy. A pending
verdict does not decrement the aggregate. Concurrent append-versus-resolve is
serialized by the write worker and never loses the new trigger.

### Detector contract and coverage

`Coverage = {detectorVersion: 1, state: complete|incomplete|unknown,
epochs: CoverageEpoch[], exclusions: DetectorExclusion[]}`. Each epoch is
`{id: Id, backendId: Id, startSequence: Revision, endSequence: Revision|null,
mandatory: DetectorId[], acknowledged: DetectorId[],
status: complete|incomplete|unknown, reason: string|null}`. Acknowledgement means
this recorder version is connected **before** delivery, not merely that a
backend emitted an activity event. Capability/version mismatch, missing hooks,
restart loss and recording failures create explicit gaps. No epoch cap permits
squashing unknown history into a complete epoch.

Mandatory detector IDs for version 1 are:

| Detector ID | Required signal granularity |
| --- | --- |
| `tool_web_input` | Each admitted web fetch/search exposure and each verified redirect hop; opaque search output has unknown provenance. |
| `tool_file_input` | Each input path read/quoted by the supported file, edit, notebook, glob, grep and brain document tools: staged share, attachment, workspace and explicit user mark independently. |
| `tool_search_output` | Each distinct returned normalized path and applicable source/mark signal, independently of input classification. |
| `external_mcp_input` | Each external MCP result exposure; built-in brain readers still use file/attachment detectors. |
| `attachment_input` / `compute_input` | Each host attachment read / external collect result segment. |
| `unproxied_shell_input` | Each fetching or unclassified shell invocation on an unproxied turn; parser ambiguity is restrictive. |
| `proxy_input` | Each admitted non-provider tunnel/HTTP exposure, including later connections while already restricted. No inferred tool or repository linkage. |
| `explicit_untrusted_input` | Independently report a matching user file mark, even if another area/source also applies. Trust cannot suppress this signal. |

The detector manifest must enumerate exact installed tool names and input keys
currently represented by the ingestion classifier, plus versioned additions.
The recorder must evaluate all applicable input **and** output detectors; early
return or `input ?? output` cannot establish complete coverage. For a multi-file
search record each known path's applicable signals; an unenumerable/truncated
result also gets a separate unknown-provenance exposure, not a guessed clean
remainder. Output can finalize only when all its input delivery ends. Redirect
hops have separate provenance and matching; an initial trusted URL never covers
a later untrusted hop. Group only using proved host operation IDs.

Known exclusions, represented by the fixed enum (at most four entries), are
`proxied_shell_local_read`, `opaque_tunnel_inner_protocol`,
`uninstrumented_backend_input`, `missing_historical_signals`. The first remains
disclosed even with otherwise complete version 1 collection: the proxy detects
connections, not local shell reads. Opaque traffic can have complete connection
collection but unknown source identity. The latter two exclusions make the
relevant epochs incomplete/unknown. Complete means completeness under this
manifest and its disclosed exclusions, never all actual untrusted content.
Validated provider-relay/inference traffic retains the existing G6 exclusion;
a worker's arbitrary HTTP request cannot assert itself a provider operation.

Every pre-upgrade catalog/native/imported/resumed history is classified,
including histories without a first-taint row. A legacy row becomes one known
occurrence plus incomplete coverage, not a reconstruction of missing later
ones. No row means unknown, not clean. Forks inherit the retained context's
coverage/restrictions under a new identity; switching backend opens a new epoch
and does not reset old gaps. Only an explicit tested reconstruction from fully
verifiable retained history can establish completeness. Otherwise resolving all
known events leaves history-unknown restrictions and offers a new chat, not a
global clear. Changing trust rules never fixes a coverage gap.

### Bounded query and revisioned delivery

The proposed operations are named DTOs, **not mounted endpoints**:

| DTO | Required fields and result |
| --- | --- |
| `SafetyCapabilities` | `version: 1`, `read`, `review`, `originRules`, `repositoryRules`, `recipientRules` booleans, `readOnlyReason: string|null`, `detectorVersion: 1`, effective limits above. Default all mutation flags false when absent/unsupported. |
| `SafetyQuery` | `version: 1`, `session: SessionKey`, `cursor: string|null`, `limit?: integer`; no query can change state. |
| `SafetyPage` | `version: 1`, `session`, `snapshotId: Id`, `highWater: Revision`, `projection: SafetyProjection`, `records: SafetyRecord[]`, `nextCursor: string|null`, `snapshotComplete: boolean`, `detailPruned: boolean`. `SafetyRecord` is the tagged union of occurrence, exposure transition, safe decision and trust audit. |
| `SafetySubscribe` | `version: 1`, `session`, `afterRevision: Revision`; subscription inherits current connection authorization, never body identity. |
| `SafetyUpdate` | `version: 1`, `session`, `fromRevision`, `toRevision`, `projection`, `records`; contiguous revisions or `SafetyResyncRequired = {version: 1, session, reason: gap|expired|capacity|generation_changed}`. |

A host-issued authenticated opaque cursor is at most 512 bytes, bound to
principal, brain, exact session generation, snapshot, high-water and last
sequence; it expires after 300000 ms (five minutes). Cursor pages are a stable
view at that high-water, not a mixture of current pages. `snapshotComplete`
means the last page of this snapshot, not complete detector coverage. Detail
pruning produces explicit bounded stubs and `detailPruned`; it never removes
unresolved IDs or turns an absent page into zero. Aggregate changes after the
snapshot arrive through contiguous updates or require a new snapshot. Keep at
most 1024 deltas / 4194304 bytes per session for replay; gaps force resync from
the durable ledger. Client deduplication uses record IDs and revisions. Until a
complete snapshot plus contiguous updates is assembled, do not display normal
from partial pages. Unsubscribe and clear pending controls/cache on auth loss;
a retired generation invalidates pages, cursors and subscriptions immediately.

### Review, policy and partial receipts

`ReviewRequest = {version: 1, session: SessionKey, requestId: Id,
occurrenceId: Id, expectedEvidenceRevision: Revision,
expectedTrustRevision: Revision, expectedPolicyHash: Hash|null,
verdict: safe, rule?: ReviewedRuleChange}`. The default omits `rule` (**Only
this trigger**); there is no array, origin-wide verdict or through-sequence
field. A Settings-only `TrustChangeRequest` uses the same expected trust
revision/base hash and request handle without a verdict/occurrence. Its
`ReviewedRuleChange = {action: create|edit|remove, ruleId: Id,
reviewId: Id, reviewedBytesHash: Hash}` references an exact host-prepared preview;
it is not arbitrary policy text from the browser. Preparation binds the actual
canonical selector, label and capability booleans. Target changes are remove/add
with distinct audit identities. A single prepared request changes one rule.

Request IDs are issued in a host prepare operation bound to principal, brain,
kind, session generation (if any), occurrence and exact payload digest, with
issued/expiry times and host authentication. Reuse with a different body is
`request_conflict`; same-body retries return the original operation receipt
without a second write. After expiry, only readback within the receipt retention
window is allowed; a new mutation needs a fresh review. Even after receipt
pruning the expired authenticated handle cannot become a new request. Never
accept a caller-generated arbitrary ID as a fresh request. Revocation or
retirement always takes precedence over replay/readback.

`ReviewReceipt = {version: 1, requestId: Id, operationId: Id,
session: SessionKey|null, occurrenceId: Id|null,
stage: prepared|file_published|verdict_committed|partial|unknown|refused,
publication: not_requested|not_published|proved|unknown,
verdict: not_requested|unresolved|committed,
ruleId: Id|null, publishedTrustRevision: Revision|null,
currentRule: present|removed|changed|unknown|not_requested,
projection: SafetyProjection|null, reason: string|null}`.
All `SafetyRecord` variants carry unique host IDs and a session-local sequence;
a sequence is never reused. Pruned detail returns the same tagged identity,
sequence and minimal security fields with a `detailPruned: true` marker rather
than inventing an occurrence or erasing its verdict. Provenance is display
text/data, never a grant from the client. Capabilities include only the limits
relevant to exposed operations; refusal does not leak another principal's data.
Settings removal may use `file_published` as its terminal stage only after live
fencing is confirmed. `verdict_committed` is terminal success for a review.
Transport status errors use bounded `{code, reason, retryable}` with codes
`unauthorized | unavailable | stale_revision | stale_base | not_finalized |
request_conflict | request_expired | retired | capacity | publication_failed |
recording_failed | resync_required`. Unknown/foreign sessions share the existing
non-disclosing unavailable response. No failure receipt claims normal state.

After approval, reuse/extract the descriptor-bound writer core: canonical root,
protected target, regular-file/link/topology checks, exact base and reviewed
bytes, staging inode ownership, sync/atomic publication, journal observation,
brain lock and current authority. It currently accepts a `PolicyProposalTurn`;
the new path must supply a genuine host Settings operation identity, with audit
attribution, never a synthetic turn or an alternate filesystem writer. Prepared
state is durable before publication. Recovery needs an operation-bound durable
publication proof and ordered verdict commit; equal current bytes alone do not
prove this operation wrote them. Unknown remains unknown pending fresh review.

For combined review: revalidate before publication, publish and durably prove
the exact rule, then transactionally commit only the selected finalized verdict
under current authority/session/evidence checks. A later occurrence makes the
old expected revision stale. If it arrived after publication, report partial
and leave the verdict unresolved; fresh review may use the already proved rule
without republishing. Failed publication leaves the verdict unresolved. If a
second device removed/edited the rule, report that current fact even if its
historical publication was proved. No all-or-nothing guarantee spans protected
Markdown and host evidence storage.

### Canonical rules and verified provenance

Proposed policy entries are strict tagged objects with common fields
`{id: Id, label: string, incomingContent: boolean, recipientWhileRestricted:
boolean}`. A create defaults `incomingContent` to true and
`recipientWhileRestricted` to false; the preview always displays both effects.
Repository/owner entries require `incomingContent: true` and
`recipientWhileRestricted: false`. An origin/tunnel with both false has no
effect and is rejected. The section remains protected Markdown; host evidence
records publication/verdict facts, not an alternative policy authority.

| Selector tag | Canonical fields and matching |
| --- | --- |
| `web_origin` | `{scheme: http|https, host: string, port: integer}`; port 1–65535, explicit effective default 80/443. Parse only a bare origin, optional root slash; refuse user info, path, percent escapes, query, fragment, wildcard and opaque URL. IDNA via the installed URL parser to lowercase ASCII DNS, remove one terminal DNS dot, reject empty/interior-empty labels; DNS label at most 63 and full hostname at most 253 bytes. Only canonical dotted-decimal IPv4 and bracketed compressed IPv6; reject shorthand/octal/hex IPv4, IPv6 zone IDs and unsupported proxy forms. Implementing parser fixtures pin Unicode/IDNA and IP normalization. Exact tuple match only. |
| `tunnel_authority` | `{host: string, port: integer}` with the same hostname/IP/port rules and an explicit port. Display `host:port · tunnel`; incoming trust applies to the whole opaque connection, a broader human choice than HTTPS origin trust. Never converts to a web-origin rule. |
| `github_repository` | `{host: github.com, owner: string, repository: string, repositoryId: string}`; lowercase normalized names and verified stable provider identity. Require both stable repo ID and the approved current owner boundary. A same-owner rename matches only after authoritative identity revalidation; transfer or name reuse cannot inherit the rule. |
| `github_owner` | `{host: github.com, owner: string, ownerId: string}`; verified stable owner ID plus current canonical namespace. Covers present and future repositories currently owned there, not transfers out or a reused namespace with a different owner ID. Preview must state future-repository inclusion. |

GitHub names are ASCII segment tokens: owner 1–39 bytes, alphanumeric/hyphen
with no leading/trailing/repeated hyphen; repository 1–100 bytes,
`[A-Za-z0-9_.-]`, excluding `.` and `..`. Stable provider IDs are nonzero decimal
strings of at most 20 digits. Accept bare `owner/repo` or exact
`https://github.com/owner/repo`, and owner counterparts; remove a single final
`.git` for repository input. Refuse credentials, alternate hosts/ports, encoded
separators, traversal, extra components, SSH/SCP and remote-helper forms.
Namespace metadata unavailable/stale means no rule match, not cached permanent
permission. Equivalence ignores display label and compares canonical selectors;
reject duplicate creates and overlapping duplicate capability entries. At most
one entry per canonical selector; union explicit capabilities only after review.

`Provenance` is a strict tagged union: `{kind: web_origin, origin: selector,
verifiedBy: host_transport}`, `{kind: tunnel_authority, authority: selector,
verifiedBy: host_proxy}`, or `{kind: github_read, repository: repositorySelector,
ownerId: string, ref: string, commit: string, acquisitionId: Id,
contentHash: Hash, immutable: true, verifiedBy: managed_acquisition}`.
Git refs are at most 1024 bytes, validated by the installed Git's ref rules;
only qualified ordinary branch/tag refs match initially. Commit IDs are lowercase
40 or 64 hex as the repository format requires. The transport binds principal,
brain, repo/ref/read scope, bytes, cancellation and current private grant to the
actual read. Worker argv/remotes, DNS, a directory name or time overlap cannot
populate this proof. Unknown provenance is `null`, never a fabricated selector.

Repository trust must remain unavailable until real Git qualification proves
name/ID/rename/transfer behavior, transport isolation and immutable bytes. PR/fork
refs, submodules, LFS, SSH, helpers, redirects, configured pull and mutable
worktrees remain unsupported unless separately qualified. A fixed managed read
is an acceptable fallback for transparent rewriting. Raw Git still runs under
ordinary restrictions; no trusted-host exemption, credential probe, unrestricted
object endpoint or authenticated generic HTTP follows. Private acquisition
continues to require the requesting live principal's repository credential
grant, even with a trust rule. Auth/grant revocation cancels new private work.
Trust never grants Git write/force-push, file write, outward action or voice
approval. Explicit user-untrusted marks always produce their independent signal.

### Authorization and admission matrix

Read visibility follows the current authenticated session/history ownership
filter; no new cross-principal read grant is introduced. Policy reads expose
only the served brain's sanitized policy facts. `read` below means only those
facts and session evidence already visible to that caller, never all histories.

| Caller / mode | Read | Verdict or Settings mutation | Private acquisition |
| --- | --- | --- | --- |
| Password-mode live human owner (password or passkey login) | Existing visibility | Yes, with fresh review and live owner checks | Only with existing live principal/repository credential grant |
| Password-mode live agent principal | Existing visibility | No, including agent credentials over browser routes | Existing live agent grant only; never owner trust management |
| Proxy or tailscale ambient identity | Existing visibility | Read-only until separately qualified human-owner authority | No new authority; existing ambient grant refusal remains |
| Local/no-auth ambient identity | Existing visibility on permitted local host | Read-only until separately qualified human-owner authority | No new authority; host credential is insufficient |
| Voice, model/tool, cron/system, forged `channel: card` or body principal | No added visibility | No; a transcript/button label supplies no authority | No added authority; existing restrictions apply |
| Expired/revoked principal, unauthenticated/foreign caller | No protected evidence | No; also revoke pending UI/subscriptions | No; stop in-flight private acquisition under its grant contract |

Browser mutation requires authenticated same-origin JSON and the existing
Origin/CSRF checks; reject absent/foreign Origin on these new browser mutation
operations and reject unexpected fields. WebSocket origin/auth is checked at
upgrade and live authority again per request. This is a stricter new surface,
not a change to unrelated routes. Body/session/cursor fields cannot override
server identity. A host-owned request binds the current principal and auth
epoch during preparation; password mode alone without a live owner is
insufficient. Capability flags include a read-only reason, and UI controls are
hidden/disabled when mutation is unavailable. Enforcement is on the host even
for a forged client. Never advertise review until all mandatory collectors,
durable projection and every applicable admission path support it.

An admission snapshot is exactly `(evidenceRevision, trustRevision,
authorityEpoch)` bound to brain/session generation and the admitted turn's
ordinary governance policy hash. After every asynchronous approval, write,
lookup, lock or transport wait, re-read that tuple and current identity at the
last host-controlled point before irreversible dispatch. Recompute on change;
a saved boolean cannot authorize. Only effective taint and the trust slice are
live; ordinary budgets, command/profile and egress configuration keep their
existing turn-bound meanings. Last-valid trust remains enforced on invalid
publication, with an error and no claim that rejected bytes became active.

A Remove receipt reports enforcement only once all affected new admissions are
fenced at its new trust revision, including active turns. Open incoming streams
must split/finalize at the boundary or stop before delivering later bytes under
the removed grant. Already dispatched work cannot be recalled. A human verdict
changes only later admissions, never automatically retries a denied/approved
operation. Expire/withdraw stale pending cards through the coordinator with a
terminal receipt before a fresh attempt. Explicit one-time approvals remain
distinct from standing recipient rules and #3595's chat-session grants.

### Compatibility and proof obligations

Version 1 of `SafetyCapabilities` is a proposed optional negotiated capability,
not a wire revision bump or a relaxation of existing hello rules. Unknown or
absent capability means no mutation controls and conservative existing policy.
Advertise origin, recipient and repository capabilities independently only
after their full host enforcement is qualified. Older clients may continue
chatting under host restrictions; they cannot clear unseen triggers. Retained
sessions preserve their provider prefix and may receive only a necessary
once-only new tail fact about changed enforcement.

The occurrence, coverage, query/update, review and policy implementations must
update their authoritative integration-contract components with the code, use
`CONTRACT:` commits/PR titles and the `contract` label. The change from G6
stickiness additionally needs `breaking`, the dated maintainer ruling linked
from its implementing issue, and a minor changeset explicitly naming the
pre-1.0 semantic break. This documentation prerequisite changes no supported
machine surface or shipped package and needs no behavior changeset.

Proof for each implementation includes its own meaningful failing-first or
mutation receipt. Keyless loopback integration must cover A/B/C/same-source D,
all detector combinations and exclusions, open/late/redirected input, legacy
with and without rows, provisional binding, backend changes, forks, finite
capacity, write failure/restart, stale pages/duplicate deltas, request expiry
and conflicting replay, deletion late callbacks, exact-base policy races,
publication proof loss and rule removal before verdict. Both provider-history
guards must pass. Real browser proof at 320px/desktop in both themes covers
keyboard/focus/touch details, multiple indicators, unknown/partial/read-only
states and two devices. Real Git fixtures prove multiple owners/repos,
identity spoofing, transfer/rename, private grant revocation and unsupported
paths before any repository exemption. A model/source review of this design
is not any of those execution receipts.
