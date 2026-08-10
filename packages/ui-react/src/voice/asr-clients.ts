// Register the built-in ASR clients into the @schlessera/brain-ui-sdk registry.
// Registration is idempotent and wires the store-side extras (audio-level
// meter, end-of-stream -> idle) that fall outside the neutral AsrClient
// interface. use-dictation then resolves a client via createAsrClient().

import { registerAsrClient } from "@schlessera/brain-ui-sdk/client";
import { DeepgramClient } from "./asr-deepgram.js";
import { WebSpeechClient } from "./asr-webspeech.js";
import { useVoiceStore } from "./voice-store.js";

let registered = false;

function endToIdle() {
  if (useVoiceStore.getState().mode === "dictate") {
    useVoiceStore.getState().setMode("idle");
  }
}

export function registerAsrClients(): void {
  if (registered) return;
  registered = true;

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
