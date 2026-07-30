/**
 * Enrichment — generation concerns split out of EmbeddingProvider (plan/04 §1).
 *
 * Owns the product-level prompts (asset descriptions, contextual-retrieval
 * chunk contexts) and runs them through a configured CompletionProvider. The
 * prompts are ported verbatim from the reference brain's embedder so index
 * output is byte-identical for the same model.
 *
 * Degradation: a provider without vision cannot see the asset, so describeAsset
 * falls back to the asset title (the same title-only fallback the reference
 * used when the model returned nothing).
 */

import type { CompletionProvider, ContentPart } from "./seams.js";

export interface Enrichment {
  /**
   * Describe an image/PDF asset in 2-3 sentences for search indexing.
   * Returns the title verbatim when the provider has no vision capability.
   */
  describeAsset(buffer: Uint8Array, mimeType: string, context: string): Promise<string>;
  /**
   * Anthropic contextual-retrieval: a short blurb situating a chunk within its
   * document, prepended before embedding. Document/chunk text are truncated —
   * enough for situating, cheap on tokens.
   */
  generateChunkContext(
    docTitle: string,
    docText: string,
    chunkHeading: string,
    chunkContent: string
  ): Promise<string>;
}

/** Build an Enrichment backed by the given completion provider. */
export function createEnrichment(provider: CompletionProvider): Enrichment {
  async function describeAsset(
    buffer: Uint8Array,
    mimeType: string,
    context: string
  ): Promise<string> {
    // Degrade to a title-only description when the provider can't see the asset.
    if (!provider.capabilities.vision) return context;

    const part: ContentPart =
      mimeType === "application/pdf"
        ? { kind: "pdf", data: buffer }
        : { kind: "image", data: buffer, mimeType };

    const text = await provider.complete({
      prompt: `Context: this asset is titled "${context}".\n\nDescribe this image/document in 2-3 concise sentences for search indexing. Focus on what is depicted, any visible text, and the purpose of the asset.`,
      parts: [part],
    });

    return text.trim() || context;
  }

  async function generateChunkContext(
    docTitle: string,
    docText: string,
    chunkHeading: string,
    chunkContent: string
  ): Promise<string> {
    const text = await provider.complete({
      prompt:
        `<document title="${docTitle}">\n${docText.slice(0, 8000)}\n</document>\n\n` +
        `<chunk heading="${chunkHeading}">\n${chunkContent.slice(0, 2000)}\n</chunk>\n\n` +
        `Write 1-2 short sentences situating this chunk within the overall document, ` +
        `to improve search retrieval of the chunk. Mention the document's subject and ` +
        `what this chunk covers. Answer with only the context sentences, nothing else.`,
    });

    return text.trim();
  }

  return { describeAsset, generateChunkContext };
}
