/**
 * SpeechProvider — server side of the STT seam. A provider mints per-session
 * connection material for the client's matching AsrClient; audio never
 * transits the brain-ui server unless the provider itself proxies (e.g. a
 * local whisper.cpp provider whose `url` points back at the server).
 */

import type { SpeechCapabilities } from "../protocol";

export interface SpeechSession {
  /** wss endpoint the client connects to. */
  url: string;
  /** Omitted for local/browser providers that need no credential. */
  token?: string;
  params?: Record<string, string>;
  /** Epoch millis; clients re-request after expiry. */
  expiresAt: number;
}

export interface SpeechProvider {
  id: string;
  capabilities: SpeechCapabilities;
  /**
   * Mint one dictation session. `keyterms` are domain terms from the brain's
   * keyterm builder — providers without keyterm support ignore them
   * (capabilities.keyterms = false).
   */
  createSession(opts: { keyterms: string[] }): Promise<SpeechSession>;
}

/** Typed authoring helper (identity), matching the core define* convention. */
export function defineSpeechProvider(provider: SpeechProvider): SpeechProvider {
  return provider;
}
