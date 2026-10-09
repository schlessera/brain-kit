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
[qualification and interface specification](../live-conversation-investigation.md)
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
(`export interface AgentBackend`, `packages/ui-sdk/src/server/backend.ts:452-478`);
the host serializes work in a session and uses capability-checked follow-ups.

The [voice-permission decision](voice-permission.md) binds this interface.
Voice may refuse and may never grant. New voice turns use enforced declared
tools and `noGrantSurface`; entering voice on an ordinary turn preserves its
posture. A speech provider cannot reinterpret a visual grant, widen an
allowlist, or settle an approval because it generated an answer.

The host resolves pending exchanges when a turn ends
(`drainPendingForTurn`, `packages/ui-server/src/ws/turns.ts:699-733`). The
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
[integration contract](../integration-contract.md#live-conversation-additive-957)
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
