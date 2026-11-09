/**
 * Gemini 3.5 Transcribe Live dictation, server side (#3708).
 *
 * The long-lived GEMINI_API_KEY never leaves this closure. Each take mints one
 * single-use ephemeral token through the REST `auth_tokens` endpoint, whose
 * `bidiGenerateContentSetup` and `fieldMask` lock the model, the TEXT modality
 * and the transcription configuration, so a browser holding the token cannot
 * open any other Live session with it. No SDK dependency: the body is the REST
 * AuthToken that @google/genai 2.24.0 serializes for `authTokens.create`
 * (`liveConnectConstraints` and `lockAdditionalFields` are SDK option names,
 * not wire fields), as `gemini-conversation.ts` speaks the Live wire directly.
 *
 * Errors never carry the key or Google's response text: every failure is the
 * one message below, which the session route returns in its 500 envelope.
 * No session resumption: a take ends at Google's 10-minute session limit
 * through the client's provider-ended path. Design:
 * docs/plans/selectable-dictation.md §6.
 */

import type { SpeechProvider, SpeechSession } from "@schlessera/brain-ui-sdk/server";
import { defineSpeechProvider } from "@schlessera/brain-ui-sdk/server";

export const GEMINI_AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
// The installed @google/genai 2.24.0 connects ephemeral tokens to this v1alpha
// constrained endpoint; Google's token guide says v1beta. #3710 qualifies which
// one Google accepts. The server mints the URL, so a correction is server-only.
export const GEMINI_TRANSCRIBE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
export const GEMINI_TRANSCRIBE_MODEL = "models/gemini-3.5-transcribe-live";
export const GEMINI_SESSION_FAILED = "Gemini dictation session failed";

/** Connect window for the token (`newSessionExpireTime`), also the session's `expiresAt`. */
const NEW_SESSION_MS = 60_000;
/** Overall token lifetime (`expireTime`): Google's 10-minute session plus margin. */
const TOKEN_MS = 11 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GEMINI_MAX_VOCABULARY_TERMS = 100;
const GEMINI_MAX_TERM_BYTES = 64;
/**
 * Fixed language hint, matching Deepgram's `language: "en"` and browser
 * speech's `en-US` default. Without it Google auto-detects, and #3710 measured
 * a short English segment returned as Spanish (#3769). A hint biases
 * recognition; it does not restrict it.
 */
const GEMINI_LANGUAGE_CODES: readonly string[] = ["en-US"];
// Google's token resource name; anything else is not connection material.
const TOKEN_NAME = /^auth_tokens\/[\x21-\x7e]{1,1024}$/;

const encoder = new TextEncoder();

/** The existing bounded keyterms: at most 100 nonempty terms of at most 64 UTF-8 bytes each, in order. */
function geminiVocabulary(keyterms: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of keyterms) {
    if (terms.length >= GEMINI_MAX_VOCABULARY_TERMS) break;
    const term = typeof raw === "string" ? raw.trim() : "";
    if (!term || seen.has(term) || encoder.encode(term).byteLength > GEMINI_MAX_TERM_BYTES) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/**
 * The Live setup the token locks, which the browser's `setup` frame repeats
 * field for field (`GeminiAsrClient`), and the field mask naming exactly the
 * fields present: an empty vocabulary is neither set nor locked.
 */
function geminiLockedSetup(vocabulary: readonly string[], mode: "SMART" | "VERBATIM") {
  const setup = {
    model: GEMINI_TRANSCRIBE_MODEL,
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: { mode, languageCodes: [...GEMINI_LANGUAGE_CODES], ...(vocabulary.length ? { customVocabulary: [...vocabulary] } : {}) },
  };
  const fieldMask = ["model", "generationConfig.responseModalities", "inputAudioTranscription.mode", "inputAudioTranscription.languageCodes", ...(vocabulary.length ? ["inputAudioTranscription.customVocabulary"] : [])].join(",");
  return { setup, fieldMask };
}

export function createGeminiSpeechProvider(apiKey: string): SpeechProvider {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Gemini dictation requires GEMINI_API_KEY.");
  return defineSpeechProvider({
    id: "gemini",
    label: "Google Gemini 3.5 Transcribe Live",
    destination: "Microphone audio streams from this browser to Google (gemini-3.5-transcribe-live).",
    capabilities: {
      streaming: true,
      interimResults: true,
      keyterms: true,
      // Manual Done: pauses still commit finals, but the take does not end on one.
      endpointing: false,
      smartTranscription: true,
    },
    async createSession({ keyterms, mode }): Promise<SpeechSession> {
      // SMART is the default (D1); only an explicit verbatim request turns it off.
      const wireMode = mode === "verbatim" ? "VERBATIM" : "SMART";
      const vocabulary = geminiVocabulary(keyterms);
      const now = Date.now();
      const { setup, fieldMask } = geminiLockedSetup(vocabulary, wireMode);
      const body = {
        expireTime: new Date(now + TOKEN_MS).toISOString(),
        newSessionExpireTime: new Date(now + NEW_SESSION_MS).toISOString(),
        uses: 1,
        bidiGenerateContentSetup: setup,
        fieldMask,
      };
      let response: Response;
      try {
        response = await fetch(GEMINI_AUTH_TOKENS_URL, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new Error(GEMINI_SESSION_FAILED);
      }
      if (!response.ok) {
        // Google's error text may echo request details; it is never read.
        await response.body?.cancel().catch(() => {});
        throw new Error(GEMINI_SESSION_FAILED);
      }
      let name: unknown;
      try { name = ((await response.json()) as { name?: unknown } | null)?.name; } catch { throw new Error(GEMINI_SESSION_FAILED); }
      if (typeof name !== "string" || !TOKEN_NAME.test(name)) throw new Error(GEMINI_SESSION_FAILED);
      return {
        url: GEMINI_TRANSCRIBE_URL,
        token: name,
        expiresAt: now + NEW_SESSION_MS,
        params: {
          model: GEMINI_TRANSCRIBE_MODEL,
          mode: wireMode,
          sampleRate: "16000",
          vocabulary: JSON.stringify(vocabulary),
          languageCodes: JSON.stringify(GEMINI_LANGUAGE_CODES),
        },
      };
    },
  });
}
