# External dictation providers

The [2026-09-28 ruling](https://github.com/schlessera/brain-kit/issues/347#issuecomment-5866348379)
keeps `SpeechProvider` and `AsrClient` as public extension interfaces and makes
both stable at the actual 1.0 transition. Their declarations and related types
remain experimental before that transition. Two server/client implementations
already justify this seam; an external author must be able to use it without
changing the built-in registry.

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
(`pickSpeechProvider`, `packages/ui-server/src/voice/speech-providers.ts:96-130`).
Without the value, existing selection remains: explicit built-ins, automatic
Deepgram only when its key is present, otherwise failure. Browser speech is an
explicit opt-in; it never becomes a fallback after a missing key or provider
failure.

Provider validation and session validation happen inside the mounted session
route's existing error boundary. A provider id is nonempty, trimmed and
lowercase, matching environment resolution. All four capabilities are boolean;
`createSession` is callable. Sessions carry a string URL, finite nonnegative
expiry and optional string token/string-record params. Empty URL and zero
expiry remain valid for browser/local implementations. Unknown configuration,
mismatch, invalid implementations/results and minting failures return the
existing 500 `{ error }` envelope. Authentication and the deprecated
Deepgram-specific token route keep their existing meanings.

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
