import { estimateTokens } from "./chunker.js";

/**
 * Read part of a markdown document: the whole file, one section, or — when the
 * result would exceed a token threshold — its frontmatter and an outline.
 * Shared by `brain read` and the `brain_read` MCP tool so both answer the same
 * way.
 *
 * Headings follow CommonMark's block rules for the cases a brain document
 * uses, without a markdown parser dependency: ATX headings (`#` … `######`,
 * up to three spaces of indent, optional closing `#`s) and setext headings (a
 * paragraph underlined with `===` or `---`), never inside a fenced or indented
 * code block. A list or blockquote line cannot open a setext heading. A
 * section runs from its heading to the next heading of the same or a higher
 * level.
 */

interface DocumentHeading {
  level: number;
  text: string;
  /** Estimated tokens of the section this heading opens, subsections included. */
  tokens: number;
}

export interface ReadPartOptions {
  /**
   * Heading of the section to return. Matched on visible text (inline
   * emphasis, code and link markup stripped) under Unicode full case folding;
   * when two headings match, the first one wins.
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

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

const BLANK = /^[ \t]*$/;
/** Four spaces or a tab: indented code, or a paragraph's continuation. */
const INDENTED = /^(?: {4}|\t| {0,3}\t)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A blockquote or list item marker: its lines cannot open a setext heading. */
const CONTAINER = /^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;

interface LocatedHeading {
  level: number;
  /** Visible heading text, markup stripped. */
  text: string;
  /** First line of the heading in the body: the `#` line, or a setext paragraph's first line. */
  line: number;
}

function locateHeadings(lines: string[]): LocatedHeading[] {
  const headings: LocatedHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  // First line of the open paragraph, if any: a setext underline turns it into a heading.
  let paragraph: number | null = null;
  // Inside a list item or blockquote, until the next blank line.
  let container = false;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");

    if (fence) {
      const close = line.match(FENCE_CLOSE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    if (BLANK.test(line)) {
      paragraph = null;
      container = false;
      return;
    }
    if (INDENTED.test(line)) {
      // Continues an open paragraph or container; otherwise indented code.
      return;
    }

    const open = line.match(FENCE_OPEN);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      paragraph = null;
      return;
    }

    const atx = line.match(ATX);
    if (atx) {
      const content = (atx[2] ?? "").trim().replace(/(?:^|[ \t]+)#+$/, "").trim();
      headings.push({ level: atx[1].length, text: visibleText(content), line: i });
      paragraph = null;
      container = false;
      return;
    }

    const underline = line.match(SETEXT_UNDERLINE);
    if (underline && paragraph !== null) {
      const content = lines.slice(paragraph, i).map((l) => l.replace(/\r$/, "").trim()).join(" ");
      headings.push({ level: underline[1][0] === "=" ? 1 : 2, text: visibleText(content), line: paragraph });
      paragraph = null;
      return;
    }

    if (THEMATIC_BREAK.test(line)) {
      paragraph = null;
      container = false;
      return;
    }
    if (CONTAINER.test(line)) {
      paragraph = null;
      container = true;
      return;
    }
    if (paragraph === null && !container) paragraph = i;
  });
  return headings;
}

/**
 * Heading text as a reader sees it: code spans kept literally, and emphasis,
 * strikethrough, links, wiki-links, images, inline HTML and backslash escapes
 * reduced to their text.
 */
function visibleText(markdown: string): string {
  const code: string[] = [];
  let text = markdown.replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks, span: string) => {
    code.push(span.trim());
    return `\uE000${code.length - 1}\uE001`;
  });
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    // Delimiter runs only where they can open or close emphasis, so the `_`
    // in snake_case and a spaced ` * ` survive.
    .replace(/(^|[^\\\w])(\*{1,3}|_{1,3}|~~)(?=\S)/g, "$1")
    .replace(/([^\s\\])(\*{1,3}|_{1,3}|~~)(?=$|[^\w])/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1");
  text = text.replace(/\uE000(\d+)\uE001/g, (_, n: string) => code[Number(n)]);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Unicode full case folding, approximated by the full case mappings: upper
 * then lower maps `ß` and `SS` alike to `ss`, and `σ` and `ς` alike to the
 * sigma their position in the word calls for. NFC first, so composed and
 * decomposed accents compare equal.
 */
function fold(text: string): string {
  return text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** Index of the line after the section opened by headings[i]. */
function sectionEnd(headings: LocatedHeading[], i: number, lineCount: number): number {
  const next = headings.slice(i + 1).find((h) => h.level <= headings[i].level);
  return next ? next.line : lineCount;
}

export function readDocumentPart(text: string, opts: ReadPartOptions): string {
  if (opts.section === undefined && opts.maxTokens === undefined) return text;

  const frontmatter = text.match(FRONTMATTER)?.[0] ?? "";
  let lines = text.slice(frontmatter.length).split("\n");
  let headings = locateHeadings(lines);
  let result = text;

  if (opts.section !== undefined) {
    const wanted = fold(visibleText(opts.section.replace(/^\s*#+\s*/, "")));
    const i = headings.findIndex((h) => fold(h.text) === wanted);
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
