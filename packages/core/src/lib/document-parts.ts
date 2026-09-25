import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { caseFold } from "./case-fold.js";
import { estimateTokens } from "./chunker.js";

/**
 * Read part of a markdown document: the whole file, one section, or — when the
 * result would exceed a token threshold — its frontmatter and an outline.
 * Shared by `brain read` and the `brain_read` MCP tool so both answer the same
 * way.
 *
 * The body is parsed as GFM (remark-parse and remark-gfm, the parser ui-sdk
 * uses), so a heading is whatever CommonMark says it is: ATX or setext, and
 * never inside code, HTML, a table, a list or a blockquote. Only top-level
 * headings open sections. A section runs from the start of its heading's line
 * to the next top-level heading of the same or a higher level, and is cut
 * from the source by offset, so it comes back byte for byte.
 */

interface DocumentHeading {
  level: number;
  text: string;
  /** Estimated tokens of the section this heading opens, subsections included. */
  tokens: number;
}

export interface ReadPartOptions {
  /**
   * Heading of the section to return, compared with each heading's visible
   * text (see `visibleText`) under Unicode canonical caseless matching. The
   * query is taken literally, not parsed as markdown. When two headings match,
   * the first one wins.
   */
  section?: string;
  /**
   * The threshold that switches to the outline: a result estimated above it
   * is replaced by the frontmatter and an outline. It is not a cap on the
   * output — a very large frontmatter or a document with very many headings
   * yields an outline larger than it.
   */
  maxTokens?: number;
  /** How the caller asks for a section, e.g. `section: "<heading>"`; the outline's note names it. */
  sectionHint: string;
}

/** An unknown section. The message names every heading the document has. */
export class SectionNotFoundError extends Error {}

/*
 * The slice of mdast this reads, typed structurally rather than through
 * `@types/mdast`, as ui-sdk's classification/detect.ts does: a type-only
 * import would still put a bare `mdast` specifier in a published source file.
 */
interface MdNode {
  type: string;
  depth?: number;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Length of the frontmatter block, by the rule gray-matter applies when core
 * reads a document: after a byte order mark, which gray-matter strips, the
 * file opens with `---` not followed by a fourth `-`, and the block runs to
 * the first `\n---` (to the end of the file if there is none), plus one line
 * ending after it. The length counts the mark, so it is an offset into the
 * original text.
 */
export function frontmatterLength(text: string): number {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", bom) || text.charAt(bom + 3) === "-") return 0;
  const close = text.indexOf("\n---", bom + 3);
  if (close === -1) return text.length;
  let end = close + 4;
  if (text[end] === "\r") end++;
  if (text[end] === "\n") end++;
  return end;
}

interface LocatedHeading {
  level: number;
  text: string;
  /** Offset in the body where the heading's first line starts. */
  start: number;
}

/** The start of the line holding `offset`, so indentation before a heading is kept. */
function lineStart(body: string, offset: number): number {
  let i = offset;
  while (i > 0 && body[i - 1] !== "\n" && body[i - 1] !== "\r") i--;
  return i;
}

function locateHeadings(body: string): LocatedHeading[] {
  const root = parser.parse(body) as MdNode;
  const headings: LocatedHeading[] = [];
  for (const node of root.children ?? []) {
    const offset = node.position?.start.offset;
    if (node.type !== "heading" || offset === undefined) continue;
    headings.push({ level: node.depth ?? 1, text: visibleText(node), start: lineStart(body, offset) });
  }
  return headings;
}

/**
 * A heading as a reader sees it: the parser has already resolved emphasis,
 * code spans, links, entities and escapes, and `mdast-util-to-string` keeps
 * the text and image alt text while dropping raw HTML. Brain wiki-links,
 * which plain GFM leaves as text, read as their label: `[[path|label]]` as
 * `label`, `[[path]]` as `path`. Whitespace runs collapse to one space.
 */
function visibleText(heading: MdNode): string {
  return mdastToString(heading, { includeHtml: false })
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function matchKey(text: string): string {
  return caseFold(text.replace(/\s+/g, " ").trim());
}

/** Offset in the body after the section opened by headings[i], or `end` when no later heading closes it. */
function sectionEnd(headings: LocatedHeading[], i: number, end: number): number {
  const next = headings.slice(i + 1).find((h) => h.level <= headings[i].level);
  return next ? next.start : end;
}

export function readDocumentPart(text: string, opts: ReadPartOptions): string {
  if (opts.section === undefined && opts.maxTokens === undefined) return text;

  const frontmatter = text.slice(0, frontmatterLength(text));
  const body = text.slice(frontmatter.length);
  // Parsed once, whole: a selected section's subheadings keep what the rest
  // of the document gives them, such as a reference link defined below it.
  let headings = locateHeadings(body);
  let range = { start: 0, end: body.length };
  let result = text;

  if (opts.section !== undefined) {
    const wanted = matchKey(opts.section);
    const i = headings.findIndex((h) => matchKey(h.text) === wanted);
    if (i === -1) {
      const available = headings.map((h) => `"${h.text}"`).join(", ");
      throw new SectionNotFoundError(
        `section "${opts.section}" not found; ` +
          (available ? `available headings: ${available}` : "the document has no headings")
      );
    }
    range = { start: headings[i].start, end: sectionEnd(headings, i, body.length) };
    headings = headings.filter((h) => h.start >= range.start && h.start < range.end);
    result = body.slice(range.start, range.end);
  }

  const total = estimateTokens(result);
  if (opts.maxTokens === undefined || total <= opts.maxTokens) return result;

  const outline: DocumentHeading[] = headings.map((h, i) => ({
    level: h.level,
    text: h.text,
    tokens: estimateTokens(body.slice(h.start, sectionEnd(headings, i, range.end))),
  }));
  const scope = opts.section === undefined ? "This document" : `The section "${opts.section}"`;
  const note =
    outline.length > 0
      ? `${scope} is ~${total} tokens, over the ${opts.maxTokens}-token limit. ` +
        `Its outline follows; read one section with ${opts.sectionHint}.`
      : `${scope} is ~${total} tokens, over the ${opts.maxTokens}-token limit, ` +
        `and has no headings to read it by section.`;
  const top = Math.min(...outline.map((h) => h.level));
  const outlineLines = outline.map(
    (h) => `${"  ".repeat(h.level - top)}- ${"#".repeat(h.level)} ${h.text} (~${h.tokens} tokens)`
  );
  const head = frontmatter ? [frontmatter.replace(/\r?\n$/, ""), ""] : [];
  return [...head, `[${note}]`, "", ...outlineLines].join("\n") + "\n";
}
