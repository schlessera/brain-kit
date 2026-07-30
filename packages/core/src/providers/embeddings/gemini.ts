/**
 * Gemini embedding provider — built-in EmbeddingProvider #1.
 *
 * Ported from the reference brain's embedder, trimmed to embeddings only:
 * asset description and chunk-context generation now live in enrichment.ts on
 * top of a CompletionProvider, per plan/04 §1. Retrieval asymmetry, batching,
 * retry/backoff, and the GOOGLE_API_KEY-suppression hack are preserved verbatim.
 */

import type { EmbeddingProvider } from "../../lib/seams.js";
import { withRetry } from "../../lib/llm-util.js";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../../lib/llm-defaults.js";

const TEXT_BATCH_SIZE = 100;

// gemini-embedding-2 (GA) has no taskType parameter. Retrieval asymmetry is
// expressed through prompt prefixes instead (per the Gemini embeddings docs):
//   documents: "title: {title} | text: {content}"
//   queries:   "task: search result | query: {content}"
// Chunk texts already open with their document title, so documents use the
// title-less form. Multimodal inputs (image/PDF parts) are passed without a
// prefix, matching the documented request shape.
const docPrompt = (text: string) => `title: none | text: ${text}`;
const queryPrompt = (text: string) => `task: search result | query: ${text}`;

export interface GeminiEmbeddingConfig {
  /** Embedding model name (default: gemini-embedding-2). */
  model?: string;
  /** Env var holding the API key (default: GEMINI_API_KEY). */
  apiKeyEnv?: string;
  /** Output dimensionality (default: 1536). */
  dimensions?: number;
}

/**
 * Create a Gemini-backed EmbeddingProvider.
 *
 * Lazy initialization: the GenAI client is not created until the first call,
 * avoiding import overhead when embeddings aren't needed. Constructing the
 * provider makes no API call, so resolving it without a key is safe — the
 * key is only required when an embed() actually runs.
 */
export function geminiEmbeddings(config: GeminiEmbeddingConfig = {}): EmbeddingProvider {
  const model = config.model ?? EMBEDDING_MODEL;
  const dimensions = config.dimensions ?? EMBEDDING_DIMENSIONS;
  const apiKeyEnv = config.apiKeyEnv ?? "GEMINI_API_KEY";

  let client: any = null;

  async function getClient() {
    if (!client) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `${apiKeyEnv} environment variable is required for Gemini embeddings`
        );
      }

      // Temporarily unset GOOGLE_API_KEY to suppress the SDK's
      // "Both GOOGLE_API_KEY and GEMINI_API_KEY are set" warning.
      const savedGoogleKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      const { GoogleGenAI } = await import("@google/genai").catch(() => {
        throw new Error(
          "@google/genai is not installed — it is an optional peer dependency " +
            "of @endoxa/core used only by the built-in Gemini providers. " +
            "Install it with `bun add @google/genai`."
        );
      });
      client = new GoogleGenAI({ apiKey });
      if (savedGoogleKey) process.env.GOOGLE_API_KEY = savedGoogleKey;
    }
    return client;
  }

  async function embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const ai = await getClient();
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += TEXT_BATCH_SIZE) {
      const batch = texts.slice(i, i + TEXT_BATCH_SIZE);

      // Each text must be its own Content object: gemini-embedding-2
      // AGGREGATES a plain string array into a single embedding (unlike the
      // preview model, which returned one embedding per string).
      const response: any = await withRetry(() =>
        ai.models.embedContent({
          model,
          contents: batch.map((text) => ({ parts: [{ text: docPrompt(text) }] })),
          config: {
            outputDimensionality: dimensions,
          },
        })
      );

      if (response.embeddings.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch: sent ${batch.length} texts, got ${response.embeddings.length} embeddings`
        );
      }
      for (const embedding of response.embeddings) {
        results.push(new Float32Array(embedding.values));
      }
    }

    return results;
  }

  async function embedQuery(text: string): Promise<Float32Array> {
    const ai = await getClient();

    const response: any = await withRetry(() =>
      ai.models.embedContent({
        model,
        contents: queryPrompt(text),
        config: {
          outputDimensionality: dimensions,
        },
      })
    );

    return new Float32Array(response.embeddings[0].values);
  }

  async function embedImage(
    buffer: Uint8Array,
    mimeType: string,
    description: string
  ): Promise<Float32Array> {
    const ai = await getClient();

    const response: any = await withRetry(() =>
      ai.models.embedContent({
        model,
        contents: [
          {
            parts: [
              { text: description },
              {
                inlineData: {
                  mimeType,
                  data: Buffer.from(buffer).toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          outputDimensionality: dimensions,
        },
      })
    );

    return new Float32Array(response.embeddings[0].values);
  }

  async function embedPdf(buffer: Uint8Array, description: string): Promise<Float32Array> {
    const ai = await getClient();

    const response: any = await withRetry(() =>
      ai.models.embedContent({
        model,
        contents: [
          {
            parts: [
              { text: description },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: Buffer.from(buffer).toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          outputDimensionality: dimensions,
        },
      })
    );

    return new Float32Array(response.embeddings[0].values);
  }

  return {
    id: `gemini:${model}`,
    dimensions,
    embed,
    embedQuery,
    embedImage,
    embedPdf,
  };
}
