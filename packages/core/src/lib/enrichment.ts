/**
 * Enrichment — generation concerns split out of EmbeddingProvider.
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
   * document, prepended before embedding. The document half of the prompt is
   * bounded (see `documentForChunk`), the chunk half truncated — enough for
   * situating, cheap on tokens. `docSummary` is the document's frontmatter
   * summary, used only for a document too long to send whole.
   */
  generateChunkContext(
    docTitle: string,
    docText: string,
    chunkHeading: string,
    chunkContent: string,
    docSummary?: string | null
  ): Promise<string>;
}

/** Characters of document the chunk-context prompt carries at most. */
export const CONTEXT_DOCUMENT_BUDGET = 8000;
/** Of that budget, at most this much goes to the summary, and this much to the outline. */
const SUMMARY_BUDGET = 600;
const OUTLINE_BUDGET = 1800;

/** The first `max` characters, cut back to a line boundary when there is one. */
function clipLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/**
 * The document half of the chunk-context prompt.
 *
 * A document within the budget is sent whole, exactly as before. A longer one
 * used to be cut to its first 8,000 characters, so a chunk past that point was
 * situated without seeing any of its own surroundings. It now gets the
 * summary, the outline (every `##` and `###` heading, in order), and a window
 * of the text centred on the chunk, all within the same budget. Prompt caching
 * would let the whole document go, but the completion seam has no caching
 * surface; this needs no seam change.
 */
export function documentForChunk(
  docText: string,
  chunkContent: string,
  chunkHeading: string,
  docSummary?: string | null
): string {
  if (docText.length <= CONTEXT_DOCUMENT_BUDGET) return docText;

  const parts: string[] = [];
  const summary = docSummary?.trim();
  if (summary) parts.push(`Summary: ${summary.slice(0, SUMMARY_BUDGET)}`);
  const headings = docText
    .split("\n")
    .filter((line) => /^#{2,3}\s+\S/.test(line))
    .map((line) => line.trimEnd());
  if (headings.length > 0) parts.push(`Outline:\n${clipLines(headings.join("\n"), OUTLINE_BUDGET)}`);
  const label = "Excerpt around the chunk:\n";
  const head = parts.map((p) => `${p}\n\n`).join("");
  const room = CONTEXT_DOCUMENT_BUDGET - head.length - label.length;

  // Where the chunk sits: its own text when it appears verbatim, else its
  // heading line, else nowhere (the window then opens the document).
  let start = docText.indexOf(chunkContent.slice(0, 200));
  if (start === -1) {
    const heading = chunkHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    start = docText.search(new RegExp(`^#{2,3}\\s+${heading}\\s*$`, "m"));
  }
  if (start === -1) start = 0;
  const centre = start + Math.min(chunkContent.length, room) / 2;
  const from = Math.max(0, Math.min(Math.round(centre - room / 2), docText.length - room));
  return `${head}${label}${docText.slice(from, from + room)}`;
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
    chunkContent: string,
    docSummary?: string | null
  ): Promise<string> {
    const document = documentForChunk(docText, chunkContent, chunkHeading, docSummary);
    const text = await provider.complete({
      prompt:
        `<document title="${docTitle}">\n${document}\n</document>\n\n` +
        `<chunk heading="${chunkHeading}">\n${chunkContent.slice(0, 2000)}\n</chunk>\n\n` +
        `Write 1-2 short sentences situating this chunk within the overall document, ` +
        `to improve search retrieval of the chunk. Mention the document's subject and ` +
        `what this chunk covers. Answer with only the context sentences, nothing else.`,
    });

    return text.trim();
  }

  return { describeAsset, generateChunkContext };
}
