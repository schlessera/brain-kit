/**
 * Enrichment — generation concerns split out of EmbeddingProvider.
 *
 * Owns the product-level prompts (asset descriptions, contextual-retrieval
 * chunk contexts) and runs them through a configured CompletionProvider. The
 * prompts are ported verbatim from the reference brain's embedder so index
 * output is byte-identical for the same model.
 *
 * Degradation: describeAsset returns null when the provider cannot see the
 * asset or answers with no text. The indexer keeps its placeholder for retry.
 */

import type { CompletionProvider, ContentPart } from "./seams.js";

export interface Enrichment {
  /**
   * Describe an image/PDF asset in 2-3 sentences for search indexing.
   * Returns null when the provider has no vision capability or answers with
   * empty/whitespace text. A non-empty description may equal the asset title.
   */
  describeAsset(buffer: Uint8Array, mimeType: string, context: string): Promise<string | null>;
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
/** Of that budget, the summary gets at most this much. */
const SUMMARY_BUDGET = 600;
/**
 * And the outline at most this much, half the budget, so the window around
 * the chunk always keeps the rest. An outline that fits is sent whole.
 */
export const OUTLINE_BUDGET = 4000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `text.slice(from, to)`, with each end moved inward rather than splitting a
 * surrogate pair. Half of an emoji is not valid UTF-16, and a provider may
 * reject the whole prompt or mangle it.
 */
function safeSlice(text: string, from: number, to: number): string {
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from))) from++;
  if (to < text.length && to > from && isHighSurrogate(text.charCodeAt(to - 1))) to--;
  return text.slice(from, to);
}

/**
 * The outline: every `##` and `###` heading, in order, whole when it fits in
 * `OUTLINE_BUDGET`. When it does not, the `###` headings go first. If the `##`
 * headings alone are still too long, the first and last ones are kept and the
 * middle is replaced by a line that says how many were left out, so the
 * reader always sees the outline's shape and knows it is incomplete.
 */
export function outlineOf(docText: string): string {
  const all = docText
    .split("\n")
    .filter((line) => /^#{2,3}\s+\S/.test(line))
    .map((line) => line.trimEnd());
  const fits = (lines: string[]) => lines.join("\n").length <= OUTLINE_BUDGET;
  if (fits(all)) return all.join("\n");
  const sections = all.filter((line) => line.startsWith("## "));
  if (fits(sections)) return sections.join("\n");

  const head: string[] = [];
  const tail: string[] = [];
  let i = 0;
  let j = sections.length - 1;
  const marker = (omitted: number) => `… ${omitted} more headings …`;
  // Take from both ends in turn while the result, marker included, still fits.
  for (let fromFront = true; i <= j; fromFront = !fromFront) {
    const next = fromFront ? sections[i] : sections[j];
    const trial = [...head, ...(fromFront ? [next] : []), marker(j - i), ...(fromFront ? [] : [next]), ...tail];
    if (!fits(trial)) break;
    if (fromFront) head.push(sections[i++]);
    else tail.unshift(sections[j--]);
  }
  return [...head, marker(j - i + 1), ...tail].join("\n");
}

/** Positions of the `##` heading lines, which is what the chunker splits on, with their text. */
function sectionHeadings(docText: string): Array<{ at: number; text: string }> {
  const found: Array<{ at: number; text: string }> = [];
  const pattern = /^##[ \t]+(.+?)[ \t]*$/gm;
  for (let m = pattern.exec(docText); m; m = pattern.exec(docText)) found.push({ at: m.index, text: m[1] });
  return found;
}

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  if (!needle) return at;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/**
 * Where the chunk starts in the document, or -1 when that cannot be told.
 *
 * Its full text first: that is exact, and unique in almost every document. A
 * candidate that is not unique (the full text repeated, or only a prefix
 * found, as for a chunk the chunker merged or split) counts only when it is
 * the one candidate under the chunk's own `##` heading. Failing that, the
 * heading line itself, if only one line carries it. Never simply the first of
 * several matches: that would situate the chunk in another section's text.
 */
export function locateChunk(docText: string, chunkContent: string, chunkHeading: string): number {
  const content = chunkContent.trim();
  const heading = chunkHeading.replace(/ \(cont\.\)$/, "").trim();
  const headings = sectionHeadings(docText);
  const headingAbove = (at: number) => {
    let text = "(intro)";
    for (const h of headings) {
      if (h.at > at) break;
      text = h.text;
    }
    return text;
  };
  const choose = (candidates: number[]): number | undefined => {
    if (candidates.length === 1) return candidates[0];
    const under = candidates.filter((at) => headingAbove(at) === heading);
    return under.length === 1 ? under[0] : undefined;
  };

  if (content) {
    const full = choose(occurrences(docText, content));
    if (full !== undefined) return full;
    const prefix = choose(occurrences(docText, content.slice(0, 200)));
    if (prefix !== undefined) return prefix;
  }
  const lines = headings.filter((h) => h.text === heading);
  return lines.length === 1 ? lines[0].at : -1;
}

/**
 * The document half of the chunk-context prompt.
 *
 * A document within the budget is sent whole, exactly as before. A longer one
 * used to be cut to its first 8,000 characters, so a chunk past that point was
 * situated without seeing any of its own surroundings. It now gets the
 * summary, the outline (`outlineOf`), and a window of the text centred on the
 * chunk (`locateChunk`), all within the same budget. When the chunk cannot be
 * located the window opens the document, as the old prompt did. Prompt caching
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
  if (summary) parts.push(`Summary: ${safeSlice(summary, 0, SUMMARY_BUDGET)}`);
  const outline = outlineOf(docText);
  if (outline) parts.push(`Outline:\n${outline}`);
  const label = "Excerpt around the chunk:\n";
  const head = parts.map((p) => `${p}\n\n`).join("");
  const room = CONTEXT_DOCUMENT_BUDGET - head.length - label.length;

  const start = locateChunk(docText, chunkContent, chunkHeading);
  let from = 0;
  if (start !== -1) {
    const centre = start + Math.min(chunkContent.length, room) / 2;
    from = Math.max(0, Math.min(Math.round(centre - room / 2), docText.length - room));
  }
  return `${head}${label}${safeSlice(docText, from, from + room)}`;
}

/** Build an Enrichment backed by the given completion provider. */
export function createEnrichment(provider: CompletionProvider): Enrichment {
  async function describeAsset(
    buffer: Uint8Array,
    mimeType: string,
    context: string
  ): Promise<string | null> {
    if (!provider.capabilities.vision) return null;

    const part: ContentPart =
      mimeType === "application/pdf"
        ? { kind: "pdf", data: buffer }
        : { kind: "image", data: buffer, mimeType };

    const text = await provider.complete({
      prompt: `Context: this asset is titled "${context}".\n\nDescribe this image/document in 2-3 concise sentences for search indexing. Focus on what is depicted, any visible text, and the purpose of the asset.`,
      parts: [part],
    });

    return text.trim() || null;
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
