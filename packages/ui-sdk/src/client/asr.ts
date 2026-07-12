/**
 * AsrClient — client side of the STT seam. The client requests
 * POST /voice/session, then instantiates the AsrClient factory registered
 * for the returned providerId with the session's connection material.
 */

import type { AsrEvent, SpeechCapabilities, VoiceSessionResponse } from "../protocol";

export interface AsrClientOptions {
  session: VoiceSessionResponse;
  onEvent: (event: AsrEvent) => void;
  onError: (error: Error) => void;
}

export interface AsrClient {
  /** Open the stream and start capturing microphone audio. */
  start(): Promise<void>;
  /** Hard stop: close immediately, discard buffered audio. */
  stop(): void;
  /** Graceful stop: flush buffered audio, deliver final events, then close. */
  drainAndStop(): Promise<void>;
}

export type AsrClientFactory = (opts: AsrClientOptions) => AsrClient;

const factories = new Map<string, AsrClientFactory>();

export function registerAsrClient(providerId: string, factory: AsrClientFactory): void {
  factories.set(providerId, factory);
}

export function createAsrClient(opts: AsrClientOptions): AsrClient {
  const factory = factories.get(opts.session.providerId);
  if (!factory) {
    throw new Error(
      `No AsrClient registered for speech provider "${opts.session.providerId}" ` +
        `(registered: ${[...factories.keys()].join(", ") || "none"})`
    );
  }
  return factory(opts);
}

/**
 * Degradation guidance for UI code (derived, not hardcoded per provider):
 * - !capabilities.interimResults → skip live partial rendering
 * - !capabilities.endpointing   → show a manual Done button
 * - !capabilities.keyterms      → skip the keyterm fetch
 */
export function speechUiHints(capabilities: SpeechCapabilities): {
  showPartials: boolean;
  needsManualStop: boolean;
  fetchKeyterms: boolean;
} {
  return {
    showPartials: capabilities.interimResults,
    needsManualStop: !capabilities.endpointing,
    fetchKeyterms: capabilities.keyterms,
  };
}

/** Test helper — clears all registrations. */
export function resetAsrClients(): void {
  factories.clear();
}
