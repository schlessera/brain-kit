# Live conversation qualification and interface specification

Evidence read on **2026-10-04 (Europe/Berlin)** for [#317](https://github.com/schlessera/brain-kit/issues/317).
The [selected direction](decisions/live-conversation.md) is both engines through
one conversation interface. This is an unshipped specification, with bounded
qualification of two configurations. Provider/device readiness is unproven.
The interaction proposal's timing values remain proposals.

## Evidence vocabulary

**Supported (D)** means a current primary source describes the configured
capability. **Supported (K)** means a keyless execution observed only the
named local behavior. **Unsupported (D)** means the named API/configuration
does not supply it. **Unproven (U)** means neither this investigation nor a
source establishes the required behavior. A supported vendor primitive does
not establish the complete brain-kit integration. Inference/design choices
below are explicitly host requirements, not measurements.

No API key was used, no paid or live provider session was started, and no
microphone/speaker recording was made. Installed manifests report
`@google/genai` **2.24.0**, `openai` **7.19.0**, Bun **1.3.14**. SDK versions
describe this source/probe, not an immutable provider deployment. Both selected
model identifiers are aliases; no dated immutable snapshot was verified.
Record the resolved configuration on every future session and requalify drift.

## Concrete configurations

### Gemini Live

Use the Gemini Developer API **v1beta BidiGenerateContent**, model
**`gemini-3.8-live`**, server-owned WebSocket to
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`.
The API key stays on the trusted server (the SDK supplies it in the connection
query; redact URLs in logs). The regular model supports nonblocking tools and
result scheduling; extended-thinking is not this configuration because its
scheduling support differs. Proactive audio cannot be disabled for 3.8, so
speculative output needs a local gate. Omit unsupported thinking and affective
dialog settings. [Model configuration](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live),
[capability comparison](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

The SDK-shaped setup is:

```ts
const config = {
  responseModalities: ["AUDIO"],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  systemInstruction: "Delegate agent work to the host; never infer a tool effect or permission from speech.",
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
  realtimeInputConfig: {
    automaticActivityDetection: { disabled: true },
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  },
  tools: [{ functionDeclarations: [{
    name: "host_task",
    description: "Request host-owned agent work for the current committed utterance.",
    behavior: "NON_BLOCKING",
    parameters: { type: "OBJECT", properties: {}, additionalProperties: false },
  }] }],
};
```

This single native function requests delegation, not a second brain tool
catalog. Its untrusted call maps to host-owned committed utterance/context.
Never execute model-provided task arguments as authorization. No vendor
built-in tools, image/video input or automatic callable-tool executor is used.
Input is mono signed PCM16 at 16 kHz; output is PCM at 24 kHz. Wait for
`setupComplete`; send manual `activityStart`, audio chunks and `activityEnd`.
Activity ending is evidence for a candidate endpoint, not permission to
execute a consequential tool. [Live protocol](https://ai.google.dev/api/live),
[audio capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

For an admitted native call, preserve its `id` and `name`. Send a bounded,
host-reviewed function result with **top-level** `scheduling: "SILENT"` for
quiet context or `"WHEN_IDLE"` for ordinary response, and `willContinue: false`
for final completion. Never use result scheduling as a permission-announcement
guarantee. [FunctionResponse schema](https://ai.google.dev/api/generate-content#FunctionResponse),
[nonblocking tool semantics](https://ai.google.dev/gemini-api/docs/live-api/tools).

**Source drift:** the tools guide nests scheduling in `response`, while the
API schema and installed SDK put it beside `response`. The model/capability
prose also says `INTERRUPTED`, while schema/SDK say `INTERRUPT`. The keyless
probe observes the top-level `SILENT` wire field; the nested example becomes
ordinary output data and supplies no scheduling field. Do not copy that
example or invent an enum. The SDK probe also constructs a double slash before
`ws`; server acceptance of that SDK URL is **U**, not proven by serialization.
A raw protocol adapter can use the canonical endpoint above; its live handshake
still needs verification. Neither discrepancy justifies changing the ruling.

### OpenAI GPT-Live

Use **Live API v1**, **`gpt-live-1`**, **client delegation**, server-owned primary
WebSocket `wss://api.openai.com/v1/live/sessions`, Bearer project key on the
trusted server. No Realtime endpoint/model, managed Responses delegation or
SIP transport is substituted. Send this first command, then wait for
`session.started` before audio/context commands:

```json
{
  "type": "session.start",
  "session": {
    "model": "gpt-live-1",
    "audio": {
      "format": { "type": "audio/pcm", "rate": 24000 },
      "output": { "voice": "marin" }
    },
    "delegation": { "type": "client" },
    "instructions": "Delegate agent work to the host. Never claim a tool ran or a permission was granted without host confirmation. Do not speak permission effect copy independently.",
    "input": [],
    "store": false
  }
}
```

Audio is mono PCM16 at 24 kHz, appended as base64
`session.input_audio.append`; receive `session.output_audio.delta`. Primary
WebSocket output chunks have no audio timestamp or audio-done event. Local
playback tracks sample ranges; it cannot claim provider word alignment.
[WebSocket connection and audio](https://developers.openai.com/api/docs/guides/voice-websockets).

`session.delegation.created` carries ID/target/offset metadata, not task text.
Map it to collected original transcript/audio intervals and host application
state; defer host work until semantic commit. The existing host backend runs
that work with its own context, tools and permission bridge. Return reviewed
facts via `session.thinking.append` for quiet context; ordinary speech may use
`session.commentary.append` with the original `delegation_id`. Appends are
bounded strings, not raw tool payloads. Commentary may paraphrase and therefore
does **not** supply exact permission copy. [Delegation](https://developers.openai.com/api/docs/guides/live-delegation).

Input/output transcript deltas are fragments, not complete turns; no
transcript-done signal exists in the selected event schema. Do not import
Realtime's `response.cancel`, VAD or buffer-commit semantics into GPT-Live.
Input mute acknowledgement is not output cancellation. `session.close` /
`session.closed` finalizes a whole session; application work cancellation is
separate. Model, voice and delegation mode changes require a new session.
[Live event reference](https://developers.openai.com/api/reference/typescript/resources/live),
[session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations).

## Capability comparison

| Requirement | Gemini configuration | GPT-Live configuration | Host integration consequence |
| --- | --- | --- | --- |
| Native streaming speech input/output | D; K setup/audio serialization | D; installed event/config types agree | Both qualify as integrated engines; live quality U. |
| Conversation while work is pending | D `NON_BLOCKING`; K scheduling model | D client delegation; K scheduling model | Audio loop and work loop remain separate; native call is not tool authority. |
| Correlated later result | D native ID/name and scheduling | D delegation ID/context append | Host maps vendor ID to committed utterance, host turn/request and epoch; reject stale mapping. |
| Semantic endpoint/commit | D manual activity boundary; transcription can arrive independently | No complete-turn transcript signal in selected schema (unsupported D); semantic certainty U | Host endpoint/hold/review decides submission. Do not infer confidence from `finished`, silence or fragment stability. |
| Finalization/overlap confidence | Calibrated certainty or speaker isolation U | Calibrated certainty or speaker isolation U | Unknown/overlapping input requires review; provider finalization alone does not prove intent. |
| Local barge-in | Local queue cut K; acoustic detection U | Local queue cut K; acoustic detection U | Cut audio immediately on trusted user evidence; invalidate queued chunks locally. |
| Remote cancellation | D `interrupted` and native tool-cancellation IDs; latency U | Whole-session close D; per-utterance remote cancellation acknowledgement U | Distinguish playback cut, host AbortSignal, vendor notification and observed acknowledgement; do not promise all four. |
| Exact permission wording | Prompt/audio/transcript alignment U | Commentary paraphrase unsuitable (unsupported D); exact audio U | Permission speech must use a separately verified host-controlled rendering path inside the integration, without a new TTS seam; keep unavailable until proven. |
| Echo-safe spoken refusal during playback | Acoustic proof U | Acoustic proof U | Never feed assistant/output transcripts to refusal matching; unknown acoustic origin cannot authorize a denial. |
| Generated/submitted/heard text | D separate input/output transcription; word-to-playback alignment U | D separate approximate interval fragments; word-to-playback alignment unsupported D | Persist provenance separately; interrupted output is not a verbatim heard transcript. |
| Host denial/card expiry acknowledgement | No vendor primitive establishes brain permission outcome | Same | Requires host resolution/replay data; terminal cleanup must work without `tool_result`. |
| Reconnect | D resumption/go-away primitives; integration U | D new session/history; `store:false` cannot fork stored session | New epoch, authoritative host resync, explicit mic restart, no replay of effects/announcements. |
| Latency/recognition/echo/device quality | U, n=0 | U, n=0 | Do not rank engines by fabricated performance; use the bounded measurement plan. |

The comparisons above use the cited model, protocol, tools, delegation and
session references, read on the evidence date. No API gives the host authority
to grant a permission merely because the user spoke.

## Shared interface specification

These names describe the proposed common seam as specified on the evidence
date. #957 has since exported it, with the adjustments its
[contract](integration-contract.md#live-conversation-additive-957) records
(`open` takes `{ signal, resync }`; results are `completed` or `error`).
A provider descriptor creates a server-side conversation
session with a capability profile, disclosure and normalized event stream.
The browser owns capture/playback; the host owns admission and correlation.
Registration is separate from dictation. Do not expose arbitrary vendor frames
or credentials to consumers.

```ts
type Evidence = "supported" | "unsupported" | "unproven";
type Scope = { sessionId: string; epoch: number };
type WorkRef = Scope & {
  utteranceId: string; turnId: string; requestId: string;
};
// Server-side descriptor; details are specification, not package API.
interface LiveConversationProvider {
  id: string;
  capabilities: {
    nonblockingWork: Evidence;
    manualEndpoint: Evidence;
    finalTranscript: Evidence;
    remoteOutputCancelAck: Evidence;
    exactPermissionSpeech: Evidence;
    echoIsolatedInput: Evidence;
    outputWordAlignment: Evidence;
  };
  open(scope: Scope, signal: AbortSignal): Promise<ConversationSession>;
}
interface ConversationSession {
  events: AsyncIterable<ConversationEvent>;
  appendAudio(chunk: { sequence: number; pcm: Uint8Array; rate: number }): void;
  markEndpoint(utteranceId: string): void;
  returnWork(ref: WorkRef, result: {
    outcome: "completed" | "denied" | "cancelled" | "error";
    facts: string; delivery: "quiet" | "when-idle";
  }): Promise<void>;
  close(): Promise<{ remote: "acknowledged" | "unknown" }>;
}
```

`ConversationEvent` is a closed normalized union: ready (resolved model/API,
formats and disclosure); input fragment (utterance/sequence/interval,
original text, finalization evidence, certainty known/unknown and origin
user/assistant/unknown); audio chunk (output ID, sequence and sample format);
output transcript fragment (generated provenance and optional interval);
work requested (opaque native handle, candidate utterance and request ID);
work withdrawn (handle/reason); remote output interrupted (only if observed);
closed/error. Unsupported evidence fields remain absent/unknown. The provider
handle is server-private; `WorkRef` is host-created after admission. Streams
may be concurrent, so every event also carries `Scope`; ordering is per stream,
not invented across vendor audio and transcript streams.

The host orchestrator implements operations **outside** the provider seam:
commit/review input, admit backend work, arbitrate playback, cut output,
abort the turn, acknowledge permission resolution and reconcile cards.
It can cut locally even when no remote cancellation primitive exists. All
queues are bounded; backpressure or failed correlation closes capture/work
admission and reports a visible error instead of silently dropping an input
that later becomes an effect. Concrete limits belong to implementation's
contract/configuration review, not invented provider capabilities.

### Admission, reuse and result correlation

The host binds native requests to `(sessionId, epoch, utteranceId, turnId,
requestId)`; actual tool requests additionally use their existing `toolUseId`.
Only committed original input supplies `StartTurnRequest.prompt`. The host
selects the pinned existing backend/profile, cancellation signal and
`BackendBridge`, and enforces the voice posture on new voice turns
(`export interface StartTurnRequest`, `packages/ui-sdk/src/server/backend.ts:313-408`).
Do not feed approximate fragments or native task descriptions directly into
execution. Keep raw outputs/private memory in the host and return only reviewed
bounded facts needed by the voice service.

Backend reuse is structurally feasible for **both** adapters. `startTurn` is
already asynchronous and accepts a host AbortSignal. A busy same-session turn
is queued; new committed details use `followUp` only when the backend advertises
it, otherwise remain queued/reviewable
(`export interface AgentBackend`, `packages/ui-sdk/src/server/backend.ts:452-478`).
Continued voice interaction never requires unsafe concurrent `startTurn`s.
This is source evidence and design mapping, not a real provider/backend trial.

A terminal/aborted/withdrawn request or replaced epoch cannot publish a later
result. A vendor interruption cannot reverse an already completed host effect.
Preserve host outcome even when its narration is discarded. A reconnection
creates a new epoch, resynchronizes requests/history/terminal state, and requires
explicit capture restart. Do not resend tools, input submission or grants.

### Output, permission speech and refusals

One local arbiter prioritizes user interruption, confirmed denial/error,
permission announcement, then ordinary model audio. Native proactive/speculative
speech stays gated until permitted to play. Host effect copy uses approved
patterns and a bounded tool-name fallback, never vendor prose, descriptions,
payloads or pronunciation-rewritten input. Neither configured engine currently
has proof of the required exact-copy rendering. An adapter must report that
gap and disable the permission speech path until it has verified rendering
and local playback control; ordinary commentary is not a substitute.

Announcement identity is `(selected session, host turn, toolUseId)`. Keep its
once-only ledger across reconnect and repeated frames for the conversation
lifetime. Recheck pending state before playback. Use host-approved copy only;
store an interrupted announcement as interrupted, without replaying it as a
reminder. A new request is a new identity.

Refusal matching receives original isolated user input, before pronunciation
mapping. Synthetic origin tags only prove routing; real speaker echo isolation
is U. Assistant transcripts and unknown-origin fragments cannot invoke the
matcher. An isolated ambiguous refusal denies all **current** pending requests;
an exact refusal can name one. With none pending, it is ordinary input. Bind
each denial to existing IDs, echoed turn and `channel:"voice"`; the server still
rejects voice grants
(`if (msg.channel === "voice")`, `packages/ui-server/src/ws/dispatch.ts:370-393`).
Never add a spoken approve or always-allow path.

On the evidence date the denial handler removed/resolved a matched request but
provided no dedicated denial receipt at that branch; #957 added one
(`case "tool_denial"`, `packages/ui-server/src/ws/dispatch.ts:457-480`). The
integration therefore needs host-authoritative resolution/replay: denied,
already granted, expired, or unknown/disconnected. Speak a denial confirmation
only for a confirmed denied outcome. A visual grant winning the race remains
a grant; do not undo it or falsely say it was refused. A disconnected command
is unknown, not queued against a replacement request.

Terminal state invalidates every pending exchange for that turn without waiting
for `tool_result`. Current client terminal handling finishes the assistant
message and resyncs; its message-state helper only marks streaming false
(`finishAssistantMessage`, `packages/ui-react/src/stores/chat-state.ts:1460-1465`).
This observation is a required integration check, not proof that all cards
currently clear. A host terminal event plus local audio drain/discard defines
conversation completion; provider turn/audio end does not.

Voice question binding retains the existing one-question rule
(`questionForTypedAnswer`, `packages/ui-react/src/components/chat/ask-user-typed.ts:33-35`).
Multi-question, list, rank, form and permission-card interactions keep their
visual boundaries. Under `noGrantSurface`, tools requiring those surfaces
remain withheld. Starting voice on an ordinary turn does not erase its cards.

### Provenance and disclosure

Record original recognized fragments, submitted committed text and model-generated
transcript as separate facts. Playback adds sample-range receipts with
played/discarded/unknown evidence. Do not label a generated transcript verbatim
spoken after an interruption when the API supplies no exact alignment. Store
request/host-outcome linkage, not raw microphone audio by default. Reconnect
does not promote missing provenance to known.

The service disclosure must name the selected voice provider/model, the host
relay and the separately selected backend/model/endpoint. Browser microphone
audio goes to the host and selected voice API; transcript/history and reviewed
facts go to the voice API; committed input/context goes to the configured
agent backend, which may contact its own approved tools. A Gemini voice session
using a different host backend can therefore involve two vendors. Selecting
a voice engine does not silently select or authorize the other destination.

## Availability, authentication and privacy

OpenAI's model page lists `gpt-live-1` for Live, with free-tier access unsupported;
an actual project's entitlement/concurrency remains U. Voice session billing is
separate from backend work. [Model/access reference](https://developers.openai.com/api/docs/models/gpt-live-1).
With `store:false`, no stored-session fork/recording workflow is selected.
This does not mean zero retention: the data-controls table separately lists
30-day abuse-monitoring retention and ZDR eligibility with limitations.
ZDR requires its own organization approval/configuration. Never promise regional
processing solely from a model name or connection host.
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

Gemini account/region eligibility must be checked before activation; a model
guide is not proof of project access. Paid-service data handling applies to
billing-linked API projects; unpaid handling and geographic exceptions differ.
Paid prompts/responses are not used for product improvement, but limited
safety logging still exists. No zero-retention guarantee was verified for the
chosen Developer API configuration. Do not attach private data to an unpaid
trial merely because a key exists. [Terms](https://ai.google.dev/gemini-api/terms),
[availability](https://ai.google.dev/gemini-api/docs/available-regions).

Server relays keep long-lived credentials out of the browser. Direct-browser
Gemini ephemeral tokens are a separate constrained connection configuration,
not automatically equivalent to this v1beta comparand; SDK token support warns
about v1alpha. [Ephemeral-token guide](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens).
WebRTC is an alternative OpenAI media transport, but raw automatically played
remote tracks would need an output gate. Neither alternative is required to
qualify the selected server-WebSocket boundary. Credential and raw-audio logging
remain disabled; host disclosure and provider terms must precede capture.

## Keyless receipts and reproduction boundary

A temporary Bun evaluation used a rejecting `fetch`, placeholder credential
and fake WebSocket factory. The installed Google SDK serialized the selected
setup, manual activity/audio, final function response and mixed transcription /
audio / interruption event. It observed top-level scheduling and the nested
example's failure to supply that field. No real transport was opened. Private
factory replacement is an investigation technique, not a new extension seam.

The separate asynchronous host scheduling model passed **10 scenarios**:
no work before commit; input accepted while work awaited and correlated later
result; local cut/AbortSignal and discarded late callback; reconnect epoch
rejection; once-only announcements across reconnect; synthetic echo/unknown
origin rejected; isolated ambiguous refusal covers all pending requests;
visual-grant race has no false denial receipt; terminal expiry without a tool
result and completion waiting for drain; single-question binding excluding
multiple questions/lists/forms/ranks/cards. These are **K prototype** receipts,
not tests of a shipped conversation runtime or acoustic recognition.

Reproduction uses the repository lockfile and the selected setup above. Replace
only the SDK's transport factory with an object implementing `create`, whose
connection records JSON `send` calls and emits open/`setupComplete` callbacks.
Assert nonempty function declarations with `NON_BLOCKING`, manual activity,
top-level `SILENT` / `willContinue:false` and all parts of a mixed server event.
Compare a second response with scheduling nested under `response`: no top-level
wire field may appear. The host scheduling model uses deferred promises and
real AbortControllers, not sleeps, to force cancellation/reconnect to happen
before resolution. Mutate epoch checking and local-cut behavior separately:
their corresponding assertions must fail before restoration. Both mutations
were run: removing the epoch comparison published `t1/r1:old` in the reconnect
scenario (expected no returned result); removing the local cut left playback
true in the interruption scenario (expected false). The original probe then
passed again. Implementation
units must recreate these cases against real host/runtime code; copying the
prototype's own predicates is insufficient.

## Bounded live verification plan

No measured latency is reported: **n=0** per engine, every device condition.
After separately authorized credentials/budget, evaluate the exact configurations
above with the same fictional corpus and bounded host backend. Run 30 committed
utterances per engine in each of headphone/quiet, speaker/quiet and speaker/noise
conditions (180 utterances), plus 10 trials per engine for each cancellation,
refusal/echo, visual-grant race and reconnect condition. Cap session duration,
backend spend and total cost in advance; stop on any authority/echo violation.

For each utterance timestamp: last user audio sample, endpoint evidence,
finalization evidence or review completion, host semantic commit, host backend
admission/result, first generated audio sample, first submitted playback sample
and first audible sample. Report endpoint/finalization hold, backend/integrated
generation, speech startup and end-to-end first audio separately (median/p95,
sample count, unavailable stages, device/network and chosen backend). Overlapping
integrated stages are not blindly added. Measure audible onset using a local
loopback/recording rather than a WebSocket timestamp.

For barge-in measure trusted input detection → local queue cut → audible last
sample separately from host cancellation request/settlement and any actual
provider acknowledgement. Compare #316's proposed local cut ≤150 ms, denial
send ≤250 ms and first-audio median ≤1.5 s / p95 ≤3 s. The proposed 700 ms silence,
500 ms hold and 2 s finalization timeout are design inputs, not accepted engine
settings or measured accuracy. Endpoint uncertainty may force review and must
appear in the results instead of weakening the commit gate to meet latency.

Replay assistant phrases containing the refusal trigger through real speakers;
include overlap, ambiguous/multiple requests, stale callbacks, expiry without
a tool result and already-granted races. Compare original input and exact
host-approved effect text with audible recording; test interruption mid-copy,
repeat frames and reconnect for once-only behavior. Verify no synthesized echo
becomes a user refusal, no spoken grant reaches execution, and generated versus
played evidence remains honest. Document failed/unavailable cells, not averages
that conceal safety failures. Until these gates pass, conversation permission
speech and unattended semantic submission are not runtime-certified.

## Integration and contract costs

The shared seam needs two adapters, host conversation/correlation orchestration,
client capture/output gating and host resolution/provenance replay. Gemini has
native async result scheduling and manual activity primitives; GPT-Live reuses
an application agent directly but requires host transcript/task reconstruction
and conservative endpoint evidence. Both need the same permission boundary and
real device proof. No measured effort or performance winner is claimed.

Introduce conversation registration/configuration without replacing dictation.
Specify additive schemas for discovery, session/epoch correlation, capability
evidence, lifecycle, host request resolution and transcript/playback provenance.
Negotiate support for new events; legacy clients keep their existing protocol.
No changes to current approval/denial semantics, runtime schema, SDK exports or
the ten shipped seams are made by this investigation. Actual additions require
the integration-contract process and minor changeset; any discovered break
requires a prior ruling. Implementation units live in #54, with #114 consuming
this architecture/capability input and final interaction review kept separate.
