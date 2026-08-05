/**
 * Gemini completion provider — built-in CompletionProvider.
 *
 * Plain (non-agentic) completions via @google/genai. Vision-capable: image and
 * PDF ContentParts are passed inline. Call shape derived from the reference
 * brain's generateContent usage and whatsup's Gemini backend.
 */

import type { CompletionProvider, ContentPart } from "../../lib/seams.js";
import { withRetry } from "../../lib/llm-util.js";
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

/**
 * Create a Gemini-backed CompletionProvider. Lazy client init: constructing
 * the provider makes no API call; the key is read on first complete().
 */
export function geminiCompletions(config: GeminiCompletionConfig = {}): CompletionProvider {
  const model = config.model ?? GEMINI_FLASH_MODEL;
  const apiKeyEnv = config.apiKeyEnv ?? "GEMINI_API_KEY";

  let client: any = null;

  async function getClient() {
    if (!client) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        throw new Error(`${apiKeyEnv} environment variable is required for Gemini completions`);
      }
      // Suppress the SDK's dual-key warning (see embeddings provider).
      const savedGoogleKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const { GoogleGenAI } = await import("@google/genai").catch(() => {
        throw new Error(
          "@google/genai is not installed — it is an optional peer dependency " +
            "of @schlessera/brain used only by the built-in Gemini providers. " +
            "Install it with `bun add @google/genai`."
        );
      });
      client = new GoogleGenAI({ apiKey });
      if (savedGoogleKey) process.env.GOOGLE_API_KEY = savedGoogleKey;
    }
    return client;
  }

  async function complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
  }): Promise<string> {
    const ai = await getClient();

    // Media parts precede the prompt text (context before instruction),
    // matching the reference asset-description ordering.
    const parts = [...(req.parts ?? []).map(toGeminiPart), { text: req.prompt }];

    const genConfig: Record<string, unknown> = {};
    if (req.system) genConfig.systemInstruction = req.system;
    if (req.maxTokens !== undefined) genConfig.maxOutputTokens = req.maxTokens;

    const response: any = await withRetry(() =>
      ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        ...(Object.keys(genConfig).length > 0 ? { config: genConfig } : {}),
      })
    );

    return response.text ?? "";
  }

  return {
    id: `gemini:${model}`,
    capabilities: { vision: true },
    complete,
  };
}
