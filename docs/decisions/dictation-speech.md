# External dictation providers

The [2026-09-28 ruling](https://github.com/schlessera/brain-kit/issues/347#issuecomment-5866348379)
keeps `SpeechProvider` and `AsrClient` as public extension interfaces and makes
both stable at the actual 1.0 transition. Their declarations and related types
remain experimental before that transition, as
[ROADMAP.md](../../ROADMAP.md) binding decision 7 requires of every extension
interface. Binding decision 2 permits a seam only where a second implementation
is plausible within a year; Deepgram and browser speech are two shipped
server/client implementations, so this seam already meets it. What it lacked
was an entry point: an external author must be able to use it without changing
the built-in registry, so the server construction path is completed here rather
than an inaccessible interface being frozen.

## Dictation and conversation have separate authority

The [conversation interaction proposal](../plans/voice-conversation.md) and
[two-engine conversation decision](live-conversation.md) preserve phase-1
dictation. Its provider mints connection material; its client captures audio
and reports partial/final text. Neither receives tool execution or permission
authority. The future common live-conversation interface carries its own
correlation, cancellation, provenance, output and capability requirements.
Those requirements do not become new meanings of `SpeechSession` or `AsrEvent`.
There is no standalone TTS interface in this decision.

The [voice-permission ruling](voice-permission.md) remains binding: voice may
refuse and may never grant. Recognized words are dictation text, including
words that sound like a grant. Connection selection cannot widen an allowlist
or bypass the host's permission and turn machinery.

## Values reach the real application

`createApp({ speechProvider })` supplies an implementation by value. It wins
over automatic Deepgram discovery. An explicit `config.voice.provider` must
match its id; a mismatch fails instead of choosing either implementation
(`createSpeechProviderRegistry`, `packages/ui-server/src/voice/speech-providers.ts:174-242`).
Without the value, existing selection remains: explicit built-ins, automatic
Deepgram only when its key is present, otherwise failure. Browser speech is an
explicit opt-in; it never becomes a fallback after a missing key or provider
failure.

Legacy configuration errors stay inside the mounted session route's existing
error boundary: an invalid by-value `speechProvider`, a `VOICE_PROVIDER` that
mismatches it, or a `VOICE_PROVIDER` naming an unregistered provider still lets
the server start and answers the voice routes with the existing 500 `{ error }`.
Only misuse of the additive #3707 options (`speechProviders` together with
`speechProvider`, an invalid or duplicate list entry, an unregistered
`defaultSpeechProviderId`) fails construction. A provider id is nonempty, trimmed and
lowercase, matching environment resolution. All four capabilities are boolean;
`createSession` is callable. Sessions carry a string URL, finite nonnegative
expiry and optional string token/string-record params. Empty URL and zero
expiry remain valid for browser/local implementations. Invalid session results
and legacy minting failures retain the existing 500 `{ error }` envelope.
Authentication and the deprecated Deepgram-specific token route keep their
existing meanings.

Keyterms are built only for a provider declaring support. The route snapshots
identity/capabilities before minting; the matching client receives the minted
session through its root's public `asr.register` factory. A unique external id
avoids the UI's built-in registrations. A server value using a built-in id
must speak that built-in client's protocol. An unknown client id fails clearly;
the client does not silently select another recognizer.

## Runnable conformance accompanies the seam

The [authoring guide](../extending/speech.md) lists public imports and complete
server/client examples. `@schlessera/brain-ui-sdk/testing` publishes
`runSpeechProviderContract` and `runAsrClientContract`, using injected test
primitives and keyless transport probes. The provider probe observes supported
nonempty keyterms, session/capability shapes and real session failure. The
client probe observes actual capture and connection state, transcript/error callbacks, hard
stop and a held graceful final before drain resolution. Probe drivers must
exercise the implementation's transport rather than inventing method results.

The same client assertions run against both built-in adapters and an external
browser adapter. The external pair also goes through public application/root
construction, the mounted HTTP route, real Chrome microphone tracks,
MediaRecorder and a local WebSocket. This proves integration and resource
lifecycle; it does not measure live vendor accuracy, latency or device acoustics.
The signature inventory includes the client factory/registry and their reachable
options, events, session and capability types. Broader package export curation
remains the separate [Q1 inventory](https://github.com/schlessera/brain-kit/issues/534).

## Alternatives

- Keeping an experimental exception indefinitely contradicts the selected
  1.0 ruling and leaves external authors without a usable server entry point.
- Adding third-party names to a runtime loader or built-in registry requires
  discovery and packaging machinery for an ordinary passed-in object.
- Overriding an explicit provider with a supplied value hides configuration
  mistakes and can send audio to an unintended destination. Requiring a match
  keeps selection deliberate.
- Silently choosing browser speech after failure changes audio egress. The
  existing opt-in boundary must survive external integration.
- Folding conversation/TTS or speech-side permissions into dictation would
  freeze requirements under the wrong interface and duplicate host authority.

This additive entry point and published suites require a minor changeset and
same-commit integration-contract update. They do not schedule or release 1.0,
remove experimental annotations, or approve paid/live provider experiments.


## 2026-10-08 — Local capture and explicit saved-audio transcription (#1023)

The [September 30 transcription ruling](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5906998794)
chooses device-local capture with deferred transcription. The
[October 4 reconciliation](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5980965363)
and [October 5 approval](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5998617047)
keep capture independent of a server voice session, require explicit upload
consent, and reject an assumed saved-file capability. This preserves dictation's
text-only authority: recording, transcription and Add to draft grant no tool
permission and send no chat message.

Local capture opens the microphone only on an explicit start and sends encoded
chunks to the durable sink without a network call
(`startLocalCapture`, `packages/ui-react/src/voice/local-capture.ts:95-117`;
`const deliver`, `packages/ui-react/src/voice/local-capture.ts:149-166`).
Online streaming dictation remains its separate path; a connection transition
never converts a running take between the two. Provider-ended streaming words
reach review exactly once through the existing dictation ending path, as
[#1189's runtime finding](https://github.com/schlessera/brain-kit/pull/1220)
proves. This does not make streaming audio a retained local recording.

The [V2 finding, read against upstream sources on October 7](https://github.com/schlessera/brain-kit/issues/1011#issuecomment-6037492923)
selects the server-side prerecorded path for Deepgram. Its
[local-file API](https://developers.deepgram.com/docs/pre-recorded-audio)
accepts a raw body with a server-held credential. Web Speech offers no saved-file
path through the brain server under these rulings: recognition of playback via
a live track remains a browser path, and on-device recognition is outside the
baseline. Thus Deepgram is the only built-in saved-audio implementation;
external providers may omit the optional method on the existing seam
(`transcribeRecording?`, `packages/ui-sdk/src/server/speech.ts:40-45`).
The server derives the advertised capability from that method, rather than
trusting a flag disconnected from its executor
(`speechCapabilities`, `packages/ui-server/src/voice/speech-providers.ts:153-155`).
An absent capability keeps playback, typing and retention available, with the
tray's explicit unavailable explanation.

Streaming replay was rejected because it changes the upload destination to a
browser-held provider connection and adds realtime pacing and reconnection
semantics to a saved-file operation. The V2 finding establishes this from
upstream documentation, not a paid comparison. Neither V2 nor
[#1021's keyless implementation proof](https://github.com/schlessera/brain-kit/pull/1256)
measures vendor accuracy, latency, cost, real Safari-container acceptance or
project-specific capacity. Container support in documentation and a scripted
provider test are not live-provider measurements.

The user first sees the provider/destination confirmation; only **Upload and
transcribe** sends the bytes browser → brain server → selected provider.
Reconnection, reload and sign-in do not upload or retry audio. Status recovery
uses read-only queries; an explicit earlier accept/discard may also flush its
queued receipt deletion. Missing status after a lost reply is not proof that
nothing was sent (`async syncTranscriptions`,
`packages/ui-react/src/lib/recordings.ts:806-854`). The transcript commits locally
before review. Add to draft commits a hash-bound draft receipt before deleting
the audio; acceptance stays device-local and resumes ordinary host draft
workflow only after a subsequent user edit or explicit Send
([tray proof](https://github.com/schlessera/brain-kit/pull/1241)).

Permanent operational receipts bind a host-wide recording UUID to its verified
hash and owning account, independent of changing login principals. Only the
transaction winning a claim dispatches; a concurrent/plain repeat reuses the
result or reports the existing state. Accept/discard erases receipt text but
leaves a tombstone; startup converts an unfinished dispatch to terminal
`outcome_unknown` (`createTranscriptionStore`,
`packages/ui-server/src/voice/transcription-store.ts:30-111`). A receipt TTL was
rejected because expiry could make an old upload call the provider again. The
guarantee depends on retaining the host's operational database, not `brain.db`.

The [October 8 retry ruling](https://github.com/schlessera/brain-kit/issues/1021#issuecomment-6055129108)
permits at most three explicit retries per recording/hash after a definitive
transient/capacity rejection: provider errors, rate limits and definitive
provider timeouts. Unknown outcomes stay terminal. Audio/media, parameter,
validation and authentication failures do not offer Retry. Classification and
attempt counts belong to the receipt, not an automatic client retry loop
(`transcriptionFailure`, `packages/ui-server/src/routes/transcriptions.ts:22-37`).
This qualified rule supersedes an unqualified promise of one call even after
an explicit retry. Plain repeats and uncertain outcomes never redispatch.

The upload budget is **10,041,155 bytes**, a derived policy value rather than a
duration check (`MAX_TRANSCRIPTION_BYTES`,
`packages/ui-server/src/routes/transcriptions.ts:15-19`). The
[October 8 bitrate finding](https://github.com/schlessera/brain-kit/issues/1021#issuecomment-6055498109)
reran the V1 probe's track-ended case three times per desktop engine, with
Chromium 153.0.8010.12 and Firefox 155.0 in Playwright 1.63.0's Ubuntu 24.04.4
image and a requested 1000 ms timeslice. The highest observed rate was Firefox's
52,783 bytes / 3,154 decoded ms; `ceil(52783 / 3.154 * 600)` gives the budget.
This supplies no Android or physical-device measurement. The separate local
capture limit remains ten minutes. The additive surface and exact receipt/error
semantics are already recorded in the
[integration contract](../integration-contract/package-api.md#saved-audio-transcription-additive-1021)
and [HTTP reference](../http-api.md#saved-audio-transcription).

## Failed capture explanations — 2026-10-08

The [seven maintainer rulings for #1222](https://github.com/schlessera/brain-kit/issues/1222#issuecomment-6057782982)
select one amber boxed Callout in the composer's capture-notice slot, between
review and the message field. Provider-ended failures and startup failures use
fixed, lifecycle-specific explanations; an open-sheet error never claims the
capture stopped. Reliable codes/categories select connection, microphone or
no-speech explanations; unknown messages use generic copy. Raw provider text
is never rendered, and a connection problem does not prove a dropped connection
or a microphone problem a browser-settings cause.

Retention refers only to the failed capture: “Your words are kept for review.”
or “Nothing was captured.” Empty no-speech endings omit the redundant detail.
Failed startup preserves earlier review words without attributing them to that
attempt. Capture-scoped terminal state is separate from the ambient sheet error;
Done after a non-ending error does not produce a failure notice. Cancelled or
superseded starts and late provider events are quiet. The existing single end
path transfers words to review once, preserving update-reload holds.

The notice has one polite status region, a mic icon and a quiet Dismiss control
with a 44px target. Appearance takes no focus and has no entrance transition.
Dismiss returns focus to the microphone, or field if unavailable, when its
control held focus; a pointer dismissal preserves unrelated focus. Review
controls precede Dismiss and keep their actions. Distinct local-capture notices
stack afterward and dismiss independently; identical text is not rendered or
announced twice. Dismiss, a new dictation/local capture or review Send/Edit/Discard
clears the failure notice. Typing and session changes keep it; no timer applies.
Nothing restarts the microphone, retries, sends or uploads automatically.
Neutral clean-end explanations remain the separate [#1258](https://github.com/schlessera/brain-kit/issues/1258).

## 2026-11-08 — Selectable dictation providers and Gemini Transcribe Live (#3706)

[#3705](https://github.com/schlessera/brain-kit/issues/3705) asks for several
configured dictation providers, chosen independently of the live-conversation
service and the chat model, with Google's dedicated streaming
`gemini-3.5-transcribe-live` model and its SMART mode among them. The
[selectable-dictation plan](../plans/selectable-dictation.md) holds the schemas,
states and proof split. This section records what binds.

The maintainer ruled on 2026-11-08 in
[#3706](https://github.com/schlessera/brain-kit/issues/3706):

- **D1.** SMART transcription is on by default. A brain-wide **Clean up as I
  speak** switch turns it off. The switch is shown only when the effective
  provider declares the capability, and a change applies from the next take.
- **D2.** The dictation provider is switched in the Settings **Voice** pane
  only. The capture sheet names the destination but offers no per-take Change.
- **D3.** A configured `GEMINI_API_KEY` registers Gemini as a selectable
  dictation provider. A key never makes a provider the default. Gemini is used
  without a saved choice only when it is the only one registered.
- **D4.** The first take to a provider this device has not acknowledged shows
  the destination with an explicit **Start dictation**, before any session
  request or microphone access. Later takes start immediately.

These rulings bind together with what follows from the existing decisions:

- **Selection stays deliberate.** The registered set is fixed when the server
  is constructed. A legacy by-value `speechProvider` still replaces every
  built-in. A new `speechProviders` list adds to them, and a duplicate id is
  a construction error. Browser speech stays opt-in through
  `VOICE_PROVIDER=webspeech`.
- **Precedence.** The saved brain-wide default wins, then the host default
  (`defaultSpeechProviderId`, `VOICE_PROVIDER`, or Deepgram when its key is
  present), then the only registered provider. When a saved default is
  unavailable, dictation is blocked until the user explicitly picks another
  provider, as #3616 L2 requires for conversation. It never falls back.
- **Freezing.** A take sends the provider id it disclosed. The server mints for
  exactly that id or refuses. Nothing changes the provider of a running take.
  A saved-audio upload names the provider its confirmation disclosed, and a
  retry must name the same provider its receipt recorded. A default change
  therefore cannot redirect a capture, an upload or a receipt.
- **Credentials.** The Gemini key stays on the server. The browser receives
  only a single-use constrained ephemeral token, locked to the model, the TEXT
  modality and the transcription configuration. Discovery and Settings never
  mint a token or open the microphone.
- **Saved recordings.** Gemini declares no saved-audio capability, and live
  replay stays rejected. When another registered provider can transcribe saved
  audio, the tray offers it as an explicit choice for that recording.
- **Authority.** SMART text, including its corrections, applies to the current
  unsent draft only. It carries no command authority. It never rewrites
  earlier text, sent messages or provider-facing history.

The plan separates Google's documented claims from what still needs the
authorized real-provider qualification in
[#3710](https://github.com/schlessera/brain-kit/issues/3710). One divergence is
already known. The token guide says `v1beta`, while the installed SDK uses the
v1alpha `BidiGenerateContentConstrained` endpoint for ephemeral tokens. The
server mints the URL, so qualification can correct it without a client change.

All the surfaces involved are additive. Each lands as a `CONTRACT:` change with
its authoritative documentation and a minor changeset. Recording this decision
neither releases anything nor authorizes paid calls.
