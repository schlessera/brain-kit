# Live conversation: two engines, one host boundary

2026-10-04. The maintainer's [October 3 ruling on #317](https://github.com/schlessera/brain-kit/issues/317#issuecomment-5973820627)
selects **Gemini Live and OpenAI GPT-Live behind one live-conversation
interface**. Both are intended implementations within a year, satisfying
ROADMAP's second-implementation rule. This record specifies that direction;
it exports no interface, ships no provider and approves no paid experiment.

## Why an integrated conversation interface

The required experience keeps listening and conversing while host-owned work
is pending, then incorporates an identified result. An asynchronous SDK method
or parallel tool calls alone do not satisfy that requirement. The
[qualification and interface specification](../investigations/live-conversation-investigation.md)
compares `gemini-3.8-live` with GPT-Live `gpt-live-1` client delegation against
the same boundary. Native nonblocking functions and application delegation
are different mechanisms; adapters must preserve those differences.

The existing dictation interfaces mint an input session and collect text
(`export interface SpeechProvider`, `packages/ui-sdk/src/server/speech.ts:26-44`;
`export interface AsrClient`, `packages/ui-sdk/src/client/asr.ts:21-28`). Keep
phase-1 dictation intact. A conversation owns bidirectional audio, lifecycle,
work correlation and output scheduling. Appending a TTS method to dictation
would hide those responsibilities rather than specify them.

## Authority stays with the host

The host owns context, semantic commit, session/turn/request/tool identities,
tool admission and execution, permissions, cancellation, terminal state and
resynchronization. Engine task requests are advisory until mapped to committed
user input. No native search, code-execution or alternate permission loop is
enabled. Both adapters can delegate through the existing `AgentBackend`
(`export interface AgentBackend`, `packages/ui-sdk/src/server/backend.ts:708-751`);
the host serializes work in a session and uses capability-checked follow-ups.

The [voice-permission decision](voice-permission.md) binds this interface.
Voice may refuse and may never grant. New voice turns use enforced declared
tools and `noGrantSurface`; entering voice on an ordinary turn preserves its
posture. A speech provider cannot reinterpret a visual grant, widen an
allowlist, or settle an approval because it generated an answer.

The host resolves pending exchanges when a turn ends
(`drainPendingForTurn`, `packages/ui-server/src/ws/turns.ts:704-738`). The
conversation integration must also reconcile client cards and audible claims;
that server method is not proof of a client receipt. Completion requires host
terminal state plus local playback drained or discarded. Provider generation
completion is a separate fact.

## Capabilities are evidence, not promises

Publish a conversation capability profile that distinguishes supported,
unsupported and unproven behavior. Do not call approximate transcript fragments
final user intent, generated words spoken words, a local audio cut a remote
cancellation acknowledgement, or a model paraphrase approved effect copy.
Unknown finalization, overlap or echo isolation requires review or a closed
audio gate. Permission announcements require a host-controlled exact-copy
path; general model commentary does not qualify by prompting alone.

The evidence is documentation, installed SDK serialization and a ten-scenario
keyless scheduling prototype. There were **zero live provider calls and zero
live audio samples**. No latency, recognition quality, acoustic echo rejection
or exact spoken permission copy was measured. The investigation records
bounded device/provider verification separately. The architecture selection
does not certify runtime readiness or approve all proposed controls/timings
in [the interaction proposal](../plans/voice-conversation.md).

## Alternatives and their costs

- **Cascaded ASR → agent → TTS:** offers explicit text/output boundaries, but
  introduces separate endpoint and speech startup stages. It remains useful
  context and a fallback to evaluate if a specific safety requirement cannot
  be met; the approved spike does not require a third implemented comparator.
- **Choose only one integrated engine:** reduces initial adapter work but
  contradicts the explicit two-engine ruling and loses the intended second
  implementation that justifies the interface.
- **Expose vendor events as the application API:** makes vendor call IDs and
  transcript timing accidental authority, and ties reconnect and permission
  handling to one engine. Normalize evidence while retaining real capability
  limits instead.
- **Standalone TTS seam or speech-side tool executor:** neither is selected.
  Separate pipeline stages do not independently justify interfaces. Shared
  host permission and backend behavior must not be duplicated in speech.
- **OpenAI-managed Responses delegation:** an available vendor mechanism,
  but application-owned client delegation fits existing backend/context
  authority. The selected comparison does not move brain-kit's agent loop
  into the voice service.

## Compatibility boundary

The future conversation interface is additive and separately registered;
neither `SpeechProvider` nor `AsrClient` changes meaning. Conversation lifecycle,
capability/configuration discovery, provenance, confirmed resolution and replay
events will need their own documented SDK/wire contract before implementation.
Keep legacy clients and rev-3 turn-correlation guarantees. Event/configuration
additions require a `CONTRACT:` commit, same-commit integration-contract update
and named minor changeset. A break needs its own prior maintainer ruling.
This documentation-only decision changes none of those published surfaces.

Implementation and release sequencing belong to [epic #54](https://github.com/schlessera/brain-kit/issues/54).
The completed capability record supplies #114's architecture input; final
interaction design and live-device proof remain independent requirements.

## The host contract — 2026-10-05

[#957](https://github.com/schlessera/brain-kit/issues/957) exports the seam as
`LiveConversationProvider` and implements the host side of this record; the
[integration contract](../integration-contract/wire.md#live-conversation-additive-957)
is the normative text. Three choices it made within this record's scope:

- **Commit is a client frame.** The client reviews the recognized text and
  sends `conversation_commit`; nothing else creates work. A provider's work
  request only binds a correlation handle to committed work.
- **One request at a time per conversation, each its own turn.** Host work
  never joins a running turn as a native follow-up, because a merged turn
  would give two requests one result. A busy session queues it, as it queues
  a typed message.
- **Cancelled work is not narrated.** The provider receives completed and
  failed results only; cancellation, withdrawal and a replaced epoch keep the
  host outcome and discard the narration. `returnWork` therefore has no
  `cancelled` or `denied` outcome.

Permission outcomes became host-authoritative for every client that asks
(`tool_resolution`), not only for conversations. No adapter ships; #958 and
#959 implement the two engines against this seam, and #961 still gates
activation on measured device and provider behavior.

## Shared task policy and hands-free admission — 2026-10-28

The [maintainer ruling on #3070](https://github.com/schlessera/brain-kit/issues/3070#issuecomment-6457436905)
supersedes the client-commit-only admission and separate narrower voice posture
for the live-conversation task path. Both selected speech services may propose
background work while dialogue continues. The host forms a task-specific
request from bounded, honestly labeled conversation context, creates new host
identities, binds the exact native handle before dispatch, and executes through
the same ordinary backend/session/principal policy as typed work. This is no
permission grant, authenticated transcript or captured-input ownership claim.
A provider request cannot attach itself by arrival to existing manual work.

Routine permitted work needs no Send or extra voice consent. Ordinary screen
cards remain required wherever typed work requires them; uncertain speech
cannot settle them. Curated and governed writes are allowed exactly where the
ordinary policy permits them. Protected resources, egress, budgets, cancellation,
writer checks, receipts and supported recovery remain binding. See the
[policy supersession](voice-permission.md#live-conversation-policy-supersession--2026-10-28).
Explicit legacy restricted-posture consumers keep their existing enforcement
or safe refusal. Missing provider input finality never becomes fabricated user
finality; #3064 must use honest unassigned recognition for continuity.

#3071 delivers the shared-policy execution portion. Automatic task admission,
new task/native identity binding and continuous Gemini capture remain #3070 and
#3064 work. The October 5 client-commit wire implementation remains in place
until those paths ship; this ruling does not describe them as implemented.


## Contextual work and recognition — 2026-10-28 (#3070)

The [maintainer ruling](https://github.com/schlessera/brain-kit/issues/3070#issuecomment-6457436905)
supersedes client-commit-only admission for negotiated contextual work. The host
may admit a new task from recent recognized/generated conversation context.
Recognition is uncertain evidence, never authenticated operator text or a grant.
The ordinary task backend interprets intent and applies its ordinary session and
principal policy, including screen cards. This applies to both first-party engines.

The existing provider seam negotiates contextual tasks with an optional capability
and opening option. Absent negotiation retains reviewed behavior. Each native
handle binds to a newly minted host task before dispatch, never to manual, running
or future work. Context is frozen and bounded; identity tombstones outlive receipt
eviction. Failed/ambiguous delivery is not replay permission. Replacement epochs
receive historical outcomes only and never replay work. Recovery rechecks the
registered owner after storage awaits, so concurrent resumes share one epoch
counter and use ordinary replacement. Native refusals terminate under their
exact binding without an executed turn, releasing pending slots while keeping
tombstones. A binding/refusal failure closes the epoch rather than borrowing work.

Gemini transcription has no captured-input identity. In contextual mode it is
unassigned from epoch start with unavailable timing and its actual finished signal
preserved only as evidence. Endpoints, output completion and drained playback do
not establish input ownership. GPT keeps actual provider session intervals and
explicit mismatched-ID rejection. Neither stream can settle a permission card.

Both adapters delegate to the host while dialogue continues. Gemini declares
host_task NON_BLOCKING and returns the exact call id with SILENT/WHEN_IDLE and
willContinue:false. GPT uses Live v1 client delegation, SpawnThinking instructions,
and exact delegation_id on bounded thinking/commentary appends. Acceptance and
playback remain distinct; neither a socket send nor an append acknowledgement
proves audible output. Source configuration and keyless fixtures do not qualify
a live account, microphone, interruption, or device.

Source verification on October 28 used the installed OpenAI Live v1
`DelegationCreatedEvent`, `ThinkingAppendEvent`, `CommentaryAppendEvent` and
matching appended-event declarations, the official [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation)
and [prompting guide](https://developers.openai.com/api/docs/guides/live-prompting),
and Google's [Live WebSocket reference](https://ai.google.dev/api/live) plus
installed `FunctionResponse`/scheduling declarations. Delegation is metadata,
not task text. The literal SpawnThinking instruction is prompt text, not an
invented client event. These sources establish API fields, not live behavior.

## Continuous conversation and audible recovery — 2026-10-29

The [automatic-recovery ruling on #3053](https://github.com/schlessera/brain-kit/issues/3053#issuecomment-6483873750)
selects automatic audible recovery as the product direction, beyond the earlier
evaluation-only approval. The later **Latest continuous-conversation requirement
and report — 2026-10-29** amendment in [#3053](https://github.com/schlessera/brain-kit/issues/3053)
extends that direction: once explicitly entered, conversation keeps listening
and conversing on both Gemini Live and GPT-Live. Capture may remain off only
after manual Mute, manual Leave, or a drastic technical problem. Ordinary
speaking, interruption, silence, task activity, result arrival and recoverable
transitions must not require repeated Unmute/Resume.

This supersedes the blanket capture-off/explicit-Resume choices for ordinary
interruption, hide/background, disconnect and resync in the earlier interaction
proposal and October 5 review. It does not assert that the browser can capture
while suspended or a disconnected provider can receive audio. Temporary
unavailability must be reported honestly; when the same consented scope is
usable again, recoverable transitions should restore conversation without
another unmute. Never buffer and replay disconnected microphone audio as new
intent or replay host effects during recovery.

### Consent and genuine failure boundaries

Manual Mute remains authoritative across callbacks, timers, reconnects and new
epochs until explicit Unmute. Manual Leave ends the conversation; no recovery
path may restart it. Explicit Stop reply stops output and reconciles host work
as applicable; it is not a manual microphone mute or Leave. Automatic adoption
of the conversation's host task/session is routine activity, not renewed consent
or a reason to stop listening. An explicit selection of another conversation
must not silently transfer the microphone's scope or audio destination.

A genuine failure is a concrete unavailable or unsafe prerequisite: revoked or
denied microphone permission, an unavailable capture device, failed capture or
transport that cannot recover safely, lost authentication/authorized scope, an
unrecoverable capacity/correlation failure, or a changed service/audio
destination requiring a fresh disclosure and Start. Stop safely and explain
the actual prerequisite and recovery action. Visibility changes, a reconnect,
ordinary host work or uncertain output cancellation alone are not blanket
consent invalidation. Stale callbacks never establish scope or consent. No
silent provider/destination switch is authorized by continuity.

A browser-retained chat ID is not host identity evidence (#3176). Validate
it before opening live conversation. An absent chat is an unavailable scope,
not permission to create another or replay failed work. Explicit New conversation
uses the existing draft-preserving navigation; catalog/read failures must not be
misreported as absence. Ordinary history recovery still recognizes imported
backend history, while live task/profile admission requires a registered chat.

### Interruption and output recovery

Retain consented capture, applicable conversation context and the initiating
speech bytes. Cut all queued local playback immediately, suppress provider
output while the user speaks, then attempt audible recovery using a bounded
silence check. If that check times out, make output-muted status and an explicit
manual **output recovery** action clear; this timeout is not permission to mute
the microphone. Subsequent audible dialogue is the goal. Permanently muted
output and today's repeated Resume fallback were rejected as the product goal.

Occasional delayed audio from the interrupted answer is an accepted product
tradeoff, conditional on qualification. A silence boundary is a local playback
heuristic, never proof of remote cancellation, a completed answer, trustworthy
per-answer attribution or host terminal state. Generated, locally played and
unknown spoken portions remain distinct. The evaluation's 300 ms silence check
and three-second deadline are starting points requiring qualification, not
production guarantees; this ruling does not mandate exact-zero PCM as the
production silence detector.

Continuous capture does not authorize continuous execution. Preserve the
[shared typed/live policy](voice-permission.md#live-conversation-policy-supersession--2026-10-28),
screen grants, scoped refusal and acoustic-attribution guards, honest unassigned
recognition/manual review, question binding, host-owned identities and
serialization/cancellation. Do not dispatch a replacement mutating turn before
the original work is safely reconciled. An output cut or speech disconnect
cannot undo a completed effect, confirm a denial or settle an unknown outcome.
Pending tasks, questions and approvals must not themselves disable capture.

### Evidence and compatibility

[#3053](https://github.com/schlessera/brain-kit/issues/3053) owns implementation
and qualification: real browser capture/playback through adapter and host,
initiating-speech retention, subsequent audible dialogue, delayed tails/stalls,
silence/timeout, pending work/questions/permissions, task/session adoption,
capacity, visibility, reconnect/resync and manual-Mute/Leave negative controls.
Verify both providers independently; a Gemini report proves no GPT result.
Applicable provider/device and speaker/headphone checks remain with #961/#114;
keyless runtime evidence is not acoustic qualification. Neither the research
PR #3054 nor evaluation prototype #3056 is approved for merge by this decision.

The policy amendment itself changed no code or normative wire text. #3053's
implementation replaces the [client lifecycle contract](../integration-contract/wire.md#shipped-conversation-client-960)
in the same commit as the behavior. Replacing capture-off/Resume with retained
consent changes documented meaning: a pre-1.0 breaking minor under the recorded
October 29 ruling, with CONTRACT prefix/label, breaking label and a changeset
naming the break. Product direction and keyless proof supply no live acoustic
qualification, capability promotion, paid-call authorization or release commitment.

The concrete client separates consent, actual capture and local output recovery.
Visibility suspends local media while retaining a healthy provider epoch/context;
transport loss closes the unavailable epoch and restores only after same-scope
readiness and historical resync. Unavailable audio is dropped. Control-owner leases
keep React effect replay or same-commit remount from impersonating manual Mute.
Opening ownership follows explicit entry/Leave rather than the PCM callback
counter, so hiding cannot turn a valid replacement response into destructive
teardown. Disclosure compares the entry's effective profile and its current
metadata, not a later UI picker pin: task adoption remains routine, while
same-ID backend/model changes or removal require a fresh disclosure and Start.
Contextual recognition is recent bounded context, distinct from legacy retained
manual review. Identity/replay ledgers keep their finite fail-closed boundaries;
forgetting an identity to extend a session would weaken correlation/replay guards.

The local output heuristic checks 300 ms without nonzero PCM after endpoint, with
a fixed three-second deadline. Digital zero and absent packets permit the check;
late nonzero output resets quiet evidence but never extends the deadline. This
avoids making exact-zero provider packets a prerequisite, while accepting delayed
old audio and possible fast-reply head loss. Neither a timer nor digital quiet
proves an answer ended. Timeout exposes output recovery without revoking capture.

Manual Send, a reviewed question answer and Discard close the current input
through that same endpoint transition before cancelling review timers. They do
not cancel the output recovery deadline. Discard retires its reviewed fragments
so a late final cannot restore discarded text or schedule a send. Mute also
closes input before cancelling review timers, retaining manual capture intent.

## Retained discussion — 2026-10-30 (#3177)

The maintainer requires the complete recognized/generated discussion to remain
visible when reopening its chat, on both Gemini Live and GPT Live, including
same-chat engine changes. This explicitly supersedes #3050's temporary client
presentation/no-durable-reload guarantee. Preserve exact uncertain evidence,
not authenticated quotes or inferred input/reply pairs; generated and played
remain independent. Draft editing/Discard controls the separate draft candidate.

Dialogue stays with its chat. Display pages, provider context and pending-write
memory have finite bounds; those are not permission to expire old dialogue or
routinely stop ongoing conversation at a small archive cap. Actual storage/quota
failure or actual pending-write pressure preserves the committed prefix and exposes the unsaved tail and cause-specific recovery
prerequisite. No general whole-chat deletion feature exists at this source;
#3180 records that explicit lifecycle design rather than inventing expiry/UI.

The existing operational catalog/write worker owns evidence and order metadata;
the existing root timeline projects it. Native provider transcripts stay intact.
Reopening history is read-only and conveys no native replay, tool admission or
microphone consent. #3178 owns the separately authorized, bounded historical-data
projection into a new provider epoch, preserving the same-conversation/earlier-
epoch result guard. Rendering restored text proves no model receipt or recall.

This is a recorded pre-1.0 breaking retention/privacy meaning change with additive
negotiated fields, as specified in the integration contract. No paid qualification,
provider capability promotion or release commitment follows from this ruling.
