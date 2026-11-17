# Explicit local chat-history deletion

**Decided by the maintainer on 2026-11-01**, before runtime implementation:
[#3180 ruling](https://github.com/schlessera/brain-kit/issues/3180#issuecomment-6558351378).
This records approved policy. No deletion endpoint, backend removal or UI is
implemented by this decision. The [source-backed design](../plans/chat-history-deletion.md)
contains the owner inventory, lifecycle proposal and future proof obligations;
open implementation scope lives in the tracker.

## Authority and extent

Only an authenticated owner may delete its own chat. Preserve exact principal
ownership and recheck current authorization, including revocation, at admission
and across asynchronous boundaries. No cross-principal power, reassignment,
agent authority or arbitrary filesystem authority follows. The
[same-account amendment](#same-account-deletion--2026-11-17-4138) narrows the
exact-principal rule for one case: another current login of the same owner
account may delete a chat whose every ownership record proves that account.
Ambient authentication requires an explicit owner mapping; otherwise deletion
is unavailable. Read access, labels, voice recognition and conversation content
are not authorization. Existing [principal boundaries](session-principals.md)
continue to bind.

The operation removes local native history, canonical dialogue and directly
bound copies: display/provenance, retained request/result text, local exchanges
and positively bound drafts/attachments. Resolve provisional owners, aliases
and native bindings through their actual owners; never infer ownership from
matching text. Unrelated/unbound drafts and other chats remain intact.

Independent saved content, effects, Inbox/Activity/audit/journal records,
handoff destinations, provider copies, exports, recordings and backups remain.
These independent owners may contain copied text; disclose their retention.
Any direct embedded chat copy must be disclosed as retained or removed by its
actual owner under the approved policy.
Local chat-history deletion is not recursive erasure of every derivative.
Offline devices may retain cached text until they reconnect and validate the
retired identity. No physical secure-erasure or provider-forgetting claim is allowed.

## Native-preservation amendment

This explicitly amends [#3177's retained-discussion ruling](live-conversation.md#retained-discussion--2026-10-30-3177):
“Native provider transcripts stay intact” continues to govern ordinary live
operation, but an authenticated owner's explicit deletion of its own chat
removes its locally owned native history as part of the unified lifecycle.
No rolling eviction, automatic expiry or routine live cutoff follows.

The [append-only provider-history rule](provider-history.md) remains binding.
Retire and drain the old epoch; never rewrite previously sent provider bytes
or resume a deleted identity. A future conversation needs a new identity and
fresh explicit Start/disclosure. Provider-held copies are outside local deletion.

## Permanent fences and recovery limits

Keep minimized non-content identity/replay fences permanently within the
installation: chat/native/alias and principal bindings, terminal generation,
operation identity/per-store outcome, consumed task/request handles and required
revision/accounting/effect refusal facts. Do not retain prompts, results,
recognition, titles, attachments, free-form errors or unnecessary content hashes
in deletion receipts. Removing text must not permit execution or effect replay.

An old backup can restore text and older fence state. The maintainer accepts
this recovery-point limitation; disclose it. A post-deletion backup must preserve
the minimized fences and scrubbed owned stores. Restoring old native files must
not bypass a surviving fence. No outside-image deletion ledger, automatic fence
expiry or namespace-reset policy is approved. Existing recovery reconciliation
and paused execution remain conservative boundaries.

## Busy work and honest completion

Refuse deletion while effect-owning work is busy; use existing stop/reconcile
paths separately. Never silently cancel an effect, reset a replay guard or
convert unknown settlement into completion. Retire read-only/provider holders
through the lifecycle fence and wait for genuine drain before content completion.
A rejected shutdown deadline does not prove cleanup or permit replacement writers.

Unsupported backend or unknown ownership refuses before retirement. After
retirement, failed/unconfirmed cleanup stays partial or unknown under the same
intent; completion requires confirmation from every selected store. Report safe
store categories and recovery actions, without text, raw paths or an existence
leak to unauthorized callers. Catalog hiding alone cannot establish deletion.

## Typed-chat creation owner — 2026-11-02 (#3337)

**Decided by the maintainer on 2026-11-02 and confirmed on 2026-11-03**:
[#3337 ruling](https://github.com/schlessera/brain-kit/issues/3337#issuecomment-6586465475),
option 1. Recorded ownership alone left a typed-only chat with no owner, so
deletion refused most typed chats as `unavailable`.

**The record.** When an authenticated typed request creates a backend session,
the host records which principal created it: a content-free
`(session, principal)` row in `chat_session_owners` (migration
`packages/ui-server/migrations/076_chat_session_owners.sql`). It holds no
prompt, title, label or transcript text. The bridge offers the creator only on
a new turn that is not host work and whose authorization is current
(`const creator`, `packages/ui-server/src/ws/bridge-capabilities/emission.ts:143`). The write worker
binds it only in the transaction that first creates the session's row
(`upsertSession(row: SessionRow)`, `packages/ui-server/src/ws/session-catalog-writes.ts:170-182`).
`resolveChat` counts the row as one more ownership record beside dialogue
owners and voice epochs, so records of different accounts still refuse as
ambiguous (`const creator`, `packages/ui-server/src/ws/chat-lifecycle.ts:102-103`). Like the
permanent fences, the row is identity data and stays after a deletion cleans
the chat's stores.

**How it differs from the dialogue owner.** A dialogue owner begins with a live
conversation or the adoption of a host-only history. It carries a generation,
aliases, conversations and records, and it drives dialogue paging. The
creation owner has none of these:

- It never opens or pages dialogue, and no catalog read, list or retention pass
  joins it. Writing it mints no dialogue owner, so a typed chat is still
  reviewed at generation 1, and undeleted chats page and age exactly as before.
- It is written once, by session creation, and never by a resume, an adoption,
  a later turn or host work. It is never reassigned.
- It names the creating principal; it grants no authority. Deletion still
  re-reads that principal at admission and commit, so an agent, an ambient
  caller with no owner mapping or a revoked principal is refused even if it
  created the session.

**Why legacy chats are not backfilled.** A chat whose session existed before
the record, or a native-only session the host first sees on a resume, has no
evidence of which principal created it. Under [Authority and extent](#authority-and-extent),
ownership is resolved only through actual owners and never inferred from
matching text, read access or labels. A backfill would have to guess, and a
wrong guess hands one principal another's deletion. Such chats keep refusing as
`unavailable`, and a foreign principal receives the same refusal as for a chat
that does not exist. The [design](../plans/chat-history-deletion.md) records
the endpoint and store cleanup this record feeds.

This adds no wire shape: the `POST /api/chat-deletions` request, receipt and
refusal shapes are unchanged, and the row is internal storage.

## Same-account deletion — 2026-11-17 (#4138)

**Decided by the maintainer on 2026-11-17**:
[#4138 ruling](https://github.com/schlessera/brain-kit/issues/4138#issuecomment-6943093310),
option B. Every owner sign-in mints its own principal
([session principals](session-principals.md)), and a chat's retained history
belongs to the account, so a second login of the same owner continues it by
voice ([#3963](https://github.com/schlessera/brain-kit/issues/3963)). Deletion
still compared exact principal IDs across the chat's ownership records, so a
chat two logins had used was refused to both of them as ambiguous ownership.

**The amendment.** Any currently authorized owner login may explicitly delete a
chat when every deletion-relevant ownership record is verified as belonging to
that same owner account. This narrowly amends the exact-principal deletion
rule under [Authority and extent](#authority-and-extent). Shared read access
alone never grants deletion authority.

- **Which records.** Every record `resolveChat` consults: the canonical
  dialogue owner, each recorded voice conversation epoch, the typed-creation
  binding and every safety collection a typed turn left under any of the
  chat's history owners before a session bound it, for a provisional chat and
  a backend session's chat alike (`resolveChat`, `packages/ui-server/src/ws/chat-lifecycle.ts:87-146`).
  Each must prove the caller's account; one that does not refuses the whole chat
  (`chatOwnedBy`, `packages/ui-server/src/ws/chat-lifecycle.ts:158-160`).
- **What proves an account.** The record principal's current row, or the
  durable account the server stored beside the record when it wrote it
  (`principal_account`, migrations 089 and 091). Migration 091 adds that
  column to `conversation_epochs` and `chat_session_owners`, and the writers
  fill it from the principal's own row. A pruned historical login is
  recognized only through that stored evidence. Missing, corrupt or
  contradictory evidence, a stored account that a live row disagrees with, or
  records of mixed accounts refuse as `unavailable`, within that chat only.
  Legacy rows are backfilled only where a principal row still proved the
  account at upgrade; the others stay unknown and keep refusing.
- **What authorizes the caller.** Only its own current principal row, re-read
  at admission and again in the commit transaction, each time against the
  current clock rather than the time the request was stamped, so a login that
  expires while the request waits on the catalog or the writer is refused. A revoked, expired or
  pruned caller gains nothing from any record's stored account. Agent,
  ambient and system principals have no account that holds across auth modes,
  so their records match only themselves and they never gain an account-wide
  exception.
- **What stays exact.** The operation, its receipt and its retry key belong to
  the login that started it: another login of the account reads
  `not_admitted` and cannot retry it. The lifecycle records that initiating
  login; no record's original principal is rewritten or reassigned. Live
  conversation and epoch controls stay with the exact login that opened them.
  Busy refusal, stale generation and backend review, the permanent fences and
  per-store outcomes are unchanged. The `chat_retired` frame still goes to the
  initiating login's capable connections; every other reader, another login's
  devices included, already refuses the retired chat.

Exact-principal-only deletion was rejected because it strands shared chats.
Creator-only deletion was rejected because a missing first login still strands
them and it needs another durable creator model. No request, receipt or
refusal shape changes; the admission semantics in
[the HTTP reference](../http-api.md#explicit-chat-deletion-additive-3230) do.

## Compatibility and rejected alternatives

This decision approves the explicit retention exception, not a shipped machine
surface. No package version, changeset or release commitment follows from the
spike. Runtime work must assess actual HTTP/wire/backend/schema changes, update
the integration contract with a `CONTRACT:` commit, and add the appropriate
changeset. Additive surfaces ship in a minor; a shipped retention/compatibility
break also needs the `breaking` label and a changeset naming that break under
[contract versioning](contract-versioning.md). This ruling covers only the
specified explicit deletion exception; broader changes need a separate ruling.

Rejected: catalog-only hiding as deletion, cross-principal owner power, recursive
erasure of independent effects/content, outside-image ledgers, secure-erasure
claims, automatic expiry and live-prefix rewriting. Each would either promise
more than local owners can establish or expand authority beyond the ruling.
