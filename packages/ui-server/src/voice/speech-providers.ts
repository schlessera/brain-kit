/**
 * Server side of the STT seam. A SpeechProvider mints the per-session
 * connection material the client's matching AsrClient needs. Built-ins:
 *
 * - `deepgram`  — mints a short-lived Deepgram token and the full streaming WS
 *                 URL (base params + domain keyterms baked in).
 * - `gemini`    — mints a single-use constrained Gemini Live token for
 *                 gemini-3.5-transcribe-live (`gemini-speech.ts`).
 * - `webspeech` — no server session; the browser's SpeechRecognition does the
 *                 work, so it returns empty url/token.
 *
 * Registration is fixed at construction. VOICE_PROVIDER selects a host default;
 * saved settings choose among registered providers without automatic fallback.
 * A legacy external value replaces built-ins and must match VOICE_PROVIDER.
 * Both arrive here as the resolved
 * {@link VoiceConfig} — this module reads no environment.
 */

import type { DictationSettings, VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { defineSpeechProvider, SpeechTranscriptionError } from "@schlessera/brain-ui-sdk/server";
import type { VoiceConfig } from "../config/env.js";
import { mintDeepgramToken } from "./deepgram-token.js";
import { createGeminiSpeechProvider } from "./gemini-speech.js";

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
    label: "Deepgram",
    destination: "Microphone audio streams from this browser to Deepgram (nova-3).",
    capabilities: {
      streaming: true,
      interimResults: true,
      keyterms: true,
      endpointing: true,
    },
    async transcribeRecording({ audio, contentType, keyterms, signal }) {
      if (!apiKey) throw new SpeechTranscriptionError("authentication", 401);
      const params = new URLSearchParams({ model: "nova-3", smart_format: "true", mip_opt_out: "true" });
      // Conservative byte budget: at most one token per UTF-8 byte, including
      // separators. This stays under Deepgram's 500-token aggregate ceiling
      // without introducing a tokenizer dependency or changing streaming terms.
      let budget = 500;
      for (const term of keyterms) {
        const cost = new TextEncoder().encode(term).length + 1;
        if (!term.trim() || cost > budget) continue;
        params.append("keyterm", term); budget -= cost;
      }
      const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST", headers: { authorization: `Token ${apiKey}`, "content-type": contentType },
        body: audio as BodyInit, signal, redirect: "error",
      });
      if (!response.ok) {
        const status = response.status;
        // Every HTTP error is a definitive response under #1021's ruling;
        // fetch/parse/timeout failures without one remain outcome_unknown.
        const reason = status === 401 || status === 403 ? "authentication"
          : status === 429 ? "rate_limit" : status === 504 || status === 408 ? "provider_timeout"
          : status >= 500 ? "provider_error" : status === 415 || status === 422 ? "media" : status === 400 ? "parameters" : "validation";
        await response.body?.cancel().catch(() => {});
        throw new SpeechTranscriptionError(reason, status);
      }
      const body = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> } };
      const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (typeof text !== "string" || !text.trim()) throw new SpeechTranscriptionError("outcome_unknown");
      return { text };
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
  label: "Browser speech recognition",
  destination: "Your browser recognizes speech; on Chromium, microphone audio goes to Google.",
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

const NO_SPEECH_PROVIDER = 'No speech provider configured. Set DEEPGRAM_API_KEY or GEMINI_API_KEY, or set ' +
  'VOICE_PROVIDER=webspeech to explicitly opt into the browser speech API ' +
  '(which streams audio to Google on Chromium).';

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
  for (const field of ["label", "destination"] as const) {
    const value = provider[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`Invalid SpeechProvider "${provider.id}": ${field} must be a nonempty string when supplied.`);
    }
  }
  if (provider.capabilities.smartTranscription !== undefined && typeof provider.capabilities.smartTranscription !== "boolean") {
    throw new Error(`Invalid SpeechProvider "${provider.id}": capabilities.smartTranscription must be boolean when supplied.`);
  }
  if (provider.transcribeRecording !== undefined && typeof provider.transcribeRecording !== "function") {
    throw new Error(`Invalid SpeechProvider "${provider.id}": transcribeRecording must be a function when supplied.`);
  }
  if (provider.capabilities.savedAudio !== undefined && provider.capabilities.savedAudio !== (typeof provider.transcribeRecording === "function")) {
    throw new Error(`Invalid SpeechProvider "${provider.id}": savedAudio contradicts transcribeRecording.`);
  }
  if (typeof provider.createSession !== "function") {
    throw new Error(`Invalid SpeechProvider "${provider.id}": createSession must be a function.`);
  }
}

/** Every route uses method-derived saved-audio support. */
export function speechCapabilities(provider: SpeechProvider) {
  return { ...provider.capabilities, savedAudio: typeof provider.transcribeRecording === "function" };
}

/** Built-ins registered from configuration. A key adds a choice; it never
 * makes that provider the host default (D3). Browser speech stays opt-in. */
function configuredSpeechProviders(voice: VoiceConfig): SpeechProvider[] {
  const providers: SpeechProvider[] = [];
  if (voice.deepgramApiKey) providers.push(createDeepgramSpeechProvider(voice.deepgramApiKey));
  if (voice.geminiApiKey) providers.push(createGeminiSpeechProvider(voice.geminiApiKey));
  if (voice.provider === "webspeech") providers.push(webspeechSpeechProvider);
  return providers;
}

/** Construction fixes identities, metadata, capabilities and executors. Settings
 * only choose among these values; they never construct or probe a provider.
 *
 * Misuse of the additive options (`speechProviders`, `defaultSpeechProviderId`)
 * fails construction. Legacy misconfiguration (an invalid by-value
 * `speechProvider`, a `VOICE_PROVIDER` that names an unregistered or
 * mismatching provider) keeps its documented meaning: the server starts and
 * the voice routes answer with the existing 500 `{ error }` envelope. */
export function createSpeechProviderRegistry(voice: VoiceConfig, options: {
  speechProvider?: SpeechProvider;
  speechProviders?: SpeechProvider[];
  defaultSpeechProviderId?: string;
} = {}) {
  if (options.speechProvider !== undefined && options.speechProviders !== undefined) {
    throw new Error("Supply either speechProvider or speechProviders, not both.");
  }
  const providers = new Map<string, SpeechProvider>();
  const register = (value: SpeechProvider) => {
    assertSpeechProvider(value);
    if (providers.has(value.id)) throw new Error(`Duplicate SpeechProvider id "${value.id}".`);
    providers.set(value.id, Object.freeze({
      id: value.id,
      ...(value.label !== undefined ? { label: value.label } : {}),
      ...(value.destination !== undefined ? { destination: value.destination } : {}),
      capabilities: Object.freeze(speechCapabilities(value)),
      createSession: value.createSession.bind(value),
      ...(value.transcribeRecording ? { transcribeRecording: value.transcribeRecording.bind(value) } : {}),
    }));
  };
  const supplied = options.speechProvider;
  let legacyError: Error | null = null;
  const defer = (fn: () => void) => { try { fn(); } catch (error) { legacyError ??= error instanceof Error ? error : new Error(String(error)); } };
  if (supplied !== undefined) {
    defer(() => register(supplied));
    defer(() => {
      if (voice.provider && voice.provider !== supplied.id) {
        throw new Error(`VOICE_PROVIDER="${voice.provider}" does not match supplied SpeechProvider "${supplied.id}".`);
      }
    });
  } else {
    for (const value of configuredSpeechProviders(voice)) register(value);
    for (const value of options.speechProviders ?? []) register(value);
  }
  if (options.defaultSpeechProviderId !== undefined && !providers.has(options.defaultSpeechProviderId)) {
    throw new Error(`defaultSpeechProviderId "${options.defaultSpeechProviderId}" is not a registered speech provider.`);
  }
  const host = options.defaultSpeechProviderId ?? supplied?.id ?? voice.provider ?? (providers.has("deepgram") ? "deepgram" : null);
  if (legacyError === null && host !== null && !providers.has(host)) {
    legacyError = host === "deepgram" ? new Error("VOICE_PROVIDER=deepgram but DEEPGRAM_API_KEY is not set.")
      : host === "gemini" ? new Error("VOICE_PROVIDER=gemini but GEMINI_API_KEY is not set.")
      : new Error(`Unknown VOICE_PROVIDER="${host}" (expected a registered speech provider: ${[...providers.keys()].join(", ") || "none"}).`);
  }
  const failed = (): never => { throw legacyError!; };
  const discovery = (settings: DictationSettings): VoiceProvidersResponse => {
    if (legacyError) failed();
    const saved = settings.defaultProvider;
    const savedUsable = saved !== null && providers.has(saved);
    const effective = saved !== null ? savedUsable ? saved : null : host ?? (providers.size === 1 ? providers.keys().next().value! : null);
    const source = saved !== null ? savedUsable ? "saved" : "unavailable" : host !== null ? "host" : effective !== null ? "only" : "none";
    return {
      providers: [...providers.values()].map(provider => ({ id: provider.id, label: provider.label ?? provider.id,
        ...(provider.destination !== undefined ? { destination: provider.destination } : {}), capabilities: { ...provider.capabilities } })),
      dictation: { saved, savedUsable, host, effective, source, smart: settings.smart, revision: settings.revision },
    };
  };
  return {
    has: (id: string) => legacyError === null && providers.has(id),
    get: (id: string): SpeechProvider | undefined => legacyError ? failed() : providers.get(id),
    discovery,
    effective(settings: DictationSettings): SpeechProvider {
      const id = discovery(settings).dictation.effective;
      if (id !== null) return providers.get(id)!;
      // Preserve the original unconfigured-client error text.
      if (!providers.size && settings.defaultProvider === null) throw new Error(NO_SPEECH_PROVIDER);
      throw new Error("No effective speech provider. Choose an available dictation service in Settings.");
    },
  };
}
export type SpeechProviderRegistry = ReturnType<typeof createSpeechProviderRegistry>;
