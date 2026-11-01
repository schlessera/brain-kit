# Explicit local chat-history deletion

**Decided by the maintainer on 2026-11-01**, before runtime implementation:
[#3180 ruling](https://github.com/schlessera/brain-kit/issues/3180#issuecomment-6558351378).
This records approved policy. No deletion endpoint, backend removal or UI is
implemented by this decision. The [source-backed design](../plans/chat-history-deletion.md)
contains the owner inventory, lifecycle proposal and future proof obligations;
open implementation scope lives in the tracker.

## Authority and extent

Only an authenticated owner may delete its own chat. Preserve exact principal
ownership at admission and across asynchronous boundaries. No cross-principal
power, reassignment, agent authority or arbitrary filesystem authority follows.
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
