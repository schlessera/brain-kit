// Register the built-in ASR clients into the @schlessera/brain-ui-sdk registry.
// Registration wires the store-side extras (audio-level meter, end-of-stream ->
// idle) that fall outside the neutral AsrClient interface. use-dictation then
// resolves a client via createAsrClient().
//
// Idempotent because the registry is keyed by providerId, NOT because this
// module latches: a latch survives `resetAsrClients()`, which would leave the
// registry permanently empty for everything that ran after the first reset.

import { registerAsrClient } from "@schlessera/brain-ui-sdk/client";
import { DeepgramClient } from "./asr-deepgram.js";
import { WebSpeechClient } from "./asr-webspeech.js";
import { useVoiceStore } from "./voice-store.js";

function endToIdle() {
  if (useVoiceStore.getState().mode === "dictate") {
    useVoiceStore.getState().setMode("idle");
  }
}

export function registerAsrClients(): void {
  registerAsrClient(
    "deepgram",
    (opts) =>
      new DeepgramClient({
        url: opts.session.url,
        token: opts.session.token ?? "",
        onEvent: opts.onEvent,
        onError: opts.onError,
        onAudioLevel: (level) => useVoiceStore.getState().setAudioLevel(level),
        onClose: endToIdle,
      })
  );

  registerAsrClient(
    "webspeech",
    (opts) =>
      new WebSpeechClient({
        onEvent: opts.onEvent,
        onError: opts.onError,
        onEnd: endToIdle,
      })
  );
}
