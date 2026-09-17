// Register the built-in ASR clients into the @schlessera/brain-ui-sdk registry.
// Registration wires the store-side extras (audio-level meter, end-of-stream ->
// idle) that fall outside the neutral AsrClient interface. use-dictation then
// resolves a client via createAsrClient().
//
// Idempotent because the registry is keyed by providerId, NOT because this
// module latches: a latch survives `resetAsrClients()`, which would leave the
// registry permanently empty for everything that ran after the first reset.

import type { BrainUiRoot } from "../root.js";
import { defaultRoot } from "../default-root.js";
import { DeepgramClient } from "./asr-deepgram.js";
import { WebSpeechClient } from "./asr-webspeech.js";

export function registerAsrClients(root: BrainUiRoot = defaultRoot): void {
  function endToIdle() {
    if (root.stores.voice.getState().mode === "dictate") {
      root.stores.voice.getState().setMode("idle");
    }
  }


  root.asr.register(
    "deepgram",
    (opts) =>
      new DeepgramClient({
        url: opts.session.url,
        token: opts.session.token ?? "",
        onEvent: opts.onEvent,
        onError: opts.onError,
        onAudioLevel: (level) => root.stores.voice.getState().setAudioLevel(level),
        onClose: endToIdle,
      })
  );

  root.asr.register(
    "webspeech",
    (opts) =>
      new WebSpeechClient({
        onEvent: opts.onEvent,
        onError: opts.onError,
        onEnd: endToIdle,
      })
  );
}
