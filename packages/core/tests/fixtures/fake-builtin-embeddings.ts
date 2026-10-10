/**
 * Preload for provider-availability.test.ts: registers a fake built-in
 * embedding provider whose key lives in a variable no other provider reads,
 * so a host that hard-codes a default key name leaves it switched off.
 */
import { EMBEDDING_PROVIDERS } from "../../src/lib/registry";
import { EMBEDDING_DIMENSIONS } from "../../src/lib/models";
import type { EmbeddingProvider } from "../../src/lib/seams";

export const FAKE_BUILTIN = "fake-builtin";
export const FAKE_KEY_ENV = "FAKE_BUILTIN_EMBEDDINGS_KEY";

const fake: EmbeddingProvider = {
  id: "fake-builtin-embeddings",
  dimensions: EMBEDDING_DIMENSIONS,
  async embed(texts) {
    return texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.125));
  },
  async embedQuery() {
    return new Float32Array(EMBEDDING_DIMENSIONS).fill(0.125);
  },
};

EMBEDDING_PROVIDERS[FAKE_BUILTIN] = { keyEnv: FAKE_KEY_ENV, create: () => fake };
