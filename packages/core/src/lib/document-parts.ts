import { estimateTokens } from "./chunker.js";

/**
 * Read part of a markdown document: the whole file, one section, or — when the
 * result would exceed a token limit — its frontmatter and an outline. Shared by
 * `brain read` and the `brain_read` MCP tool so both answer the same way.
 *
 * Headings are ATX (`#` … `######`) outside fenced code blocks; a section runs
 * from its heading line to the next heading of the same or a higher level.
 */

interface DocumentHeading {
  level: number;
  text: string;
  /** Estimated tokens of the section this heading opens, subsections included. */
  tokens: number;
}

export interface ReadPartOptions {
  /** Heading text of the section to return, matched case-insensitively. */
  section?: string;
  /** Return an outline instead when the result would be larger than this. */
  maxTokens?: number;
  /** How the caller asks for a section, e.g. `section: "<heading>"`; the outline's note names it. */
  sectionHint: string;
}

/** An unknown section. The message names every heading the document has. */
export class SectionNotFoundError extends Error {}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

interface LocatedHeading {
  level: number;
  text: string;
  /** Line index in the body. */
  line: number;
}

function locateHeadings(lines: string[]): LocatedHeading[] {
  const headings: LocatedHeading[] = [];
  let fenceChar: string | null = null;
  lines.forEach((line, i) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (fenceChar === char) fenceChar = null;
      return;
    }
    if (fenceChar !== null) return;
    const m = line.replace(/\r$/, "").match(HEADING);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return headings;
}

/** Index of the line after the section opened by headings[i]. */
function sectionEnd(headings: LocatedHeading[], i: number, lineCount: number): number {
  const next = headings.slice(i + 1).find((h) => h.level <= headings[i].level);
  return next ? next.line : lineCount;
}

function normalize(heading: string): string {
  return heading.replace(/^#+\s*/, "").trim().toLowerCase();
}

export function readDocumentPart(text: string, opts: ReadPartOptions): string {
  if (opts.section === undefined && opts.maxTokens === undefined) return text;

  const frontmatter = text.match(FRONTMATTER)?.[0] ?? "";
  let lines = text.slice(frontmatter.length).split("\n");
  let headings = locateHeadings(lines);
  let result = text;

  if (opts.section !== undefined) {
    const wanted = normalize(opts.section);
    const i = headings.findIndex((h) => normalize(h.text) === wanted);
    if (i === -1) {
      const available = headings.map((h) => `"${h.text}"`).join(", ");
      throw new SectionNotFoundError(
        `section "${opts.section}" not found; ` +
          (available ? `available headings: ${available}` : "the document has no headings")
      );
    }
    lines = lines.slice(headings[i].line, sectionEnd(headings, i, lines.length));
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    headings = locateHeadings(lines);
    result = lines.join("\n") + "\n";
  }

  const total = estimateTokens(result);
  if (opts.maxTokens === undefined || total <= opts.maxTokens) return result;

  const outline: DocumentHeading[] = headings.map((h, i) => ({
    level: h.level,
    text: h.text,
    tokens: estimateTokens(lines.slice(h.line, sectionEnd(headings, i, lines.length)).join("\n")),
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
