/**
 * SpeechProvider — server side of the STT seam. A provider mints per-session
 * connection material for the client's matching AsrClient. Optional saved
 * recordings instead travel browser → brain server → provider, after the
 * user explicitly confirms upload. Streaming dictation keeps its own path.
 */

import type { SpeechCapabilities, TranscriptionFailureReason } from "../protocol.js";

/** @experimental Part of the `SpeechProvider` seam. */
export interface SpeechSession {
  /** wss endpoint the client connects to. */
  url: string;
  /** Omitted for local/browser providers that need no credential. */
  token?: string;
  params?: Record<string, string>;
  /** Epoch millis; clients re-request after expiry. */
  expiresAt: number;
}

/**
 * Mints per-session STT connection material for the client's `AsrClient`.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface SpeechProvider {
  id: string;
  capabilities: SpeechCapabilities;
  /**
   * Mint one dictation session. `keyterms` are domain terms from the brain's
   * keyterm builder — providers without keyterm support ignore them
   * (capabilities.keyterms = false).
   */
  createSession(opts: { keyterms: string[] }): Promise<SpeechSession>;
  /** Optional saved-audio path. Call only the provider from the server with its
   * server-held credential; forward bytes unchanged. Reject on failure. No
   * automatic retries. Untyped errors are terminal unknown outcomes. */
  transcribeRecording?(input: {
    audio: Uint8Array;
    contentType: string;
    keyterms: string[];
    signal: AbortSignal;
  }): Promise<SavedAudioTranscription>;
}

/** @experimental Result of the optional saved-audio method. */
export interface SavedAudioTranscription { text: string }

/** @experimental A definitive provider response, or an ambiguous outcome.
 * Retry classification is derived by the host, never supplied as a boolean.
 * Use outcome_unknown if dispatch might have succeeded without a valid reply. */
export class SpeechTranscriptionError extends Error {
  constructor(readonly reason: TranscriptionFailureReason, readonly providerStatus?: number) {
    super(`Saved-audio transcription failed: ${reason}`);
    this.name = "SpeechTranscriptionError";
  }
}

/** Typed authoring helper (identity), matching the core define* convention. */
export function defineSpeechProvider(provider: SpeechProvider): SpeechProvider {
  return provider;
}
