# External dictation speech

Implement a `SpeechProvider` on the server and an `AsrClientFactory` in the
browser. Both share one provider id. Their current dictation meanings remain
experimental until the actual 1.0 transition; the selected stability boundary
and alternatives are in [the decision](../decisions/dictation-speech.md).
Live conversation has [its own future interface](../decisions/live-conversation.md).

## Supply the server value

These imports are published package entry points. The example service address
is fictional: supply the URL of the service implementing your audio protocol,
and mint short-lived credentials there when needed. The server provider owns
credentials; it must never return a long-lived provider key to the browser.

```ts
import { createApp, resolveServerConfig } from "@schlessera/brain-ui-server";
import { defineSpeechProvider, type SpeechProvider, type SpeechSession }
  from "@schlessera/brain-ui-sdk/server";

const speechProvider: SpeechProvider = defineSpeechProvider({
  id: "example-speech",
  capabilities: {
    streaming: true, interimResults: true, keyterms: false, endpointing: false,
  },
  async createSession({ keyterms }): Promise<SpeechSession> {
    // This example service needs no credential or domain keyterms.
    return { url: "wss://speech.example.test/dictation", expiresAt: 0 };
  },
});
const config = resolveServerConfig(process.env);
const app = await createApp({
  config: { ...config, voice: { ...config.voice, provider: speechProvider.id } },
  speechProvider,
});
// The host uses app.fetch/app.websocket and awaits app.close() at shutdown.
```

A supplied value takes precedence over automatic Deepgram key detection. If
`config.voice.provider` is set (including by `VOICE_PROVIDER`), it must equal
the supplied id. Ids are nonempty, trimmed and lowercase. Without a value,
`deepgram`/`webspeech` keep their existing selection rules; absent credentials
never select browser speech. A mismatch or provider failure returns 500
`{ error }` from the existing protected `POST /api/voice/session`, without
trying another service. Validation occurs on that request, before calling an
invalid provider or publishing an invalid session.

The four streaming capabilities are boolean. Optional `savedAudio` is derived from a callable `transcribeRecording`; a contradictory explicit declaration is rejected. `streaming` describes streaming recognition,
`interimResults` controls partial display, `keyterms` controls domain-term
building, and `endpointing` distinguishes automatic utterance-end evidence from
manual Done. Capabilities do not confer permissions or confidence/provenance
that the event format does not carry. `createSession` receives domain terms when keyterms is supported (possibly
`[]` when no terms are available), otherwise `[]`.

`SpeechSession` carries a string URL, finite nonnegative epoch-millisecond
`expiresAt`, optional string `token`, and optional `Record<string, string>`
`params`. Empty URL and zero expiry support browser/local sessions. Parameters
and credentials are protocol-specific and must be consumed by the matching
client. The route adds the provider id and a snapshot of its four capabilities
to form `VoiceSessionResponse`. The deprecated `/api/voice/token` stays
Deepgram-specific even when an external provider is supplied.

## Register the browser factory

The following complete example client implements a simple audio-socket
protocol: binary audio chunks, partial/final ASR JSON events, a `{type:"finish"}`
flush request and a `{type:"drained"}` acknowledgement after the final result.
It is an authoring example, not a bundled vendor implementation. A production
adapter must also handle its protocol's reconnect, expiry, browser support and
transport failures. It uses only public SDK types and native browser APIs.

```ts
import type { AsrClient, AsrClientOptions, AsrEvent } from "@schlessera/brain-ui-sdk/client";

/** Keyless example adapter: browser audio goes to the fixture's local socket. */
export class ExternalSpeechClient implements AsrClient {
  stream: MediaStream | null = null;
  private socket: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private closed = false;
  private finish: (() => void) | null = null;
  constructor(readonly options: AsrClientOptions) {}

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.closed) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const socket = new WebSocket(this.options.session.url);
    this.socket = socket;
    socket.onmessage = ({ data }) => {
      if (this.closed) return;
      const message = JSON.parse(String(data)) as AsrEvent | { type: "drained" };
      if (message.type === "drained") this.finish?.();
      else this.options.onEvent(message);
    };
    socket.onerror = () => this.options.onError(new Error("Fixture speech socket failure"));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = () => reject(new Error("Fixture speech socket closed during start"));
    });
    if (this.closed) return;
    const recorder = new MediaRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = ({ data }) => {
      if (!this.closed && data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(data);
    };
    recorder.start(50);
  }

  stop(): void {
    this.closed = true;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
      this.recorder = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.socket?.close();
    this.socket = null;
    this.finish?.();
    this.finish = null;
  }

  async drainAndStop(): Promise<void> {
    const recorder = this.recorder, socket = this.socket;
    if (!recorder || !socket || socket.readyState !== WebSocket.OPEN) { this.stop(); return; }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture speech drain timed out")), 2000);
        this.finish = () => { clearTimeout(timer); resolve(); };
        // MediaRecorder queues its final data event before the stop event.
        recorder.onstop = () => socket.send(JSON.stringify({ type: "finish" }));
        recorder.stop();
      });
    } finally { this.stop(); }
  }
}
```

Register it on the UI root **before mounting the UI**:

```ts
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, createBrainUiRoot }
  from "@schlessera/brain-ui-react";
import type { AsrClientFactory } from "@schlessera/brain-ui-sdk/client";
// ExternalSpeechClient is the complete class above, in this module.

const root = createBrainUiRoot({ storage: null });
const factory: AsrClientFactory = (options) => new ExternalSpeechClient(options);
root.asr.register("example-speech", factory);
createRoot(document.getElementById("app")!).render(
  createElement(BrainUiProvider, { root, children: createElement(ChatPage) }),
);
window.addEventListener("pagehide", () => root.dispose(), { once: true });
```

`root.asr` is an `AsrClientRegistry`; registration is per root. A missing
provider id throws a named error instead of choosing another factory. Use an
external id distinct from `deepgram` and `webspeech`, whose built-in factories
the UI installs. If a server value uses one of those ids, it must speak that
built-in client's protocol. A standalone SDK consumer can use
`createAsrClientRegistry()` or the legacy `registerAsrClient`/`createAsrClient`
default registry; registering globally does not configure an isolated UI root.

`start()` opens capture. `stop()` closes capture immediately and discards its
buffer; `drainAndStop()` flushes final text and resolves after closing. The UI
owns review, cancellation/unmount and stale-start handling. Partial events are
`{type:"partial",text}`; finals are `{type:"final",text,endsTurn}`. Report
recognition failures through `onError(Error)`. Speech remains text input: a
final containing a grant-like phrase does not grant a tool approval.

## Run published conformance

```ts
import { describe, test, expect } from "bun:test";
import { runSpeechProviderContract, runAsrClientContract,
  type SpeechProviderContractHarness, type AsrClientContractHarness }
  from "@schlessera/brain-ui-sdk/testing";

// These probes construct your actual implementations with keyless fakes.
// They are test fixtures supplied by the adapter author, not production APIs.
declare const providerHarness: SpeechProviderContractHarness;
declare const clientHarness: AsrClientContractHarness;
runSpeechProviderContract(providerHarness, { describe, test, expect });
runAsrClientContract(clientHarness, { describe, test, expect });
```

The functions accept the existing `ContractTestPrimitives` runner interface;
they do not import Bun's test runner or require an API key. Each case gets a
fresh probe and disposes it in `finally`. The provider's `create`/`failing`
probes use the same implementation with successful/failing session transports.
Set `failing: null` explicitly only for a provider with no fallible session
transport, such as the built-in browser session; that failure case is not
registered, rather than reported as a passing transport test.
`keyterms()` observes what its transport received when support is declared.
The client probe observes microphone tracks or recognizer state through
`captureActive()` and socket/recognizer connection state through
`connectionActive()`, and drives
real transcript/error callbacks. `finishDrain(final)` delivers a held buffered
final and completion only after the adapter requested a flush; it must not
fabricate an event when that request is missing. The suite requires the drain
promise to remain pending until that final is delivered.

The in-tree [external probe](../../packages/ui-react/tests/external-speech-conformance.test.ts)
and [built-in probes](../../packages/ui-react/tests/speech-builtins-conformance.test.ts)
are complete harness examples. The [server proof](../../packages/ui-server/tests/external-speech.test.ts)
constructs the real app and consumes the response through the public client
registry. The [Chrome proof](../../packages/ui-react/tests/external-speech-runtime.test.ts)
uses the example client, real capture/recording and an offline local socket.
Run with `bun run test` and Chrome available; CI requires Chrome rather than
claiming a skipped runtime test as proof. These checks establish lifecycle and
integration, not live speech quality or readiness of a conversation engine.

## Optional saved recordings

A server provider may add `transcribeRecording` on this existing seam. Omit it
when the service cannot transcribe saved audio. Its input is the unmodified
`Uint8Array`, original container media type, supported domain keyterms and
abort signal; return `{ text }` with nonempty text. Use only the server-held
credential and the provider's server-side endpoint. Never retry automatically.
Throw `SpeechTranscriptionError` with a definitive reason/status, or let an
ambiguous error become terminal unknown. [The contract](../integration-contract/package-api.md#saved-audio-transcription-additive-1021)
defines classification, retry limits and the durable receipt boundary.
The public conformance probe's optional `recording()` observes actual forwarded
bytes, content type, keyterms and returned text; it is required when this method
is implemented. The [saved-audio tests](../../packages/ui-server/tests/saved-transcription.test.ts)
exercise a fake provider through the real mounted routes without service keys.

## Live conversation with Gemini

Conversation is separate from dictation. Register the fixed Gemini adapter
explicitly; the server receives the API key as a value, without adding a new
environment variable or sending a credential to client discovery:

```ts
import { createApp, createGeminiConversationProvider } from "@schlessera/brain-ui-server";

const app = await createApp({
  // Supply the remaining host options as usual.
  conversationProvider: createGeminiConversationProvider(serverOwnedApiKey),
});
```

`serverOwnedApiKey` comes from the host's protected credential source. The
adapter publishes model/API/audio formats and destination disclosure. Host
work stays on the normal backend bridge, so chat progress and interactive
cards continue while the native async request awaits its result. Audio input
can continue during that work; a previous input needs its transcription finish
marker before a new utterance can be attributed safely. Missing finalization
ends the epoch rather than guessing from model completion.

Registration alone never opens capture or certifies live provider/device
behavior. Exact permission audio, acoustic echo isolation and word alignment
remain unproven until separate qualification. See the
[conversation contract](../integration-contract/wire.md#live-conversation-additive-957)
and [qualification plan](../investigations/live-conversation-investigation.md#bounded-live-verification-plan).

## Live conversation with GPT-Live

`createGptLiveConversationProvider(serverOwnedApiKey)` from
`@schlessera/brain-ui-server` supplies the separately registered
`CreateAppOptions.conversationProvider`. The server retains the credential;
the adapter fixes `gpt-live-1`, Live v1 primary WebSocket, PCM16/24 kHz, marin,
client delegation and `store:false`. The host's independently selected backend
continues streaming chat progress, tool activity and interactive cards while
voice input/output and asynchronous delegated work remain active.

All recognized text needs manual review: this API has transcript deltas and
no complete-turn signal. Correlated fragments use echoed client command IDs;
after multiple captured utterances, missing correlation visibly ends capture
rather than borrowing the latest utterance's identity. These are conservative
capability limits to qualify on real providers/devices under #961.

Commentary is ordinary narration, never exact permission copy. Local playback
cut does not claim remote output cancellation, and `store:false` does not
promise zero retention. The
[conversation contract](../integration-contract/wire.md#live-conversation-additive-957)
describes the guarded correlation, bounded result appends and close receipts.

## Live conversation in Chat

The shipped conversation client uses the separately registered
`LiveConversationProvider`; it leaves dictation unchanged. Open **Live
conversation** from the composer's capture menu, review the destinations and
capability limits, then select **Start**. With either built-in service, use
**Send now** to commit recognized text. The ordinary transcript, tools and
question/permission controls remain available while host work runs asynchronously.

Mute ends microphone capture. Stop reply flushes local audio and pauses the
speech epoch; its remote outcome stays separate. Resume first resynchronizes
host work and keeps capture off until explicitly restarted. Leave returns to
the composer with retained review text in its original draft. Background views
do not play speech. Missing alignment reads as spoken portion unknown.

This client requires the host's `conversationPause` capability in addition to
`liveConversation`. The additive lifecycle fields, opening correlation and
agent-profile routing are described in the
[wire contract](../integration-contract/wire.md#live-conversation-additive-957).
Registering a service is explicit; it does not certify the separate live-device
qualification or enable exact permission speech without evidence.
