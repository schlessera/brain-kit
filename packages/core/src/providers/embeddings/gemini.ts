/**
 * Gemini embedding provider — built-in EmbeddingProvider #1.
 *
 * Ported from the reference brain's embedder, trimmed to embeddings only:
 * asset description and chunk-context generation now live in enrichment.ts on
 * top of a CompletionProvider. Retrieval asymmetry, batching, and
 * retry/backoff are preserved verbatim.
 */

import { readEnvVar } from "../../config/env.js";
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
/** Env var the Gemini embedding provider reads its key from by default. */
export const GEMINI_EMBEDDINGS_KEY_ENV = "GEMINI_API_KEY";

export function geminiEmbeddings(config: GeminiEmbeddingConfig = {}): EmbeddingProvider {
  const model = config.model ?? EMBEDDING_MODEL;
  const dimensions = config.dimensions ?? EMBEDDING_DIMENSIONS;
  const apiKeyEnv = config.apiKeyEnv ?? GEMINI_EMBEDDINGS_KEY_ENV;

  let client: any = null;

  async function getClient() {
    if (!client) {
      const apiKey = readEnvVar(apiKeyEnv);
      if (!apiKey) {
        throw new Error(
          `${apiKeyEnv} environment variable is required for Gemini embeddings`
        );
      }

      const { GoogleGenAI } = await import("@google/genai").catch(() => {
        throw new Error(
          "@google/genai is not installed — it is an optional peer dependency " +
            "of @schlessera/brain used only by the built-in Gemini providers. " +
            "Install it with `bun add @google/genai`."
        );
      });
      // When both GOOGLE_API_KEY and GEMINI_API_KEY are set, the SDK logs a
      // one-line "using GOOGLE_API_KEY" warning from its constructor even
      // though the explicit `apiKey` option below is what actually wins
      // (verified against @google/genai 2.17.1: getApiKeyFromEnv() runs
      // unconditionally). Cosmetic, so we accept it — the old delete/restore
      // of GOOGLE_API_KEY was a process-global mutation spanning an await.
      client = new GoogleGenAI({ apiKey });
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

  async function embedQuery(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array> {
    const ai = await getClient();

    opts?.signal?.throwIfAborted();
    // Interactive queries must not inherit the indexing retry schedule. The
    // search deadline cancels this request; transient failures degrade to FTS.
    const response = await ai.models.embedContent({
      model,
      contents: queryPrompt(text),
      config: {
        outputDimensionality: dimensions,
        abortSignal: opts?.signal,
      },
    });

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
