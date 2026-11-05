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
agent authority or arbitrary filesystem authority follows.
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
(`upsertSession(row: SessionRow)`, `packages/ui-server/src/ws/session-catalog-writes.ts:169-178`).
`resolveChat` counts the row as one more ownership record beside dialogue
owners and voice epochs, so records that disagree still refuse as ambiguous
(`const creator`, `packages/ui-server/src/ws/chat-lifecycle.ts:91-92`). Like the
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
