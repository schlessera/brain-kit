# Explicit chat-history deletion ownership

This is the implementation design for [#3180](https://github.com/schlessera/brain-kit/issues/3180),
source-audited against main `6fa3ec1305e8b52991252d6a28959a68c56be1c1` on
2026-11-01. The [binding decision](../decisions/chat-history-deletion.md)
records the approved authority, extent and permanent-fence/backup policy.
Approval supplies no automatic expiry, routine live cutoff or implementation
release commitment.

**Built (#3228):** the internal, content-free retirement ledger and gate
(`retireChat`, `packages/ui-server/src/ws/chat-lifecycle.ts:169-202`;
migration `073_chat_lifecycle.sql`). It re-reads owner authority in the
serialized writer, resolves the exact identity set from recorded dialogue
owners, aliases and voice epochs, refuses unknown/foreign/stale/unsupported/busy
targets before retiring, and makes later dialogue/task writers and readers
refuse the retired identities. It removes no content and reports every store
pending until that store's owner confirms removal. A typed native-only chat
with no recorded owner refuses as unknown ownership; no ownership is backfilled.
Host-copy cleanup, the endpoint and UI are not built. (#3337, below, records an
owner for typed chats created after it.)

**Built (#3229):** first-party native removal behind the optional
`historyRemoval` backend capability
([package contract](../integration-contract/package-api.md#native-history-removal-additive-3229)).
Claude (`removeClaudeSession`, `packages/ui-backend-claude/src/transcript-archive.ts:331-357`)
and Pi (`removePiSession`, `packages/ui-backend-pi/src/session-storage.ts:101-117`)
name their owned artifacts; the shared fence
(`createSessionRetirement`, `packages/ui-sdk/src/server/native-history-removal.ts:117-224`)
writes a content-free tombstone before anything is removed, drains turns and
readers, and reports `partial` for links, hard links, redirected roots and
replaced files instead of touching them. The host records the native store
under the retirement (`removeRetiredNativeHistory`, `packages/ui-server/src/ws/native-history-removal.ts:29-48`); coordinating it with the other stores and
restart reconciliation remains with the endpoint work.

**Built (#3230):** the coordinated deletion and its endpoint
([HTTP](../http-api.md#explicit-chat-deletion-additive-3230),
[wire](../integration-contract/wire.md#explicit-chat-deletion-additive-3230)).
One operation (`createChatDeletion`, `packages/ui-server/src/ws/chat-deletion.ts:46-114`)
refuses busy work, retires the chat, ends its live epochs, notifies the owner's
capable clients, then asks the native store and each host store to remove their
copies; restart reconciliation resumes any unconfirmed store under the original
operation. `GET /api/chat-deletions/:operationId` (#3455) reads that operation's
current receipt for its owner and admits, retries and cleans nothing; every miss
is one content-free `not_admitted`. Host stores (`cleanChatStore`, `packages/ui-server/src/ws/chat-store-cleanup.ts:96-104`)
confirm removal only by reading back that nothing selected remains: dialogue
records, task receipt text and result facts, session title/label and the text,
digest and classification projections, and positively bound drafts with their
images and receipt fingerprints. Consumed task, request, retry and draft-send
identities stay as replay fences. Policy proposals, turn scope, provider-exposure
and masking lineage, Activity, Inbox, governance, journals and usage accounting are
retained as independent records and disclosed. HTTP and WebSocket list, read,
resume, recovery and live-startup paths refuse a retired chat after every await,
and draft routes refuse drafts bound to it. Browser invalidation (#3231) is not built.

**Built (#3337):** typed chats created from now on name their owner. Under the
[2026-11-02 ruling](https://github.com/schlessera/brain-kit/issues/3337#issuecomment-6586465475),
when an authenticated typed request creates a backend session, the host records a
content-free `(session, principal)` binding (migration `076_chat_session_owners.sql`).
The bridge offers the creator only on a new, non-host-work turn whose
authorization is current
(`const creator`, `packages/ui-server/src/ws/bridge-capabilities/emission.ts:143`). The write worker
binds the creator only in the transaction that creates the session's row
(`upsertSession(row: SessionRow)`, `packages/ui-server/src/ws/session-catalog-writes.ts:169-178`).
`resolveChat` counts the binding as one more ownership record beside dialogue
owners and voice epochs, so a disagreement among them still refuses as ambiguous
(`const creator`, `packages/ui-server/src/ws/chat-lifecycle.ts:91-92`). A typed
chat's owner can now delete it through `POST /api/chat-deletions`. A chat whose
session existed before the binding still refuses as `unavailable`, and so does a
native-only session the host first sees on a resume. A foreign principal gets
the same refusal as for a chat that does not exist.

The binding is deliberately not a dialogue owner:

- It has no generation, alias, conversation or record. It never opens or pages
  dialogue, and no catalog read, list or retention pass joins it. A typed chat
  is therefore reviewed at generation 1, as before, and undeleted chats page and
  age exactly as they did.
- It is written once, by session creation, and never by a resume, an adoption, a
  later turn or host work. It is never reassigned or backfilled. A dialogue owner
  instead begins with a live conversation or the adoption of a host-only history,
  and it binds or merges into a session later.
- It names the creating principal, not authority. Deletion still re-reads that
  principal at commit: an agent, an ambient caller with no owner mapping, or a
  revoked principal is refused as before, even if it created the session.
- Like the retirement fences, it is content-free identity data and stays after the
  chat's stores are cleaned.

## Selected local lifecycle

Use a concrete ui-server lifecycle owner in the existing operational
catalog/write worker. One explicit operation retires a chat identity before
coordinating its owned stores. Backend implementations retain responsibility
for native layout and removal; browser clients invalidate their projections.
There is no generic storage plugin, second dialogue store or replacement timeline.

Only an authenticated owner may delete its own chat, with exact principal
ownership and current authorization at admission and asynchronous boundaries.
Agent principals cannot delete history. Ambient authentication requires an
explicit owner mapping; without one deletion is unavailable. Neither labels,
history-read access nor speech grants authority. No cross-principal deletion
or owner reassignment is authorized.

The selected extent removes local native history, canonical dialogue and directly
bound copies, including display/provenance, request/result content and bound
drafts. Independent saved content, effects, provider copies and backups remain
and must be disclosed. The decision explicitly amends #3177's native-preservation
rule only for authorized explicit deletion. It never permits rewriting a live
provider prefix. Minimized non-content identity/replay fences survive permanently
within the installation. Old backups may restore text; that limitation is accepted
and disclosed. No outside-image ledger or secure-erasure guarantee is approved.

As a conservative engineering default, refuse deletion admission while a host
task, queued follow-up, handoff preparation, share application or native
archive/restore operation still owns the chat. Offer existing stop/reconcile
paths separately; deletion never silently cancels an effect or changes unknown
into completed. Voice/provider opening and history-only readers can be retired
by the lifecycle fence, but all holders must be drained before content removal
is complete.

Alternative A, catalog-only hiding, is cheap and useful as an explicitly named
archive/hide operation, but is rejected for deletion: native list/read/resume,
archival restore and retained facts can recreate visible text. Alternative B,
the selected local lifecycle, requires first-party backend removal support
and honest retained-record exclusions. Alternative C, recursive erasure of all
content/effect/audit/Inbox/handoff derivatives, changes independent owners and
recovery guarantees; present provenance does not establish a complete reversible
association. It is a separately scoped policy/design project, not a cascade on
`session_id`. The maintainer selected B; neither the hide-only nor recursive-erasure
alternative is authorized as the deletion promise.

## Bindings and current source

[Retained discussion](../decisions/live-conversation.md#retained-discussion--2026-10-30-3177)
keeps dialogue with its chat; pages, provider input and pending memory are bounded
separately. Its “Native provider transcripts stay intact” sentence now has the explicit
[authorized-deletion exception](../decisions/chat-history-deletion.md#native-preservation-amendment).
Preservation remains binding for ordinary live operation and undeleted chats.
Task-recovery eviction is not archive eviction. The
[explicit Start rule](../decisions/live-conversation.md#new-live-epochs-receive-existing-chat-text--2026-10-31-3178)
requires Enter to send nothing, and binds startup to the exact disclosed profile,
principal, session and entry lifetime. Deletion cannot count as Start or preserve
consent for a replacement identity. Existing [session principals](../decisions/session-principals.md),
[provider history](../decisions/provider-history.md),
[handoff](../decisions/session-handoff.md),
[storage boundaries](../decisions/design-kit/storage.md#maintenance-and-ongoing-management)
and [operational recovery](../inbox-recovery.md) remain binding.

There is no general delete operation: `createSessionRoutes` only lists/reads
(`createSessionRoutes`, `packages/ui-server/src/routes/sessions.ts:9-157`).
`AgentBackend` exposes native list/read and read-only storage roots, not deletion
(`AgentBackend`, `packages/ui-sdk/src/server/backend.ts:765-808`). A storage root
is not removal authority. Future supported package/HTTP/wire changes need their
actual contract assessment and a CONTRACT commit; additive capability negotiation
ships in a minor. The approved retention exception is recorded before runtime
work; any other altered retention meaning or fence lifetime needs a separate
breaking ruling.
This document changes no machine surface or shipped retention behavior.

## Ownership inventory

These are content owners and independent ledgers, not a SQL deletion recipe.
Schema references name the concrete migration under `packages/ui-server/migrations/`.
Implementation must re-inventory against its candidate; third-party native stores
must be tested through their installed runtime, not inferred from directory names.

- **Native Claude history.** Live JSONL, per-session subordinate files, titles,
  archive manifests/index/staged or conflict copies can contain readable text.
  History reads can restore archived files before reading the SDK transcript
  (`createHistory`, `packages/ui-backend-claude/src/history.ts:45-103`;
  `restoreArchivedSession`, `packages/ui-backend-claude/src/transcript-archive.ts:179-207`).
  The live/archive roots are resolved by the backend
  (`transcriptPaths`, `packages/ui-backend-claude/src/transcript-archive.ts:31-40`).
  Archive movement and crash recovery must join the same lifecycle fence
  (`archiveIdleSessions`, `packages/ui-backend-claude/src/transcript-archive.ts:261-321`).
  Delete all owned branches/subagents/copies, not just the displayed branch.
  Unknown/unattributable archive remnants mean removal is incomplete.
- **Native Pi history.** SessionManager JSONL trees retain inactive branches and
  tool results beyond the active branch rendered by `getPiHistory`
  (`getPiHistory`, `packages/ui-backend-pi/src/history.ts:64-128`). Remove the entire
  backend-verified session tree and metadata, not a normalized history array.
  Runtime in-memory sessions, worker input/state copies and open descriptors
  must be quiescent as well; unlink alone does not stop a holder republishing.
- **Native-adjacent host files.** Display text mappings and replay receipts include
  tool inputs/outputs (`sessionReplay`, `packages/ui-sdk/src/server/session-replay.ts:24-78`).
  Prompt context retains original user text, the frozen append and delivered facts
  (`sessionPromptContext`, `packages/ui-sdk/src/server/session-prompt-context.ts:26-87`).
  These hashed session files are outside the brain and are not fully enumerated
  by the backend's transcript roots. Removal must explicitly include them.
- **Canonical dialogue and provenance.** `071_session_dialogue.sql` owns
  `dialogue_owners`, `dialogue_conversations`, `dialogue_records` and aliases.
  Payloads include independent recognition/output evidence and backend range text;
  hashes/order/identity are not substitutes for erasing the payload. An owner can
  start unbound, bind to a backend session or merge into an existing owner through
  aliases (`bindDialogue`, `packages/ui-server/src/ws/dialogue-storage.ts:176-222`).
  Resolve the complete alias/conversation set transactionally; do not delete only
  the current session key or confuse a provisional owner ID with a backend ID.
- **Task recovery and facts.** `069_conversation_tasks.sql` and
  `070_conversation_result_facts.sql` retain epochs, detailed JSON receipts
  (including submitted context), bounded result facts and independently consumed
  native/task/request identities. Content retention and identity retention differ
  (`saveConversationTask`, `packages/ui-server/src/ws/conversation-storage.ts:37-77`).
  Loading may return receipts/results even without a current provider session
  (`loadConversation`, `packages/ui-server/src/ws/conversation-storage.ts:78-105`).
  Clear receipt/result content while preserving replay refusal under a new lifecycle
  fence; do not cascade away consumed identities and then allow their reuse.
- **Session projections.** `sessions` title and `034_session_labels.sql` label/source;
  `015_message_blocks.sql` classified block JSON; `016_classification_confidence.sql`
  questions/diagnostics; `017_message_sources.sql` plus `020_message_effort.sql` and
  later source metadata; `018_local_exchanges.sql` prompt/answer/context;
  `019_retry_requests.sql` original request/images/prompt/failure;
  `025_turn_failures.sql` failure JSON; `040_state_room_observations.sql` observation;
  `044_policy_proposals.sql` review; `047_turn_scope.sql` summary. Remove direct
  readable projections according to the adopted extent. Retained digests can
  reveal guessed short text; discard unnecessary hashes, not just plaintext.
  Native history joins several of these owners
  (`prepareHistory`, `packages/ui-server/src/ws/host.ts:642-654`).
- **Independent session ledgers.** `retry_receipts`, `session_work`, `turn_boundaries`,
  draft send/save/upload receipts and revisions, handoff IDs/lineage, Claude usage
  deduplication, worker profiles, provider-exposure and born-masked lineage are
  not all transcript content. Relevant migrations are `019`, `031_session_handoff`,
  `032_session_drafts`, `033_session_recovery`, `043`, `051_claude_usage_accounting`,
  `061` and `064`. Preserve required numeric/accounting/identity refusal facts;
  minimize labels, paths and diagnostic strings. Do not assume every FK cascades:
  some are absent, some erase a ledger the design needs to retain.
- **Drafts and attachments.** `032_session_drafts.sql` holds text/image BLOBs,
  revision tombstones, response JSON and accepted-send bindings. Drafts are shared
  host state, not private to their last editing principal. Clear only drafts
  positively bound to the selected session or its adopted provisional identity;
  include bytes and receipt responses that could expose old content. Preserve a
  revision/idempotency refusal fence. Unbound and unrelated unsent drafts remain
  independent; never infer ownership from matching text or active selection.
- **Independent work, effects and audit.** Inbox items/checkpoints/change payloads,
  intake/Action contexts, application results and staging may copy conversation
  content (`021_inbox.sql`, `022_inbox_intake.sql`, `050_interactive_shares.sql`).
  Conversation provenance is immutable trust evidence, not complete deletion
  ownership (`recordInboxProvenance`, `packages/ui-server/src/inbox/provenance.ts:93-118`).
  Governance payloads, Activity attrs/events/reasons/notifications, lifecycle and
  budget receipts, and journal summaries/manifests/before-after objects can retain
  related data (Activity spans: `023_autonomous_activity.sql`; Activity events,
  rollups and notifications: `007_activity.sql`/`009_activity_followups.sql`;
  governance/journal/budgets/lifecycle: `038`, `042`, `045`, `046`,
  `051_turn_lifecycle`). The journal
  uses its own database and object store; a UI-table cascade cannot purge it.
  Retain these independent workflows/effect/accounting guarantees
  under an explicit exclusion. Any direct embedded chat copy discovered there
  must be named in the retained-scope disclosure or removed by its actual owner
  under an approved policy. Do not silently claim they are content-free.
- **Derived content and handoffs.** Reviewed summaries already copied into a new
  chat are that chat's first message; saved Markdown/files, promoted artifacts,
  external Claude memory and Git/journal/checkpoint history can contain copied text.
  These are independent retained content, not automatically owned by the source
  chat. Scratch-pin references are operational metadata that must stop re-reading
  the retired chat, without deleting the pinned artifact
  (`createScratchPins`, `packages/ui-server/src/cron/scratch-pins.ts:49-70`).
- **Volatile host state.** Coordinator turns/queues, retry and failure-replay state,
  handoff preparation, classifier callbacks, DialogueJournal routing/pending writes,
  ConversationHost receipts/results/output and frozen startup envelopes can retain
  or publish text. Catalog optimistic maps precede worker acknowledgements
  (`rowEffects`, `packages/ui-server/src/ws/session-catalog.ts:255-268`;
  `activeDialogueEpochs`, `packages/ui-server/src/ws/session-catalog.ts:298-301`).
  Both submission and worker commit need a generation check.
- **Browser state.** Chat buffers/history chunks, shared timeline, session
  title/list cache, dialogue pages/cursors, recognition/generated/unsaved tails,
  work/follow-up/retry/approval state, draft edit/send snapshots, handoff summaries,
  attachment object URLs and current history selection can expose text. Principal
  purge is an existing boundary, not a per-chat deletion API
  (`clearPrivateDialogue`, `packages/ui-react/src/voice/conversation-client.ts:594-607`).
  Root-owned IndexedDB answer delivery and account-partitioned local work can retain
  answers, drafts or transcripts independently
  (`persistent`, `packages/ui-react/src/root.ts:223-246`). Include positively bound
  chat records in invalidation, preserving other account/session work. Recordings,
  unassigned capture, service-worker/share intake and exported/downloaded copies
  need an honest exclusion or separate positive ownership, never blanket origin
  storage clearing. A suspended/offline/older tab cannot be remotely erased.
- **Recovery copies and outside recipients.** The operational export contains the
  entire UI database (and embedded journal tables), plus share staging; native
  transcripts/metadata and journal objects have separate storage coverage.
  Host/filesystem backups, SQLite WAL/free pages, native staging, provider caches,
  screenshots/clipboard/downloads and remote exports may retain bytes. No local
  operation promises secure physical erasure or provider-side deletion.

## Read and replay consumers to fence

Apply the lifecycle gate to every backend list/read/resume path, not only the
new endpoint: HTTP sessions/list/detail/recovery; WS resume and connection
snapshots; dialogue paging/live-tail; recovery probes and FailureReplay; Retry;
new live epoch startup and same-conversation resync; handoff preparation/start;
cron scratch-pin refresh; backend native resume/archive/restore; and all browser
restore, resend, draft autosave and answer-delivery callbacks. Activity/Inbox/
journal APIs remain independent retained surfaces under the selected exclusion.
Concrete entry points include `readSessionRecovery`
(`readSessionRecovery`, `packages/ui-server/src/ws/recovery.ts:209-222`),
`FailureReplay` (`FailureReplay`, `packages/ui-server/src/ws/turn-failures.ts:67-93`),
and both handoff stages (`startHandoff`, `packages/ui-server/src/ws/handoff.ts:100-110`;
`prepareHandoff`, `packages/ui-server/src/ws/handoff.ts:273-285`). Draft autosave
belongs to `createDraftClient` (`createDraftClient`,
`packages/ui-react/src/lib/draft-client.ts:53-65`); browser reloadable work belongs
to `createLocalWork` (`createLocalWork`, `packages/ui-react/src/lib/local-work.ts:227-245`).
The paired WS dispatcher is `packages/ui-server/src/ws/dispatch.ts`, with one
handler per frame under `ws/handlers/`; gating its resume handler alone would leave HTTP, background readers and provider startup open.

Existing ordinary history publication checks concurrent turn changes
(`publishHistory`, `packages/ui-server/src/ws/host.ts:568-602`). Future deletion
must additionally invalidate it even when no turn starts or ends. Startup reads
native history, canonical evidence and completed facts, and freezes a snapshot
(`readLiveHistory`, `packages/ui-server/src/ws/live-history.ts:9-74`). Recheck the
lifecycle after each await and immediately before provider open/seed. A native-only
chat with no dialogue owner still needs a fence; checking only page generation
leaves that path unprotected.

## Proposed lifecycle and truthful outcomes

Use one stable chat lifecycle identity scoped to the host installation and actual
backend/owner bindings. Never accept an arbitrary filesystem path from the client.
Capture authorization, canonical owner/aliases, expected generation and backend
identity on admission. A repeated operation key returns the same non-content
operation result; it never re-authorizes deletion of a replacement identity.

In the existing serialized writer, atomically compare the expected live identity,
refuse busy effects, persist a content-free deletion intent, advance its generation,
and make every reader/writer/adoption/resume refuse the retired target. Resolve
racing adoption on one side of that transaction: a successful earlier bind expands
the exact deletion set; a later bind is refused. Keep alias and native-conversation
IDs as negative lookups so another callback cannot recreate generation 1.

Then drain/retire active readers, voice epochs and native holders; revoke entry
consent, stop capture/playback, clear pending text callbacks and invalidate frozen
provider seeds. Never edit an already-sent provider prefix. Close the old epoch
and refuse resume; any future conversation is a new identity with a fresh Start
and disclosure. A vendor may already possess earlier bytes: say so.

Preserve the existing bounded-wait ownership distinction during that drain.
`guardSqliteCleanup` observes the shared UI/journal and separate native-lease
writers; rejection retains the original cleanup continuation, writer and reader
until genuine settlement, rather than authorizing their replacement
(`guardSqliteCleanup`, `packages/ui-server/src/db/write-worker.ts:206-234`;
`close: () => closing ??= guardSqliteCleanup`, `packages/ui-server/src/app.ts:1370-1420`).
The native lease manager retains its own pending operations and durable unknown
root outcomes through close (`return { client, writer, recoverDeadOwners`,
`packages/ui-server/src/brain/native-brain-leases.ts:274-287`). A caller deadline
is not proof that native I/O stopped, cleanup succeeded or deletion completed.
Keep the proposed partial/unknown outcome and identity fence while that cleanup
remains owned; follow the existing [shutdown ownership contract](../decisions/sqlite-write-worker.md#bounded-caller-waits-retain-real-cleanup-ownership-3185).

Backend-owned removal must enumerate and identity-check its concrete files,
including archives, crash stages, display mappings and prompt snapshots. Coordinate
archive/restore locks, reject links/foreign roots/replaced files, and reconcile a
crash by operation identity. An absent verified owned artifact is idempotently
removed; an unresolvable identity is unknown, not success. Then clear owned SQLite
content and bound drafts through their owners, retaining minimized refusal facts.
Deletion intent survives crashes independently of unfinished per-store cleanup.

Suggested semantic outcomes (not an approved wire schema):

- **Refused before retirement:** unauthorized, stale target, unsupported backend,
  unknown ownership or busy effect. No deletion; no content or existence leak to
  an unauthorized caller. Prefer this preflight refusal for known unsupported
  backends; never silently hide native content and report deleted.
- **Retired, cleanup pending/partial:** chat access and new writes are fenced;
  one or more stores still contain content or cannot confirm removal. Return only
  store categories and retry/reconcile action, never retained text or raw paths.
  Retry cleanup under the same intent, not by recreating the chat.
- **Local owned history removed:** every selected store confirmed removal; connected
  client invalidations published. Report independent records/old backups/provider
  copies and offline-device limits explicitly. Browser acknowledgement is not proof
  that every device erased its copy. Do not report a reclaimed-byte figure without
  actual per-capacity measurement.
- **Unknown outcome:** interruption after an external store change without a durable
  acknowledgement. Reconcile actual store identities on restart; do not reset the
  fence or imply that effects were undone.

Minimum surviving facts: installation/chat identity, former native session and
alias/conversation bindings, terminal generation/state, deletion operation key and
per-store non-content result, authorization principal binding, consumed task/native/
request IDs, and required revision/accounting/effect refusal state. No recognition,
submitted task prompt, result facts, title, original hash of guessed short text,
attachments or free-form error is needed in the deletion receipt. Existing task
keys remain consumed under their original epoch/principal. This is a new explicit
lifecycle guarantee, not permission to expire today's recovery ledgers.

Clients apply a targeted invalidation before later queued frames can publish:
advance the chat lifetime, clear all above projections and object URLs, block old
cursor/history responses, stop autosave/resend/retry for that target and preserve
other sessions' focus/ordering/drafts. Cross-tab delivery is helpful, not authority.
On reconnect/reload, validate the server lifecycle before rendering or resending
cached content. A service worker must not answer a retired authenticated history
read with cached data. Offline content remains locally accessible until the client
can validate/apply deletion; disclose that limitation instead of promising erasure.

## Migration and restore implications

Add an internal lifecycle ledger with coverage for native-only and provisional
chats, not just current `dialogue_owners`. Backfill identities from verified native
ownership plus catalog bindings; conflicting/ambiguous legacy mappings are
unsupported until reconciled, never guessed by title. Do not backfill missing
spoken words or authenticate unknown native user entries. Preserve sequence/order,
principal isolation, source gaps and existing compatibility meanings for undeleted
chats. Gate a new client capability explicitly; old clients must be denied access
server-side rather than relying on their invalidation support.

Migrate destructive FK behavior deliberately: `conversation_tasks` currently
cascades with epochs and retry receipts with sessions. Keep tombstones outside
content cascades, or retain minimized parent identity rows. Validate actual SQL,
including attached journal state, in native SQLite fixtures. Do not add content
to `brain.db`, create a second operational authority, or reuse storage-maintenance
removal as an arbitrary transcript-file eraser.

Restore currently increments dialogue generations and closes native continuity
(`restoreInboxSnapshot`, `packages/ui-server/src/inbox/snapshot.ts:427-482`). That
invalidates cursors but does not know a deletion performed after the backup.
A post-deletion export must carry its new ledger and scrubbed owned content;
restoring it must preserve negative lookups and refuse old writes. An earlier
backup can restore deleted text and older ledgers. Surface that recovery point,
keep execution reconciled/paused under existing recovery rules, and require an
operator to replay known later deletion intents before serving restored data if
such a ledger is available. No outside-image ledger or new backup policy is
approved here. Native-file restore must be reconciled with the same operation;
restoring an old transcript must never bypass a surviving deletion tombstone.

## Bounded implementation brief and proof owed

The binding decision settles authority, extent (including the native-history
amendment) and restore/tombstone policy. Retain the conservative busy-work refusal
default. Implement the lifecycle transaction/read-write gate and first-party native
removal
under existing owners; add an additive backend capability only when both concrete
implementations and unsupported behavior are specified. Next join projections,
drafts and startup fences, then targeted browser invalidation. Expose an endpoint
and user flow only after store completion semantics and copy are approved. Keep
separate implementation issues in the tracker, with exact contract, migration and
release assessments; this document is not a progress checklist.

The implementation owes keyless failing-first **runtime** cases, using fresh
Odysseus fixtures, actual file-backed SQLite/writer workers, both installed native
history backends over isolated synthetic files, and the documented pinned offline
browser harness. Never touch a live transcript or call an actual provider.

- Seed a unique secret marker in every selected owner, including receipt JSON,
  result facts, local exchange, archive stage/conflict, prompt/display metadata,
  draft response and images. Assert each is readable before deletion, absent from
  all selected stores/read paths after it, and remains readable in an unrelated
  control chat. Do not infer erasure from an empty session list.
- Block actual worker/backend callbacks before commit, bind, result delivery,
  archive restore and startup seed. Retire the target, release the barrier and
  assert zero writes/publications/provider opens. Mutate each generation check
  individually: fail the named late-write/publication assertion, then restore.
  Cover pending acknowledgement and both alias-adoption orders.
- Start history-only and native-only reads before retirement. Release after it;
  HTTP, WS chunks, old cursor/high-water, recovery, handoff, scratch refresh and
  both live engines must return no deleted marker. Mutate final post-await gates
  separately from authorization. Unknown source users remain gaps throughout.
- Replay consumed task/native handle/request, Retry, draft save/upload/send and
  answer submissions after deletion/restart. Assert no execution, no restored
  facts/attachments and unchanged accounting. Mutate tombstone retention to make
  the exact replay assertion fail, not a module-load or unrelated auth check.
- Interrupt each durable cleanup boundary, reopen the database and reconcile.
  One failed/unavailable backend reports partial/unknown honestly; no completed
  result until actual store checks succeed. Unsupported backend refuses before
  retirement. Include replaced file/link/hard-link/foreign-root controls without
  broad deletes; mutation must fail the exact ownership assertion.
- Restore a post-deletion operational image and separately an older image/native
  archive. Prove the former retains negative identity fences and the latter's
  documented recovery-point limitation. Never call old-backup resurrection a
  successful no-resurrection test. Run actual export/restore with child exit checks.
- In real browser tabs, populate transcript/voice/drafts/answer delivery, delay
  frames and autosaves, delete, switch chat, reload, disconnect/reconnect and
  retire the principal. Assert the marker is never republished for the retired
  chat and unrelated reader focus/scroll/drafts survive. Observe store
  subscriptions as well as DOM to catch transient leaks. Mutate invalidation and
  stale-response gates separately. Enter sends nothing; only explicit Start can
  open a fresh disclosed identity. Offline and old-client limits stay explicit.
- Run existing provider-prefix guards for both backends and startup-history/consent
  guards whenever their paths change. Prove no earlier provider byte was rewritten,
  no host task wrapper became user speech, no result replay occurred, and no paid
  or non-loopback request escaped the existing offline harness.

These are proposed acceptance/proof obligations, not executed deletion tests.
This spike verifies the written source inventory and citations; it does not
claim implemented deletion, browser erasure or provider forgetting.
