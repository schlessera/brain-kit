# Selectable dictation providers and Gemini 3.5 Transcribe Live

Design for [#3705](https://github.com/schlessera/brain-kit/issues/3705), produced
by [#3706](https://github.com/schlessera/brain-kit/issues/3706). Nothing here is
built yet. The rulings it depends on are recorded durably in
[the dictation decision](../decisions/dictation-speech.md#2026-11-08--selectable-dictation-providers-and-gemini-transcribe-live-3706);
this file holds the shapes, states and proof split the implementation issues
consume. Source was read at main `a63e564f02f9b1ab0462bb0ac02dbf8ea6eacee7`.

Dictation stays what [the dictation decision](../decisions/dictation-speech.md)
says it is: a provider mints connection material, a browser client captures
audio and reports partial/final text, and the words become an unsent draft.
Nothing below gives recognized text tool, permission or send authority, and
nothing touches provider-facing conversation history
([provider history](../decisions/provider-history.md)). Dictation selection is
independent of the live-conversation service ([#3616](https://github.com/schlessera/brain-kit/issues/3616))
and of the ordinary chat/task model.

## 1. What exists

- One server provider per host. `pickSpeechProvider` returns the supplied
  by-value provider, an explicit `VOICE_PROVIDER` built-in, Deepgram when its
  key is present, or throws
  (`pickSpeechProvider` in `speech-providers.ts` at `a63e564`; #3707 replaced it with `createSpeechProviderRegistry`).
- Every route calls it again per request. The session route mints for whatever
  it returns
  (`POST /voice/session` in `routes/voice.ts` at `a63e564`),
  and so does the saved-audio upload, before claiming a receipt
  (the upload `PUT` in `routes/transcriptions.ts` at `a63e564`).
- The browser already keys clients by provider id
  (`createAsrClientRegistry`, `packages/ui-sdk/src/client/asr.ts:41-60`;
  `registerAsrClients`, `packages/ui-react/src/voice/asr-clients.ts:16-41`).
- The recordings tray discloses the provider it read from `GET /voice/capabilities`
  (`useEffect`, `packages/ui-react/src/components/voice/recordings-tray.tsx:124-134`),
  but the upload names no provider
  (`const response`, `packages/ui-react/src/lib/recordings.ts:775-777`). A host
  that changed provider between the two would transcribe with a service the
  user was not shown. A retry is checked against the attempt id, not against
  the provider that made the attempt
  (`claim(`, `packages/ui-server/src/voice/transcription-store.ts:63-75`).
  Selection makes both gaps reachable, so this design closes them.
- A PCM AudioWorklet capture already exists for live conversation
  (`openConversationMicrophone`, `packages/ui-react/src/voice/conversation-pcm.ts:4-60`).
  Deepgram's dictation client sends MediaRecorder Opus, which Gemini does not
  accept.
- Settings has no Voice pane yet
  (`SECTIONS`, `packages/ui-react/src/components/settings/settings-panel.tsx:27-36`).
  #3616 names it **Voice** (ruling L3) and owns its live-service group.

## 2. Upstream facts and what still needs qualification

Read on 2026-11-08 from Google's
[Live Transcribe guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe),
[model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe) and
[ephemeral-token guide](https://ai.google.dev/gemini-api/docs/ephemeral-tokens)
(all three now redirect to `aistudio.google.com/docs/…`), and from the
installed `@google/genai` 2.24.0 (`dist/genai.d.ts`, `dist/node/index.mjs`).
brain-kit's UI packages do not depend on that SDK, and this design adds no
dependency: both sides speak the documented wire protocol, as
`gemini-conversation.ts` already does.

**Documentation facts** (these are what Google says, not what we have measured):

| Fact | Source |
| --- | --- |
| Streaming model `gemini-3.5-transcribe-live`; setup names `models/gemini-3.5-transcribe-live`, `generationConfig.responseModalities: ["TEXT"]`, `inputAudioTranscription: {…}` | Live guide |
| `inputAudioTranscription.mode`: `VERBATIM` (default) or `SMART`. SMART removes fillers and false starts, resolves inline self-corrections, formats lists, numbers and dates, and does light grammar cleanup. It is incompatible with word timestamps and diarization | Live guide; SDK `AudioTranscriptionConfig` |
| `languageCodes`: BCP-47 hints; empty or omitted means automatic detection, including code-switching | Live guide; SDK |
| `customVocabulary`: up to 1,000 terms, best results up to about 100 | Live guide; model page |
| Input is raw PCM16 LE mono 16 kHz, `audio/pcm;rate=16000`, about 100 ms per chunk, sent as `{"realtimeInput":{"audio":{"data":"<base64>","mimeType":"audio/pcm;rate=16000"}}}` | Live guide |
| Interim text arrives as `serverContent.interimInputTranscription.text` and may change. Final text arrives as `serverContent.inputTranscription.text` on a pause, turn completion or finalization; in SMART mode the final text is the cleaned text. `Transcription.finished` exists in the SDK type | Live guide; SDK `LiveServerContent`, `Transcription` |
| `{"realtimeInput":{"audioStreamEnd":true}}` finalizes the turn immediately; the server's VAD is the fallback | Live guide |
| A live session lasts at most 10 minutes. There is no diarization or word timestamps | Live guide; model page |
| Ephemeral tokens: `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` with `x-goog-api-key`; `uses` defaults to 1 (resumption does not count as a use); `expireTime` defaults to 30 minutes and is under 20 hours; `newSessionExpireTime` defaults to 60 s. The SDK's `liveConnectConstraints` and `lockAdditionalFields` options serialize to the REST fields `bidiGenerateContentSetup` (the locked Live setup) and `fieldMask` (the locked field paths; an empty `lockAdditionalFields` masks exactly the setup fields present) | Token guide; SDK `CreateAuthTokenConfig`; @google/genai 2.24.0 `createAuthTokenConfigToMldev`, `convertBidiSetupToTokenSetup` |
| A browser presents the token as an `access_token` query parameter (or `Authorization: Token …`); tokens work only with the Live API | Token guide |
| `gemini-3.5-transcribe` (unary, saved files) is a separate model and endpoint | Model page |

**Endpoint version (resolved by #3710).** The token guide says ephemeral
tokens work with `v1beta`. The installed SDK connects an `auth_tokens/…`
credential to
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=…`
and warns that its ephemeral support is v1alpha-only. Measured on 2026-11-09,
Google accepts the constrained token on both the v1alpha and the v1beta
constrained endpoints, with identical output. The implementation keeps the
SDK's v1alpha URL. The server mints the full URL, so a later change is
server-only.

**Measured by #3710's scripted check of the protocol (2026-11-09,
synthetic TTS audio, no device):**

- Google accepts the constrained token and setup for this model.
- `uses: 1` is enforced: a second connect closes with 1011 "Token has been used
  too many times".
- The locked mode overrides a client `setup` that asks for another one.
- Interim text is cumulative within a segment and stays verbatim in SMART;
  only the final is cleaned.
- A final arrives on a pause, as `inputTranscription`, then
  `generationComplete: true`, then `speechState: NON_SPEECH`.
- After `audioStreamEnd`, Google sends the pending final and `generationComplete`
  (+253 ms measured). When nothing is pending it sends nothing at all.
  `finished` and `turnComplete` never came, so Done waits for
  `generationComplete` (#3768).
- A pause ends a segment, so SMART formats a spoken list only within one
  segment.
- With automatic language detection, a short English segment was once
  returned as Spanish. The `en-US` hint fixed it in the one session tried
  (#3769).

**Still unproven until #3710 Phase B runs:** latency and behavior with a real
microphone, a real browser and a physical device. No keyless test proves any
of these, and none of the measurements above is an accuracy claim. Nothing here claims parity with Pixel Recorder or Rambler features, or
that saved files work because streaming does.

## 3. Rulings this design uses

The maintainer ruled on 2026-11-08 (recorded in the
[decision](../decisions/dictation-speech.md#2026-11-08--selectable-dictation-providers-and-gemini-transcribe-live-3706)):

- **D1, SMART default with a toggle.** A brain-wide **Clean up as I speak**
  switch is on by default. It appears only when the effective provider declares
  SMART support, and it applies from the next take.
- **D2, switching happens in Settings only.** The Voice pane holds the
  brain-wide dictation default. The capture sheet names the destination but has
  no per-take Change, so one-tap dictation stays one tap.
- **D3, registration follows the key.** Gemini becomes a selectable choice
  whenever `GEMINI_API_KEY` is set. It never becomes the default on that basis
  alone. It is used without a saved choice only when it is the only registered
  provider.
- **D4, one-time acknowledgement per provider.** The first take to a provider
  this device has not acknowledged shows the destination and an explicit
  **Start dictation**. Later takes start immediately. The mic control always
  names the service.

The analogous live-conversation rulings carry over where they apply: the
default is brain-wide and stored server-side, it takes effect at the next
explicit start, it never retargets a running capture, and an unavailable saved
default requires an explicit choice instead of falling back (#3616 L2).

## 4. Registration, discovery and precedence

### Registration

The **registered set** is fixed when the server is constructed:

| Source | Registered when | Id |
| --- | --- | --- |
| Deepgram built-in | `DEEPGRAM_API_KEY` is set | `deepgram` |
| Gemini built-in | `GEMINI_API_KEY` is set (D3) | `gemini` |
| Browser speech built-in | `VOICE_PROVIDER=webspeech` only (unchanged opt-in) | `webspeech` |
| `createApp({ speechProviders })` (new) | Always, in addition to the built-ins | its `id` |
| `createApp({ speechProvider })` (legacy) | Always; **replaces** every built-in, exactly as today | its `id` |

- `speechProvider` and `speechProviders` together are a construction error.
  Legacy by-value hosts therefore keep a single-provider registry, and their
  behaviour does not change.
- Ids are validated by the existing `assertSpeechProvider`. A duplicate id,
  including a supplied provider reusing a built-in id that the environment also
  registered, is a construction error naming that id. Nothing is shadowed
  silently.
- `GEMINI_API_KEY` stays a server-held secret. It is read into `VoiceConfig`
  and documented in the environment descriptor. Whether a key is present is
  never reported to the client: only the registered ids are.

### Host default

The host default is `defaultSpeechProviderId` (new construction option), else
`VOICE_PROVIDER`, else `deepgram` when Deepgram is registered, else none. The
Deepgram rule keeps today's auto-detect. A host that already sets
`GEMINI_API_KEY` for chat models gains Gemini as a choice, but its dictation
keeps going to Deepgram until the user picks Gemini. An unregistered
`defaultSpeechProviderId` fails construction, while legacy `VOICE_PROVIDER`
misconfiguration keeps its route-time 500 `{ error }`. A legacy by-value `speechProvider` is the host default and must still
match an explicit `VOICE_PROVIDER`.

### Effective provider for the next take (first match wins)

1. The **saved brain-wide default**, if it is registered.
2. A saved default that is **not registered** stops here. Dictation is
   unavailable until the user picks one in Settings ("Your dictation service
   isn't available on this host"). The saved value is kept.
3. With nothing saved: the **host default**.
4. With nothing saved and no host default: the **only registered provider**.
5. Otherwise there is **no effective provider**. With two or more registered,
   the user must choose in Settings. With none, dictation is unavailable, as
   today.

| Registered | Saved | Host default | Effective | Settings shows |
| --- | --- | --- | --- | --- |
| 0 | any | — | none | "Dictation isn't set up on this host." No controls |
| 1 (`deepgram`) | none | `deepgram` | `deepgram` | One read-only row "The only dictation service on this host" |
| 1 (`gemini`, key only) | none | none | `gemini` (rule 4) | One read-only row, plus the SMART switch |
| 2 (`deepgram`,`gemini`) | none | `deepgram` | `deepgram` | Radios; Deepgram marked *host default* |
| 2 | `gemini` | `deepgram` | `gemini` | Radios; Gemini checked, *saved* |
| 2 | `webspeech` (removed) | `deepgram` | **none** | Radios plus a dashed *Saved choice · not available* row; dictation blocked until a pick |
| 2 external (by-value list), no host default | none | none | **none** | Radios with nothing checked: "Choose a dictation service" |
| legacy `speechProvider` | any valid | supplied | as rows above, over a one-item set | Single row |
| legacy client (no `providerId`) | — | — | effective, resolved per request | — |

"Registered" means configured when the server was constructed. This design
adds no credential health probe and makes no paid call. A key that fails later
surfaces through the existing session error, and no other provider is tried.

### Discovery: `GET /api/voice/providers`

Discovery is read-only, authenticated, `no-store`, never mints and never opens
anything:

```json
{
  "providers": [
    { "id": "deepgram", "label": "Deepgram",
      "capabilities": { "streaming": true, "interimResults": true, "keyterms": true,
                        "endpointing": true, "savedAudio": true, "smartTranscription": false } },
    { "id": "gemini", "label": "Google Gemini 3.5 Transcribe Live",
      "destination": "Microphone audio streams from this browser to Google (gemini-3.5-transcribe-live).",
      "capabilities": { "streaming": true, "interimResults": true, "keyterms": true,
                        "endpointing": false, "savedAudio": false, "smartTranscription": true } }
  ],
  "dictation": {
    "saved": "gemini", "savedUsable": true, "host": "deepgram",
    "effective": "gemini", "source": "saved", "smart": true, "revision": "3"
  }
}
```

`source` is one of `"saved" | "host" | "only" | "none" | "unavailable"`.
`GET /voice/capabilities` keeps its shape and reports the effective provider,
or its existing 500 envelope when there is none. Legacy clients therefore
behave exactly as today.

### Preference: `GET`/`PUT /api/voice/dictation/settings`

```http
PUT /api/voice/dictation/settings
If-Match: "3"
Content-Type: application/json

{ "defaultProvider": "gemini", "smart": true }
```

| Outcome | Response |
| --- | --- |
| Saved | `200 { "defaultProvider": "gemini", "smart": true, "revision": "4" }` |
| `defaultProvider` not registered | `400 { "error": "speech_provider_unknown", "message": "That dictation service isn't available on this host." }` |
| Stale or missing `If-Match` | `409 { "error": "dictation_settings_stale", "message": "Changed on another device.", "current": { … } }` (missing gives 428) |
| Not a human owner (`owner`/`ambient`) | `403 { "error": "owner_required" }` |

- The value is stored in the operational settings KV as `voice.dictation`
  (`{ defaultProvider: string | null, smart: boolean, revision: number }`).
  The reader is total: a corrupt or invalid row reads as `{ null, true, 0 }`
  (`getSetting`, `packages/ui-server/src/db/settings.ts:27-42`).
  `defaultProvider: null` clears the saved choice.
- Writes need a human owner. This route enforces that itself; it does not
  assume the Models route's guard. Any authenticated human session may read.
- The route is separate from #3616's live-service route. Neither issue has to
  wait for the other, and saving one cannot clobber the other's revision.
- A save only writes the KV. It opens no provider, mints nothing, touches no
  microphone and reads no history.

## 5. Binding a take and an upload to the disclosed provider

### Live take

```text
tap mic ─► client reads its cached discovery snapshot (refreshed on Settings save
           and on each tap if older than 60 s) ─► effective id E, label, smart S
        ─► E not acknowledged on this device? ─► ack card (D4) ─► Start dictation
        ─► POST /api/voice/session { "providerId": E, "smart": S }
        ─► server: E registered? else 409 speech_provider_unavailable (no mint)
                   S ignored unless E declares smartTranscription
                   mint E; response.providerId === E
        ─► root.asr.create(session) for E; mic opens
```

- The request body is new. An absent body, as sent by a legacy client, means
  "the effective provider now", so legacy clients keep working. A present
  `providerId` is mandatory: there is no substitution, even when the saved
  default changed in the meantime.
- The session response's `providerId`, capabilities and mode are frozen into
  the capture. A Settings save on any device during the take changes nothing
  about it. A token expiring mid-take ends that take through the existing
  provider-ended path (words go to review); it is never re-minted for another
  provider.
- `409 speech_provider_unavailable` and a session mint failure use the
  existing startup notice (connection explanation, "Nothing was captured").
  Neither starts another recognizer.

### Saved-recording upload

- The tray's confirmation names the **saved-audio provider**: the effective
  dictation provider if it declares `savedAudio`. Otherwise, when other
  registered providers can transcribe saved audio, the tray offers an explicit
  per-recording choice among them: "Gemini can't transcribe saved recordings.
  Transcribe with: (•) Deepgram". The choice is not saved. With no capable
  provider, the existing unavailable explanation keeps playback, typing and
  retention.
- `PUT …/transcription` gains the header `Speech-Provider: <id>`, set to the id
  that confirmation disclosed. The server resolves exactly that registered
  provider. An unregistered id gives `409 speech_provider_unavailable`. A
  provider without `savedAudio` gives the existing `501 saved_audio_unsupported`.
  Both happen before claiming, and both add the code to the client's preclaim
  table. A missing header (legacy client) keeps today's resolution.
- **Retry binding.** `claim` refuses a retry whose provider differs from the
  receipt's `providerId`:
  `409 transcription_provider_mismatch`, with the receipt attached. A plain
  repeat returns the stored receipt, as today. Retries, unknown outcomes and
  tombstones keep their existing rules. They now also keep their provider.

## 6. Gemini provider and client

### Server: `createGeminiSpeechProvider(apiKey)`

- `id: "gemini"`, label above; capabilities `streaming`, `interimResults`,
  `keyterms` true; `endpointing` false, so the sheet keeps a manual **Done**
  for long dictation and pauses still commit finals; `smartTranscription`
  true; no `transcribeRecording`, so `savedAudio` is derived false.
- `createSession({ keyterms, mode })` sends one request:

```http
POST https://generativelanguage.googleapis.com/v1beta/auth_tokens
x-goog-api-key: <server key>

{ "expireTime": "<now + 11 min>",
  "newSessionExpireTime": "<now + 60 s>",
  "uses": 1,
  "bidiGenerateContentSetup": {
    "model": "models/gemini-3.5-transcribe-live",
    "generationConfig": { "responseModalities": ["TEXT"] },
    "inputAudioTranscription": { "mode": "SMART",
                                 "customVocabulary": ["Ithaca", "Penelope", "…"] } },
  "fieldMask": "model,generationConfig.responseModalities,inputAudioTranscription.mode,inputAudioTranscription.customVocabulary" }
```

  This is the REST AuthToken that `@google/genai` 2.24.0 serializes from
  `authTokens.create({ config: { liveConnectConstraints, lockAdditionalFields: [] } })`;
  those two are SDK option names, not wire fields. Without keyterms,
  `customVocabulary` is omitted from both the setup and the mask.

  and returns

```json
{ "url": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  "token": "auth_tokens/…", "expiresAt": 1783847400000,
  "params": { "model": "models/gemini-3.5-transcribe-live", "mode": "SMART",
              "sampleRate": "16000", "vocabulary": "[\"Ithaca\",\"Penelope\"]" } }
```

- Vocabulary is the existing bounded keyterm list, capped at **100 terms** of at
  most 64 UTF-8 bytes each. No corpus, history, screen or chat context is sent.
  Language is a fixed `languageCodes: ["en-US"]` hint, locked in the token and
  repeated in the setup, matching Deepgram's fixed `en` (#3769: automatic
  detection returned a short English segment as Spanish). A hint biases
  recognition; it does not restrict it. Adding a language setting is out of
  scope for this epic.
- The constraint locks model, modality and transcription config, and the
  browser's `setup` repeats them field for field. Any additional field the
  client sends is rejected or overridden by Google, which is the point of the
  lock. Whether Google enforces the `fieldMask` this way, and which API version
  (`v1alpha` or `v1beta`) accepts the token, is a #3710 check.
- Token TTL: one use, 60 s to connect, 11 minutes overall (the 10-minute
  session plus margin). **No session resumption** in the first delivery: a take
  ends at Google's 10-minute limit through provider-ended, and its words go to
  review, matching the ten-minute local-capture bound.
- Errors: no key in a URL, log or error; auth-token HTTP errors become the
  existing session 500 `{ error: "Gemini dictation session failed" }`, and
  Google's text is never reflected.

### Browser: `GeminiAsrClient`, registered as `gemini` in `registerAsrClients`

- **Capture.** `getUserMedia` mono (echo cancellation and noise suppression as
  in conversation), AudioContext at the hardware rate, and an AudioWorklet that
  resamples to 16 kHz with a windowed-sinc/linear decimator (no
  `sampleRate: 16000` AudioContext assumption). It emits PCM16 LE. Reuse
  `openConversationMicrophone`'s worklet by extracting the shared piece, not
  its conversation state. Chunks are 100 ms (1,600 samples, 3,200 bytes),
  base64 in the documented `realtimeInput.audio` frame.
- **Connect.** `new WebSocket(url + "?access_token=" + token)`, then the setup
  `{ "setup": { "model", "generationConfig": { "responseModalities": ["TEXT"] },
  "inputAudioTranscription": <same as the constraint> } }`. Audio sent before
  `setupComplete` is buffered up to **5 s (50 chunks)**. Overflow, a 10 s
  handshake timeout or a socket error ends the take with a `network` failure.
  Audio is never dropped silently.
- **Backpressure.** While `socket.bufferedAmount > 256 KiB`, the take fails
  with a `network` failure, because a stalled upload must not grow without
  bound.
- **Events.** `interimInputTranscription.text` is a `partial`, which replaces
  the current partial. `inputTranscription.text` is one `final` with
  `endsTurn: finished ?? true`, and it clears the partial. Each final text
  commits exactly once, so a revised interim cannot append duplicates.
  Messages are zod-parsed with the same size bounds as `gemini-conversation.ts`.
  `error`, `goAway` and unknown-close reasons map to `speechError` codes
  without exposing their text.
- **Done (`drainAndStop`).** Stop the tracks, flush the partial chunk and send
  `audioStreamEnd`. If speech is pending (a `SPEECH` state or an interim that
  no final or `generationComplete` has closed), wait for the
  `generationComplete` that follows `audioStreamEnd`. Otherwise end after
  **300 ms** of quiet, extended to `generationComplete` by any speech or
  interim that arrives in it. `finished` or `turnComplete` also end it, and
  **3 s** caps all of it (#3768). Close either way. Words already heard are
  kept.
- **Hard stop, cancel, unmount, superseded start.** Close the socket (1000),
  disconnect the worklet, close the AudioContext, stop the tracks, clear the
  timers and the queue, and ignore every later message, because the existing
  `live(capture)` gate already drops them for a replacement capture.
- **SMART.** The final text replaces the interim for that segment in the
  unsent draft only. Prior draft text, sent messages and history are never
  rewritten. Pronunciation overrides apply to the final as for other providers.
  SMART text is dictation text: words that sound like commands stay text.

## 7. Settings and capture interaction

The Voice pane sits under *This brain*, between Models and Accounts, with the
meta text "dictation". #3616 later adds its **Live service** group to the same
pane. Whichever issue lands first creates the pane frame. The groups do not
share state or routes, so neither blocks the other. #3690 owns the unified
presentation: until it lands, the existing dictation sheet carries the
destination line and acknowledgement card below. Rows are 52 px tall with 44 px
targets. Selecting a radio saves immediately, as the Models default does.

```text
320 px                               desktop (≥ 900 px, pane column)
┌──────────────────────────────┐     ┌────────────┬──────────────────────────────────────┐
│ ‹ Settings      Voice        │     │ This device│ Voice                                │
├──────────────────────────────┤     │  Appearance│ Dictation                            │
│ Dictation                    │     │ This brain │ Where your spoken words are turned   │
│ Where spoken words become    │     │  Models    │ into draft text. Live conversation   │
│ draft text.                  │     │ ▸ Voice    │ is set separately.                   │
│ ( ) Deepgram                 │     │  Accounts  │ ( ) Deepgram          host default   │
│     host default · saved rec.│     │  …         │     Also transcribes saved recordings│
│ (•) Google Gemini 3.5        │     │            │ (•) Google Gemini 3.5 Transcribe     │
│     Transcribe Live   saved  │     │            │     Live                     saved   │
│     Streams to Google        │     │            │     Streams audio to Google. Can't   │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │     │            │     transcribe saved recordings.     │
│ Clean up as I speak    [on]  │     │            │ ──────────────────────────────────── │
│ Removes fillers, applies     │     │            │ Clean up as I speak            [on]  │
│ "no, I mean…" corrections,   │     │            │ Removes fillers, applies spoken      │
│ formats lists. Next take.    │     │            │ corrections, formats lists. Applies  │
│                              │     │            │ from your next dictation.            │
│ Saving… / Couldn't save.     │     │            │                                      │
│ [Try again]                  │     │            │                                      │
└──────────────────────────────┘     └────────────┴──────────────────────────────────────┘
```

| State | Settings | Next tap on the mic |
| --- | --- | --- |
| Loading | Skeleton rows, and the group has `aria-busy` | Uses the cached snapshot, or re-reads it before the session request |
| Zero providers | Info line "Dictation isn't set up on this host." | Mic disabled, with the existing unavailable label |
| One | One read-only row, plus the switch if SMART | Starts it (ack first time) |
| Many, saved usable | Radios, saved checked | Starts saved (ack first time) |
| Many, none saved, host default | Host default marked; nothing saved | Starts host default |
| Many, none saved, no host default | "Choose a dictation service" and no radio checked | Sheet: "Choose a dictation service in Settings › Voice" with **Open Settings**; no mic |
| Saved unavailable | Dashed "Saved choice · not available" row (not selectable) plus radios | Same blocked sheet naming the missing service; no fallback |
| Save pending / failed | The radio shows its new value with "Saving…"; on failure it reverts, and an inline error offers **Try again** | Uses the last confirmed value |
| Stale (409) | "Changed on another device", and the current value is reloaded | Uses the server value |
| Take active while saved elsewhere | Info line "Dictating with *X* now. Your change applies to the next take." | Unchanged until the next take |
| Read-only (non-owner human) | Radios disabled; "Only the owner can change this." | Effective as resolved |

**Acknowledgement card (D4)** is shown in the dictation sheet before any
session request or microphone access:

```text
┌──────────────────────────────┐
│ Dictation goes to Google     │
│ Gemini 3.5 Transcribe Live   │
│ While you speak, microphone  │
│ audio streams from this      │
│ browser to Google. Words     │
│ land in your draft; nothing  │
│ is sent until you send it.   │
│ [Cancel]   [Start dictation] │
└──────────────────────────────┘
```

- Acknowledgements are stored on the device (per brain origin and account,
  keyed by provider id and the destination text). Changing the destination
  text asks again. Storage failure means "not acknowledged", which asks again;
  it is never treated as consent.
- Focus moves to **Start dictation**. Escape and Cancel close the sheet, and
  nothing opens. The microphone control's accessible name and tooltip are
  "Dictate · Gemini" (the provider's short label). The listening sheet repeats
  "To Google Gemini".

## 8. Contract changes (all additive, minor, `CONTRACT:`)

| Surface | Change | Owner |
| --- | --- | --- |
| `@schlessera/brain-ui-sdk/server` `SpeechProvider` | Optional `label?: string`, `destination?: string`; `createSession` options gain optional `mode?: "smart" \| "verbatim"`, which providers ignore unless they declare SMART | #3707 (types); #3708 (uses) |
| `@schlessera/brain-ui-sdk/protocol` `SpeechCapabilities` | Optional `smartTranscription?: boolean` | #3707 |
| Protocol | `VoiceProvidersResponse`, `DictationSettings`, `VoiceSessionRequest` | #3707 |
| HTTP | `GET /voice/providers`; `GET`/`PUT /voice/dictation/settings`; `POST /voice/session` optional body; `Speech-Provider` upload header; new codes `speech_provider_unknown`, `speech_provider_unavailable`, `dictation_settings_stale`, `transcription_provider_mismatch` | #3707 |
| `createApp` options | `speechProviders?: SpeechProvider[]`, `defaultSpeechProviderId?: string` | #3707 |
| Environment | `GEMINI_API_KEY` also registers Gemini dictation; `VOICE_PROVIDER` accepts `gemini` | #3708 (built-in and `VOICE_PROVIDER=gemini`); #3707 (multi-registration) |
| Built-in client id | `gemini` registered by `registerAsrClients` | #3708 |
| UI behaviour | Voice pane Dictation group, acknowledgement card, tray provider choice | #3709 |

Authoritative updates land with each change: `docs/integration-contract/package-api.md`
("Dictation speech integration and conformance"), `docs/integration-contract/http.md`
and `docs/http-api.md` ("Saved-audio transcription", voice routes),
`docs/extending/speech.md`, the env descriptor docs, and API reports. Existing
meanings are unchanged. No break is proposed.

## 9. Implementation and proof split

**#3707, server/SDK selection.** It has no Gemini dependency. Use two keyless
doubles, `alpha` (saved audio) and `beta` (streaming only, SMART), installed
below the shared request path.

- Mounted-route tests cover every row of the §4 table, assert which double's
  `createSession` / `transcribeRecording` ran, and check that the other ran
  zero times.
- A held `createSession` crosses a `PUT` default change. The response still
  names the requested id, and the other double is never invoked.
- A held upload crosses a default change, and its receipt keeps the provider
  from the header. A retry naming a different provider gets
  `transcription_provider_mismatch`, with no dispatch.
- Settings authorization, revision and stale handling. Legacy `speechProvider`
  and legacy client parity, byte-identical for `/voice/capabilities` and
  bodyless `/voice/session`.
- Mutations: drop the `providerId` check (substitute the effective provider) →
  the held-mint test fails; resolve the upload from the current default instead
  of the header → the held-upload test fails.

**#3708, Gemini pair.** It can land before #3707 as a `VOICE_PROVIDER=gemini` /
key-registered built-in over the legacy single selection.

- Server: auth-token request shape against a loopback double (constraints,
  TTL, vocabulary cap, no key in the response, log or error).
- Client: published `runAsrClientContract`, plus a local WebSocket double that
  asserts the setup frame, base64 PCM16 framing at 16 kHz from 44.1 and 48 kHz
  contexts in real Chrome, the pre-setup buffer bound, backpressure failure,
  interim replacement, single final commit, the `audioStreamEnd` drain (on
  `generationComplete`, after a quiet with nothing pending, capped at 3 s), and complete teardown (tracks ended, context closed, socket closed, no
  late mutation).
- Mutations: final mapped as partial, resampler bypassed, constraint lock
  removed, teardown skipping `context.close()`. Each fails its named
  assertion.

**#3709, Settings and capture.** It needs #3707's API; it uses doubles, not
Gemini.

- Real browser at 320 px and 1280 px for every §7 state, keyboard, focus,
  touch targets, reload/restart persistence and owner/non-owner.
- Assertions that Settings alone makes no `getUserMedia`, `/voice/session` or
  provider request.
- The acknowledgement gate precedes any session request.
- A save during an active take leaves its socket and adapter intact.
- Tray choice and the stale-provider 409 path.
- Mutations: skip the acknowledgement → the "no session before Start
  dictation" assertion fails; send the current default instead of the disclosed
  id → the race test fails.

**#3710, qualification.** Gated on human authorization. It resolves the §2
divergences and unproven items, without any pass threshold that was not agreed
in advance.

## 10. Alternatives considered

- **Server relay for Gemini audio** (as live conversation does). It keeps the
  key off the browser even without tokens, but it adds a generic audio relay
  the epic excludes and doubles egress. Constrained tokens give the same key
  safety.
- **Replaying saved recordings into a live socket** to fake `savedAudio`. This
  was rejected again for the reasons in the 2026-10-08 decision.
- **Using `@google/genai` in the browser.** It adds a large dependency and an
  SDK that warns its ephemeral support is experimental. The wire protocol is
  small, and the conversation adapter already speaks it.
- **A per-take Change** (D2) and **an explicit `VOICE_PROVIDERS` list** (D3)
  were offered and not selected.
- **One shared Voice settings route with live conversation.** It couples #3616
  and #3709 through one revision. Separate routes in one pane avoid a circular
  dependency.
- **Session resumption past 10 minutes.** It is deferred: it needs a
  resumption handle, reconnect pacing and duplicate-final handling across the
  seam. A 10-minute take bound matches local capture.
