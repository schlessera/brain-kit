/**
 * Server side of the STT seam. A SpeechProvider mints the per-session
 * connection material the client's matching AsrClient needs. Built-ins:
 *
 * - `deepgram`  — mints a short-lived Deepgram token and the full streaming WS
 *                 URL (base params + domain keyterms baked in).
 * - `webspeech` — no server session; the browser's SpeechRecognition does the
 *                 work, so it returns empty url/token.
 *
 * VOICE_PROVIDER selects the provider; default is deepgram when
 * DEEPGRAM_API_KEY is set, otherwise selection fails. An external value takes
 * precedence over auto-detection and must match an explicit VOICE_PROVIDER.
 * Both arrive here as the resolved
 * {@link VoiceConfig} — this module reads no environment.
 */

import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { defineSpeechProvider } from "@schlessera/brain-ui-sdk/server";
import type { VoiceConfig } from "../config/env.js";
import { mintDeepgramToken } from "./deepgram-token.js";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

// Match the previous client-side caps: Deepgram nova-3 handles ~500 keyterms
// semantically, but the WS connect URL has a practical length ceiling.
const MAX_KEYTERMS = 100;
const MAX_URL_BYTES = 6000;
const TOKEN_TTL_SECONDS = 60;

/** Build the full Deepgram streaming URL with base params + capped keyterms. */
function buildDeepgramUrl(keyterms: string[]): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    smart_format: "true",
    interim_results: "true",
    utterance_end_ms: "1500",
    vad_events: "true",
    encoding: "opus",
    mip_opt_out: "true",
  });
  let url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
  let added = 0;
  for (const term of keyterms) {
    if (added >= MAX_KEYTERMS) break;
    const candidate = `${url}&keyterm=${encodeURIComponent(term)}`;
    if (candidate.length > MAX_URL_BYTES) break;
    url = candidate;
    added++;
  }
  return url;
}

export function createDeepgramSpeechProvider(apiKey: string | null): SpeechProvider {
  return defineSpeechProvider({
    id: "deepgram",
    capabilities: {
      streaming: true,
      interimResults: true,
      keyterms: true,
      endpointing: true,
    },
    async createSession({ keyterms }) {
      const { token, expiresAt } = await mintDeepgramToken(apiKey, TOKEN_TTL_SECONDS);
      return {
        url: buildDeepgramUrl(keyterms),
        token,
        expiresAt,
      };
    },
  });
}

export const webspeechSpeechProvider: SpeechProvider = defineSpeechProvider({
  id: "webspeech",
  capabilities: {
    streaming: true,
    interimResults: true,
    keyterms: false,
    endpointing: false,
  },
  async createSession() {
    // No server session — the browser's SpeechRecognition does everything.
    return { url: "", expiresAt: 0 };
  },
});

/**
 * Select the active speech provider from the resolved voice config.
 *
 * webspeech is OPT-IN ONLY (`VOICE_PROVIDER=webspeech`): on Chromium it streams
 * microphone audio to Google, so it must never be a silent fallback when the
 * Deepgram key goes missing. Every other unresolved case throws so the caller
 * 500s loudly instead of quietly degrading to third-party egress.
 */
export function pickSpeechProvider(voice: VoiceConfig, supplied?: SpeechProvider): SpeechProvider {
  const configured = voice.provider;
  if (supplied !== undefined) {
    assertSpeechProvider(supplied);
    if (configured && configured !== supplied.id) {
      throw new Error(`VOICE_PROVIDER="${configured}" does not match supplied SpeechProvider "${supplied.id}".`);
    }
    return supplied;
  }
  if (configured === "webspeech") return webspeechSpeechProvider;
  if (configured === "deepgram") {
    if (!voice.deepgramApiKey) {
      throw new Error("VOICE_PROVIDER=deepgram but DEEPGRAM_API_KEY is not set.");
    }
    return createDeepgramSpeechProvider(voice.deepgramApiKey);
  }
  if (configured) {
    throw new Error(
      `Unknown VOICE_PROVIDER="${configured}" (expected "deepgram" or "webspeech").`
    );
  }
  // Auto-detect: Deepgram when its key is present; otherwise fail loudly.
  if (voice.deepgramApiKey) return createDeepgramSpeechProvider(voice.deepgramApiKey);
  throw new Error(
    'No speech provider configured. Set DEEPGRAM_API_KEY, or set ' +
      'VOICE_PROVIDER=webspeech to explicitly opt into the browser speech API ' +
      "(which streams audio to Google on Chromium)."
  );
}

/** Validate a by-value implementation before invoking it or building keyterms. */
function assertSpeechProvider(provider: SpeechProvider): void {
  if (!provider || typeof provider !== "object" || typeof provider.id !== "string" ||
      !provider.id || provider.id !== provider.id.trim().toLowerCase()) {
    throw new Error("Invalid SpeechProvider: id must be a nonempty, trimmed, lowercase string.");
  }
  for (const capability of ["streaming", "interimResults", "keyterms", "endpointing"] as const) {
    if (typeof provider.capabilities?.[capability] !== "boolean") {
      throw new Error(`Invalid SpeechProvider "${provider.id}": capabilities.${capability} must be boolean.`);
    }
  }
  if (typeof provider.createSession !== "function") {
    throw new Error(`Invalid SpeechProvider "${provider.id}": createSession must be a function.`);
  }
}
