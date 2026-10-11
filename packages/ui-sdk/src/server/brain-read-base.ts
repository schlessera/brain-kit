import { z } from "zod";

/**
 * Serialized-result budget for one `brain_read_base` result, in UTF-16 code
 * units of the JSON text. The Claude Agent SDK passes an MCP result through
 * untouched while its length / 4 stays within half its token limit (25,000
 * by default, so 50,000 characters); above that it counts tokens and spills an
 * over-limit result to a file. 40,000 leaves room for the envelope fields.
 */
export const BRAIN_READ_BASE_PAGE_CHARS = 40_000;

export const brainReadBaseInput = z.object({
  path: z.string().min(1).max(1024),
  offset: z.number().int().min(1).optional()
    .describe("First line to return, 1-based. Giving offset or limit returns a page instead of the whole document."),
  limit: z.number().int().min(0).optional()
    .describe("Most lines to return; a page also stops at the result budget. 0 returns only the hash and size."),
}).strict();
export type BrainReadBaseInput = z.infer<typeof brainReadBaseInput>;

export const BRAIN_READ_BASE_DESCRIPTION =
  "Read a Markdown document's exact SHA-256 base for a hosted edit. expectedBaseHash is always the hash of the whole " +
  "document. A document that fits one result returns as content; a larger one, or any call with offset/limit, " +
  "returns a page of lines as text with nextOffset to continue. limit: 0 returns only the hash and size.";

interface Totals { expectedBaseHash: string; bytes: number; lines: number }
/** The whole document, when it fits one result and no range was asked for. */
export interface BrainReadBaseWhole extends Totals { content: string }
/** One page of lines; concatenating every page's `text` reproduces the document. */
export interface BrainReadBasePage extends Totals {
  offset: number;
  returnedLines: number;
  text: string;
  /** First line of the next page; absent once the page reaches the end. */
  nextOffset?: number;
  /** The page's only line was longer than the budget and was cut. */
  truncated?: true;
  /** Present when an unranged read was too large to return whole. */
  hint?: string;
}
export type BrainReadBaseResult = BrainReadBaseWhole | BrainReadBasePage;

/** Lines with their terminators kept, so a page is an exact slice. */
function splitLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
const escapedLength = (text: string) => JSON.stringify(text).length - 2;

/**
 * Shape a server base for an agent. The hash is the server's hash of the whole
 * document on every result, never of a page, so the write tools' base guard is
 * unchanged. `expectedBaseHash` serializes first so it survives any clipping.
 */
export function brainReadBaseResult(
  base: { content: string; expectedBaseHash: string },
  range: { offset?: number; limit?: number } = {},
  budget: number = BRAIN_READ_BASE_PAGE_CHARS,
): BrainReadBaseResult {
  const lines = splitLines(base.content);
  const totals: Totals = { expectedBaseHash: base.expectedBaseHash, bytes: Buffer.byteLength(base.content, "utf8"), lines: lines.length };
  const ranged = range.offset !== undefined || range.limit !== undefined;
  if (!ranged && escapedLength(base.content) <= budget) return { ...totals, content: base.content };
  const offset = range.offset ?? 1;
  const wanted = Math.min(range.limit ?? Number.POSITIVE_INFINITY, Math.max(0, lines.length - offset + 1));
  const taken: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = 0; i < wanted; i++) {
    const line = lines[offset - 1 + i]!;
    const size = escapedLength(line);
    if (used + size <= budget) { taken.push(line); used += size; continue; }
    if (taken.length === 0) {
      // A single line larger than the whole budget: return its fitting prefix.
      let cut = "";
      for (const point of line) {
        const next = escapedLength(point);
        if (used + next > budget) break;
        cut += point; used += next;
      }
      taken.push(cut); truncated = true;
    }
    break;
  }
  const next = offset + taken.length;
  const more = next <= lines.length;
  return {
    ...totals, offset, returnedLines: taken.length, text: taken.join(""),
    ...(more ? { nextOffset: next } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    ...(!ranged ? { hint: "The document is too large for one result, so this is its first page." +
      (more ? ` Call brain_read_base again with offset: ${next} to continue.` : "") } : {}),
  };
}
