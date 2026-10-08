import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { SpeechTranscriptionError, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import type { TranscriptionFailure } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import type { VoiceConfig } from "../config/env.js";
import { getKeyterms, type KeytermSettings } from "../voice/keyterm-builder.js";
import { pickSpeechProvider, speechCapabilities } from "../voice/speech-providers.js";
import { refuse, TranscriptionError, type TranscriptionStore } from "../voice/transcription-store.js";

// V1-derived byte budget for ten minutes; documented with the measurement receipt.
export const MAX_TRANSCRIPTION_BYTES = 10_041_155;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MEDIA = /^audio\/(?:webm|ogg|mp4)(?:\s*;\s*codecs\s*=\s*(?:opus|"opus"))?$/i;
const PROVIDER_TIMEOUT_MS = 11 * 60 * 1000;

/** An HTTP rejection is definitive. An error without that evidence is unknown. */
export function transcriptionFailure(error: unknown): TranscriptionFailure {
  if (!(error instanceof SpeechTranscriptionError)) return { reason: "outcome_unknown", retryable: false };
  const status = error.providerStatus;
  const reasons = ["provider_error", "rate_limit", "provider_timeout", "media", "parameters", "validation", "authentication", "outcome_unknown"];
  if (!reasons.includes(error.reason) || status !== undefined && (!Number.isInteger(status) || status < 400 || status > 599)) return { reason: "outcome_unknown", retryable: false };
  // Explicit terminal evidence wins even if an adapter also supplies a
  // contradictory transient status. HTTP rejections can only constrain retries.
  if (["outcome_unknown", "authentication", "media", "parameters", "validation"].includes(error.reason)) return { reason: error.reason, retryable: false, ...(status !== undefined ? { providerStatus: status } : {}) };
  const reason = status === 401 || status === 403 ? "authentication"
    : status === 429 ? "rate_limit" : status === 408 || status === 504 ? "provider_timeout"
    : status !== undefined && status >= 500 && status <= 599 ? "provider_error"
    : status !== undefined && status >= 400 && status <= 499
      ? ["media", "parameters", "validation"].includes(error.reason) ? error.reason : "validation"
      : error.reason;
  const retryable = reason === "provider_error" || reason === "rate_limit" || reason === "provider_timeout";
  return { reason, retryable, ...(status !== undefined ? { providerStatus: status } : {}) };
}
async function readAudio(c: Context<AppEnv>): Promise<Uint8Array> {
  if (Number(c.req.header("content-length")) > MAX_TRANSCRIPTION_BYTES) return refuse(413, "recording_too_large", "The recording exceeds the upload byte budget.");
  const reader = c.req.raw.body?.getReader();
  if (!reader) return refuse(400, "recording_empty", "The recording is empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TRANSCRIPTION_BYTES) return refuse(413, "recording_too_large", "The recording exceeds the upload byte budget.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!bytes) return refuse(400, "recording_empty", "The recording is empty.");
  return new Uint8Array(Buffer.concat(chunks, bytes));
}
export function createTranscriptionRoutes(deps: {
  store: TranscriptionStore; voice: VoiceConfig; keyterms: KeytermSettings; speechProvider?: SpeechProvider;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const run = (handler: (c: Context<AppEnv>, principalId: string, id: string) => Promise<Response>) => async (c: Context<AppEnv>) => {
    c.header("Cache-Control", "no-store");
    try {
      const principal = c.get("principal");
      if (!principal) return refuse(401, "authentication_required", "Sign in again.");
      deps.store.authorize(principal.id);
      const id = (c.req.param("recordingId") ?? "").toLowerCase();
      if (!ID.test(id)) return refuse(400, "recording_id_invalid", "Use a recording UUID.");
      return await handler(c, principal.id, id);
    } catch (error) {
      if (error instanceof TranscriptionError) return c.json(error.body, error.status);
      // No provider messages/credentials are reflected in saved-audio errors.
      return c.json({ error: "transcription_request_failed", message: "Could not complete the transcription request. Check its status before retrying." }, 500);
    }
  };
  const path = "/voice/recordings/:recordingId/transcription";
  app.get(path, run(async (c, principalId, id) => c.json(deps.store.get(principalId, id))));
  app.delete(path, run(async (c, principalId, id) => {
    const disposition = c.req.query("disposition");
    if (disposition !== "accepted" && disposition !== "discarded") return refuse(400, "transcription_disposition_invalid", "Choose accepted or discarded.");
    return c.json(deps.store.remove(principalId, id, disposition));
  }));
  app.put(path, run(async (c, principalId, id) => {
    const provider = pickSpeechProvider(deps.voice, deps.speechProvider);
    if (!speechCapabilities(provider).savedAudio) return refuse(501, "saved_audio_unsupported", "Saved-audio transcription is unavailable.");
    const contentType = c.req.header("content-type") ?? "";
    if (!MEDIA.test(contentType)) return refuse(415, "recording_media_unsupported", "Upload a WebM, Ogg or MP4 audio container.");
    const suppliedHash = c.req.header("content-sha256") ?? "";
    if (!HASH.test(suppliedHash)) return refuse(400, "recording_hash_invalid", "Send the recording's SHA-256 hash.");
    const audio = await readAudio(c);
    const hash = createHash("sha256").update(audio).digest("hex");
    if (suppliedHash !== hash) return refuse(400, "recording_hash_invalid", "The hash does not match the uploaded bytes.");
    // Build before the claim: a local builder failure must not strand dispatch.
    const keyterms = provider.capabilities.keyterms ? getKeyterms(deps.keyterms, false).keyterms : [];
    const claim = deps.store.claim(principalId, id, hash, provider.id, c.req.query("retry"));
    if (!claim.dispatch) return c.json(claim.receipt);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { text: string } | { failure: TranscriptionFailure };
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Unknown provider outcome")); }, PROVIDER_TIMEOUT_MS); });
      const answer = await Promise.race([provider.transcribeRecording!({ audio, contentType, keyterms, signal: controller.signal }), timeout]);
      if (!answer || typeof answer.text !== "string" || !answer.text.trim() || new TextEncoder().encode(answer.text).length > 64 * 1024) throw new Error("Invalid provider response");
      result = { text: answer.text };
    } catch (error) { result = { failure: transcriptionFailure(error) }; }
    finally { clearTimeout(timer); }
    const stored = deps.store.complete(id, claim.receipt.attemptId, result);
    // Authentication can expire while the provider works. Keep the receipt,
    // but never expose its private result through an expired credential.
    deps.store.authorize(principalId);
    return c.json(stored);
  }));
  return app;
}
