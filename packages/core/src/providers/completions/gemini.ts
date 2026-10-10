/**
 * Gemini completion provider — built-in CompletionProvider.
 *
 * Plain (non-agentic) completions via @google/genai. Vision-capable: image and
 * PDF ContentParts are passed inline. Call shape derived from the reference
 * brain's generateContent usage and whatsup's Gemini backend.
 */

import { readEnvVar } from "../../config/env.js";
import type { CompletionProvider, ContentPart } from "../../lib/seams.js";
import { withRetry } from "../../lib/llm-util.js";
import { withVideoFiles } from "./video.js";
import { GEMINI_FLASH_MODEL } from "../../lib/llm-defaults.js";

export interface GeminiCompletionConfig {
  /** Generation model (default: gemini-3-flash-preview). */
  model?: string;
  /** Env var holding the API key (default: GEMINI_API_KEY). */
  apiKeyEnv?: string;
}

/** Convert a neutral ContentPart to a Gemini `Part`. */
function toGeminiPart(part: ContentPart): Record<string, unknown> {
  switch (part.kind) {
    case "video": {
      if (!("uri" in part)) throw new Error("Local video must be uploaded before generation");
      return {
        fileData: { fileUri: part.uri, mimeType: part.mimeType },
        ...(part.clip ? { videoMetadata: {
          ...(part.clip.start !== undefined ? { startOffset: `${part.clip.start}s` } : {}),
          ...(part.clip.end !== undefined ? { endOffset: `${part.clip.end}s` } : {}),
        } } : {}),
      };
    }
    case "text":
      return { text: part.text };
    case "image":
      return {
        inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64") },
      };
    case "pdf":
      return {
        inlineData: { mimeType: "application/pdf", data: Buffer.from(part.data).toString("base64") },
      };
  }
}

/** Env var the Gemini completion provider reads its key from by default. */
export const GEMINI_COMPLETIONS_KEY_ENV = "GEMINI_API_KEY";

/**
 * Create a Gemini-backed CompletionProvider. Lazy client init: constructing
 * the provider makes no API call; the key is read on first complete().
 */
export function geminiCompletions(config: GeminiCompletionConfig = {}): CompletionProvider {
  const model = config.model ?? GEMINI_FLASH_MODEL;
  const apiKeyEnv = config.apiKeyEnv ?? GEMINI_COMPLETIONS_KEY_ENV;

  let client: any = null;

  async function getClient(signal?: AbortSignal) {
    if (!client || signal) {
      const apiKey = readEnvVar(apiKeyEnv);
      if (!apiKey) {
        throw new Error(`${apiKeyEnv} environment variable is required for Gemini completions`);
      }
      const { GoogleGenAI } = await import("@google/genai").catch(() => {
        throw new Error(
          "@google/genai is not installed — it is an optional peer dependency " +
            "of @schlessera/brain used only by the built-in Gemini providers. " +
            "Install it with `bun add @google/genai`."
        );
      });
      // The SDK may log a cosmetic dual-key warning when both GOOGLE_API_KEY
      // and GEMINI_API_KEY are set; the explicit apiKey option still wins
      // (see embeddings provider for the evidence).
      const created = new GoogleGenAI({ apiKey, ...(signal ? { httpOptions: {
        // The SDK uploader ignores per-call abortSignal. Bind every HTTP request,
        // including binary upload requests, at client level instead.
        fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, {
          ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      } } : {}) });
      if (signal) return created;
      client = created;
    }
    return client;
  }

  async function complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    req.signal?.throwIfAborted();
    const hasVideo = req.parts?.some((part) => part.kind === "video") ?? false;
    const signal = hasVideo ? (req.signal ?? AbortSignal.timeout(300_000)) : req.signal;
    const ai = await getClient(signal);
    const generate = async (media: ContentPart[]): Promise<string> => {
      signal?.throwIfAborted();
      const parts = [...media.map(toGeminiPart), { text: req.prompt }];
      const genConfig: Record<string, unknown> = {};
      if (req.system) genConfig.systemInstruction = req.system;
      if (req.maxTokens !== undefined) genConfig.maxOutputTokens = req.maxTokens;
      if (signal) genConfig.abortSignal = signal;
      const call = () => ai.models.generateContent({
        model, contents: [{ role: "user", parts }],
        ...(Object.keys(genConfig).length ? { config: genConfig } : {}),
      });
      // A video call has one bounded attempt. No retry or provider fallback
      // after uploading potentially sensitive content.
      const response = hasVideo ? await call() : await withRetry(call);
      signal?.throwIfAborted();
      return response.text ?? "";
    };
    if (!hasVideo) return generate(req.parts ?? []);
    return withVideoFiles(ai, req.parts ?? [], signal!, generate);
  }

  return {
    id: `gemini:${model}`,
    capabilities: { vision: true, video: true },
    complete,
  };
}
