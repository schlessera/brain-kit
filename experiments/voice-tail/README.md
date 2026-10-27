# Voice-tail output diagnostics — EVALUATION ONLY / DO NOT MERGE

This removable experiment supports #3057, with action metadata for #3058 and
limited terminology clarification for #3050. It neither activates a provider nor
qualifies one. Keep provider budgets, the independent host 120-second cap and
all stop/permission boundaries. Use only a controlled fictional reply, for example
“Odysseus, the ship is ready.” Never retain microphone audio. No secret is needed.

## Browser capture

Use a fresh evaluation page with no existing playback context. The bundle exposes
`window.brainAudioEvaluation.arm(sourceSha)`. Invoke it from an explicit user
gesture **before entering voice** and await its result. Pass the exact built source
commit, verified against the parent build manifest; this is a declared source
identity, not browser attestation. Save the returned recording object locally.
Setup creates a silent playback context and an output-only AudioWorklet. It never
opens a microphone or sends a provider request. Initialization failure prevents
arming; do not start the trial until it resolves. No asynchronous tap insertion
occurs after playback starts. A zero-valued looping AudioBufferSource keeps the
tap's channel topology stable through silence. The tap copies every render block,
including silence, immediately and emits only zero on its additional destination
branch. Actual playback retains its single ordinary audible destination.

The PCM receive copy happens before the prototype recovery filter. It is
**adapter-received browser PCM**, not proof of raw provider-wire delivery. Each
received chunk records its concatenation byte offset; scheduling records the same
byte offset, AudioContext start, frame count and rate. Local tones have offset -1.
The mix is float32 mono at the actual context rate (requested 48 kHz), **before the
driver/headphone hardware**, never a recording at the ear. Resampling and scheduling
mean provider and mix hashes need not match. Hashes cover exported WAV bytes.

Allow at least one second of post-reply silence. End the trial explicitly, then
call `await recording.finish()`. Finish requests a FIFO worklet acknowledgement,
checks the terminal sequence/frame, and closes its playback context. It returns
`{provider: Blob, mix: Blob, metadata}`; export all three together. There is no
normalization, tail trimming, smoothing or microphone data. Do not treat export
as a provider stop: parent ends the bounded provider session separately first.

Bounds per arm: 120 seconds, 5,760,000 provider PCM bytes, 24,000,000 mix float32
bytes, 16,384 metadata events. This uses float32 rather than the illustrative
11.52 MB PCM16 mix to preserve rendered values. Steady audio payload is below
30 MB; WAV export/hash copies can temporarily bring payload memory below 120 MB,
plus bounded per-block/event object overhead. A cap marks the recording incomplete;
it does not cut audible playback or stop the provider. Provider/session spend
limits remain the parent's independent responsibility. Callback delivery delays
above 250 ms are reported; sequence/frame discontinuities, processor errors,
metadata/byte caps and missing finish acknowledgements mark incomplete. An
incomplete capture must not be presented as product clipping or silently repaired.

Each tap callback snapshots the browser's observed `currentFrame` and
`currentTime` once. A separate `sampleOffset` counts copied input samples; the
collector checks it against retained WAV samples. Gap events retain both clock
observations and cumulative offsets, under the existing event cap. First/last
observed times, captured sample count and the terminal observed clocks/offset are
exported too. The counter never replaces browser frames: a repeated/jumped frame
still makes `complete: false`, even when samples independently match a fixture.
A clock snapshot is diagnostic evidence, not an asserted causal repair.

The keyless `conversation-diagnostic-samples.offline.tsx` browser proof uses the
actual playback queue and tap at 48 kHz. A deterministic nonrepeating PCM buffer,
a final 37-sample chunk and both silence edges are compared sample by sample
against scheduled frame offsets. There is no onset search or trimming to discard
lost startup/finish samples. Both silence edges require exact zero. Inside the
signal only, the comparison allows numerical differences up to `1e-9` (over
30,000 times smaller than one PCM16 step) and reports their count and maximum
error. Fractional scheduled-frame values are logged too; no raw sample is altered
or a discrepancy hidden. A second case runs a separate synthetic input
AudioContext/AudioWorklet with zero input and no microphone. This bounded topology
probe cannot establish absence of an intermittent browser anomaly. These graph-only
cases have no provider output and therefore never claim paired-capture completeness.
Run them with `node scripts/visual.mjs --project=ui-react-layout
--filter=conversation-diagnostic`; run processor/analyzer/collector checks with
`bun run test experiments/voice-tail`. Sample-integrity proof and the conservative
browser-clock verdict are separate assertions. Neither proves provider finality,
physical playback, or the cause of a reported reply ending.

## Optional local collection

Run `bun experiments/voice-tail/collector.ts OUTPUT_DIRECTORY EXACT_BROWSER_ORIGIN
SOURCE_SHA` from this checkout. Use a new directory outside the public repository.
It binds loopback on an ephemeral port and prints its address. It accepts one
`provider.wav`, one `mix.wav`, then `metadata.json`, each through POST, only from
the exact supplied Origin. It refuses unknown paths, duplicates and oversized
bodies; metadata must match source SHA and both WAV hashes. Disk payload is bounded
by 31,760,088 bytes. Files use exclusive creation and mode 0600. The listener has
no provider connection or keys; stop it after collection. Do not put secrets in
URLs or logs. The parent owns any browser-to-loopback transport permission.

From the armed page, after `const result = await recording.finish()`:

```js
// collectorOrigin is the parent-selected loopback origin, without secrets.
for (const [name, body] of [
  ["provider.wav", result.provider], ["mix.wav", result.mix],
  ["metadata.json", new Blob([JSON.stringify(result.metadata)], { type: "application/json" })]
]) {
  const response = await fetch(new URL(name, collectorOrigin), { method: "POST", body });
  if (!response.ok) throw new Error(`Output export refused: ${response.status}`);
}
```

Browser network policy may forbid loopback collection. A Blob download of these
same three objects is an equivalent export; do not broaden the application CSP.
The collector does not serve or replay recordings. Replay exported WAVs locally.

## Optional capture before the browser

`openProviderOutputTap` in `provider-output.ts` is an explicit parent-installed
local helper, with no transport or automatic integration. Call `receive(pcm)` only
for validated **output**, never input. For the installed GPT-Live adapter, the
verified output branch validates `session.output_audio.delta`, canonical base64,
even nonempty PCM and `CONVERSATION_LIMITS.maxAudioChunkBytes` (65,536), then emits
`kind: "audio"` at 24 kHz mono. Install after validation and before emit if using
`raw-provider-wire` provenance. A provider.events audio callback is instead
`adapter-received`; record that distinction. A WebSocket subclass observing raw
JSON must independently validate this event/PCM shape before calling the helper.
No provider key or provider history change is required. `close()` returns the
PCM hash, format, arrival offsets/sequences and source identity. Save its metadata
outside the repo alongside its raw `.pcm`. Refused chunks mark incomplete; do not
suppress exceptions or infer a natural tail from an incomplete recording.

## Waveform and RMS

`python3 experiments/voice-tail/plot.py OUTPUT_DIRECTORY --end CONTEXT_SECONDS`
uses NumPy/Matplotlib already available to the operator. Choose a context end time
from the relevant `playback-scheduled` record near the final audible sound, not
file EOF (which includes silence). The helper uses that record's exact provider
byte-offset/context-time anchor and actual rates, plots a 1.4-second window at
fixed ±1 scale and a 10 ms RMS envelope, and saves `tail-waveform-rms.png` beside
the raw WAVs. Unsheduled/suppressed provider bytes remain available for inspection;
where cuts or multiple scheduling anchors cross a window, inspect metadata and
align each segment explicitly instead of treating the concatenation as a single
wall-clock recording. Incomplete/gapped mix timelines must remain unresolved.
A provider WAV alone cannot establish headphone-output completeness.

## Parent harness notices

Keep the independent hard cap unchanged. Show “Evaluation ends after 120 seconds”
before opening; warn at 105 seconds from the actual session opening, then use the
existing closed-message field with “Evaluation 120-second session cap reached.
Microphone off. Start a new bounded evaluation session.” The client preserves the
specific close message in its visible notice. Emit a separate parent metadata
breadcrumb for `host-cap-warning`/`host-cap-close` with elapsed monotonic time and
close code; do not record speech, transcripts, URLs or keys. This is an installation
instruction for the parent's disposable harness, not an automatic provider hook.
Other provider/host closures remain distinct; the cap does not explain all stops.

The evaluation labels distinguish voice-service audio/transcription/replies from
manual Brain task submission. The task executor must stay scripted in this trial.
No automatic send, recognized-text clearing, new authority or guard relaxation
is included. Action breadcrumbs distinguish control mute from component cleanup,
Resume request, capture opening, lifecycle pause, close and recovery. They do not
establish the cause of the earlier stuck-Resume report.
