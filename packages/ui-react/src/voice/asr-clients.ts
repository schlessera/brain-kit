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
import { providerEnded } from "./dictation-capture.js";

export function registerAsrClients(root: BrainUiRoot = defaultRoot): void {
  root.asr.register("deepgram", (opts) => {
    const client: DeepgramClient = new DeepgramClient({
      url: opts.session.url,
      token: opts.session.token ?? "",
      onEvent: opts.onEvent,
      onError: opts.onError,
      onAudioLevel: (level) => root.stores.voice.getState().setAudioLevel(level),
      // The socket closed without a stop(): end of stream, an idle timeout,
      // a drop or an expired grant. What was heard goes to review (#1189).
      onClose: () => providerEnded(root.stores, client),
    });
    return client;
  });

  root.asr.register("webspeech", (opts) => {
    const client: WebSpeechClient = new WebSpeechClient({
      onEvent: opts.onEvent,
      onError: opts.onError,
      // The recognizer ended without a stop(), after a pause, a time limit
      // or an error. What was heard goes to review (#1189).
      onEnd: () => providerEnded(root.stores, client),
    });
    return client;
  });
}
