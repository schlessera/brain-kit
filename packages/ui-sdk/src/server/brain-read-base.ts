import { z } from "zod";

/**
 * Budget for the page text of one `brain_read_base` result, in UTF-16 code
 * units once JSON-escaped. The Claude Agent SDK persists any tool result whose
 * text exceeds 50,000 characters to a file, and passes an MCP result through
 * uncounted while its length / 4 stays within half its 25,000-token default
 * (`MAX_MCP_OUTPUT_TOKENS`). 40,000 leaves room for the envelope fields.
 */
export const BRAIN_READ_BASE_PAGE_CHARS = 40_000;

export const brainReadBaseInput = z.object({
  path: z.string().min(1).max(1024),
  offset: z.number().int().min(1).optional()
    .describe("First line to return, 1-based. Giving offset, limit or column returns a page instead of the whole document."),
  limit: z.number().int().min(0).optional()
    .describe("Most lines to return; a page also stops at the result budget. 0 returns only the hash and size."),
  column: z.number().int().min(0).optional()
    .describe("Where to resume inside the offset line; pass the nextColumn of a page that ended mid-line."),
}).strict();
export type BrainReadBaseInput = z.infer<typeof brainReadBaseInput>;

export const BRAIN_READ_BASE_DESCRIPTION =
  "Read a Markdown document's exact SHA-256 base for a hosted edit. expectedBaseHash is always the hash of the whole " +
  "document. A document that fits one result returns as content; a larger one, or any call with offset/limit, " +
  "returns a page of lines as text with nextOffset (and nextColumn) to continue. limit: 0 returns only the hash and size.";

interface Totals { expectedBaseHash: string; bytes: number; lines: number }
/** The whole document, when it fits one result and no range was asked for. */
export interface BrainReadBaseWhole extends Totals { content: string }
/** One page of lines; concatenating every page's `text` reproduces the document. */
export interface BrainReadBasePage extends Totals {
  offset: number;
  /** Present when the page starts inside its first line. */
  column?: number;
  returnedLines: number;
  text: string;
  /** Line the next page starts at; absent once the page reaches the end. */
  nextOffset?: number;
  /** Present when the page ended inside a line longer than the budget. */
  nextColumn?: number;
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
  range: { offset?: number; limit?: number; column?: number } = {},
  budget: number = BRAIN_READ_BASE_PAGE_CHARS,
): BrainReadBaseResult {
  const lines = splitLines(base.content);
  const totals: Totals = { expectedBaseHash: base.expectedBaseHash, bytes: Buffer.byteLength(base.content, "utf8"), lines: lines.length };
  const ranged = range.offset !== undefined || range.limit !== undefined || range.column !== undefined;
  if (!ranged && escapedLength(base.content) <= budget) return { ...totals, content: base.content };
  const offset = range.offset ?? 1;
  const column = range.column ?? 0;
  const wanted = Math.min(range.limit ?? Number.POSITIVE_INFINITY, Math.max(0, lines.length - offset + 1));
  const taken: string[] = [];
  let used = 0;
  let nextColumn: number | undefined;
  for (let i = 0; i < wanted; i++) {
    const start = i === 0 ? column : 0;
    const line = lines[offset - 1 + i]!.slice(start);
    const size = escapedLength(line);
    if (used + size <= budget) { taken.push(line); used += size; continue; }
    if (taken.length === 0) {
      // A line longer than the whole budget: return its fitting prefix, cut on
      // a code point, and resume inside the same line on the next page.
      let end = 0;
      for (const point of line) {
        const cost = escapedLength(point);
        if (used + cost > budget) break;
        end += point.length; used += cost;
      }
      taken.push(line.slice(0, end)); nextColumn = start + end;
    }
    break;
  }
  const next = nextColumn === undefined ? offset + taken.length : offset + taken.length - 1;
  const more = next <= lines.length;
  return {
    ...totals, offset, ...(column > 0 ? { column } : {}), returnedLines: taken.length, text: taken.join(""),
    ...(more ? { nextOffset: next } : {}),
    ...(nextColumn !== undefined ? { nextColumn } : {}),
    ...(!ranged ? { hint: "The document is too large for one result, so this is its first page." +
      (more ? ` Call brain_read_base again with offset: ${next}${nextColumn !== undefined ? ` and column: ${nextColumn}` : ""} to continue.` : "") } : {}),
  };
}
