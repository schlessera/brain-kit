import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { Chunk } from "./types.js";

const MIN_TOKENS = 100;
const MAX_TOKENS = 1000;

/**
 * Estimate token count from text length.
 * Rough heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ChunkInput {
  title: string;
  content: string;
  documentId: number;
}

interface Section {
  heading: string;
  content: string;
}

/*
 * The slice of mdast this reads, typed structurally rather than through
 * `@types/mdast`, as document-parts.ts does.
 */
interface MdNode {
  type: string;
  depth?: number;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

/**
 * Markdown structure comes from a real parser, GFM included (the one
 * `brain read` uses), not from scanning lines: a fence of any length or
 * marker, a table without outer pipes, a `##` inside code are all what
 * CommonMark says they are.
 */
const parser = unified().use(remarkParse).use(remarkGfm);

function topLevel(text: string): MdNode[] {
  return (parser.parse(text) as MdNode).children ?? [];
}

const startOf = (node: MdNode) => node.position?.start.offset ?? 0;
const endOf = (node: MdNode) => node.position?.end.offset ?? 0;

/** A heading's text as written: after the `#`s for ATX, the text lines for setext. */
function headingText(source: string): string {
  const atx = source.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/s);
  if (atx) return atx[1].trim();
  return source.split("\n").slice(0, -1).map((line) => line.trim()).join(" ").trim();
}

/** The line ending a document uses: CRLF when it has one, else LF. Joins keep it. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Drop the blank lines around a slice, and its trailing whitespace, but not
 * the indentation of its first line: four leading spaces are what make an
 * indented code block code, and a slice is parsed again after it is cut.
 */
function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

/**
 * Cut `content` at its top-level headings of `depth`. The part before the
 * first one has a null heading. Headings with no text are content.
 */
function splitAtHeadings(content: string, depth: number): Array<{ heading: string | null; content: string }> {
  const parts: Array<{ heading: string | null; content: string }> = [];
  let heading: string | null = null;
  let from = 0;
  for (const node of topLevel(content)) {
    if (node.type !== "heading" || node.depth !== depth) continue;
    const text = headingText(content.slice(startOf(node), endOf(node)));
    if (!text) continue;
    parts.push({ heading, content: trimBlankLines(content.slice(from, startOf(node))) });
    heading = text;
    from = endOf(node);
  }
  parts.push({ heading, content: trimBlankLines(content.slice(from)) });
  return parts;
}

/** Split markdown content into sections by its `##` headings. */
function splitBySections(content: string): Section[] {
  return splitAtHeadings(content, 2)
    .filter((part) => part.content)
    .map((part) => ({ heading: part.heading ?? "(intro)", content: part.content }));
}

/**
 * The chunker's version, stored on every document row it chunks. Bump it
 * whenever the same document would chunk differently: an index run re-chunks
 * each document whose stored version is another one, once, even when its file did
 * not change.
 */
export const CHUNKER_VERSION = 2;

/** Every code block in the subtree, as [start, end) offsets: nothing is split inside one. HTML is not code. */
function codeRanges(node: MdNode, base: number, ranges: Array<[number, number]>): Array<[number, number]> {
  if (node.type === "code") ranges.push([base + startOf(node), base + endOf(node)]);
  for (const child of node.children ?? []) codeRanges(child, base, ranges);
  return ranges;
}

/**
 * A block's lines, as the units it may be cut into. Lines end in LF or CRLF
 * (the CR stays on its line). A file with bare-CR line endings, which the
 * parser also accepts, is not cut at lines: a known limit, rare outside very
 * old Mac files.
 *
 * The units are the block's lines, except that the lines of
 * a code block (at any depth, a fence inside a list item included) stay
 * together as one unit.
 */
function lineUnits(block: string, node: MdNode, base: number): string[] {
  const ranges = codeRanges(node, -base, []);
  const units: string[] = [];
  let offset = 0;
  let current: string[] = [];
  let currentEnd = -1;
  for (const line of block.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const range = ranges.find(([s, e]) => lineStart < e && offset - 1 > s);
    if (current.length > 0 && lineStart < currentEnd) {
      current.push(line);
      if (range) currentEnd = Math.max(currentEnd, range[1]);
      continue;
    }
    if (current.length > 0) units.push(current.join("\n"));
    current = [line];
    currentEnd = range ? range[1] : -1;
  }
  if (current.length > 0) units.push(current.join("\n"));
  return units;
}

/**
 * A table cut at row boundaries, the header and separator rows at the top of
 * every piece. Two cases the size bound allows:
 *
 * - A row that does not fit even with the header goes out as a piece of its
 *   own, without it; the header still opens the table, alone if it must.
 * - The header and separator together pass the limit only when the header
 *   line alone does (the single-line exception). When the header fits and
 *   the separator tips it over, the table is cut at lines like any text,
 *   which leaves no piece over the limit.
 */
function splitTable(block: string, node: MdNode, base: number): string[] {
  const rows = node.children ?? [];
  const headerEnd = rows.length > 1 ? startOf(rows[1]) - base : block.length;
  const eol = eolOf(block);
  const header = block.slice(startOf(rows[0] ?? node) - base, headerEnd).replace(/(?:\r?\n)+$/, "");
  const headerLine = header.split("\n")[0];
  if (estimateTokens(header) > MAX_TOKENS && estimateTokens(headerLine) <= MAX_TOKENS) {
    return splitLines(block, node, base);
  }
  if (rows.length < 2) return [block];
  const fits = (lines: string[]) => estimateTokens(lines.join(eol)) <= MAX_TOKENS;
  const pieces: string[] = [];
  let current: string[] | null = null;
  let headerShown = false;
  for (const row of rows.slice(1)) {
    const text = block.slice(startOf(row) - base, endOf(row) - base);
    if (current && fits([...current, text])) {
      current.push(text);
      continue;
    }
    if (current) pieces.push(current.join(eol));
    if (fits([header, text])) {
      current = [header, text];
      headerShown = true;
    } else {
      if (!headerShown) pieces.push(header);
      headerShown = true;
      pieces.push(text);
      current = null;
    }
  }
  if (current) pieces.push(current.join(eol));
  return pieces;
}

/**
 * Break one top-level block that is over the limit into pieces that are not:
 * a table at row boundaries, anything else, HTML included, at line boundaries
 * outside code. A code block is never broken; a single line over the limit
 * stays whole.
 */
function splitBlock(block: string, node: MdNode, base: number): string[] {
  if (node.type === "code") return [block];
  if (node.type === "table") return splitTable(block, node, base);
  return splitLines(block, node, base);
}

/** Cut a block at line boundaries into pieces within the limit, never inside code. */
function splitLines(block: string, node: MdNode, base: number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  for (const unit of lineUnits(block, node, base)) {
    if (current.length > 0 && estimateTokens([...current, unit].join("\n")) > MAX_TOKENS) {
      pieces.push(current.join("\n"));
      current = [];
    }
    current.push(unit);
  }
  if (current.length > 0) pieces.push(current.join("\n"));
  return pieces;
}

/** Pack a part's top-level blocks into pieces of at most MAX_TOKENS, splitting any block that alone is over it. */
function packBlocks(content: string): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  const gap = eolOf(content).repeat(2);
  const size = (parts: string[]) => estimateTokens(parts.join(gap));
  for (const node of topLevel(content)) {
    const block = content.slice(startOf(node), endOf(node));
    const parts = estimateTokens(block) > MAX_TOKENS ? splitBlock(block, node, startOf(node)) : [block];
    for (const part of parts) {
      if (current.length > 0 && size([...current, part]) > MAX_TOKENS) {
        pieces.push(current.join(gap));
        current = [];
      }
      current.push(part);
    }
  }
  if (current.length > 0) pieces.push(current.join(gap));
  return pieces;
}

/** Split a section at its `###` headings. The part before the first one keeps the section's heading. */
function splitAtSubheadings(section: Section): Section[] {
  return splitAtHeadings(section.content, 3)
    .filter((part) => part.content)
    .map((part) => ({
      heading:
        part.heading === null
          ? section.heading
          : section.heading === "(intro)"
            ? part.heading
            : `${section.heading} › ${part.heading}`,
      content: part.content,
    }));
}

/**
 * Split a section that is over MAX_TOKENS, most structural boundary first:
 * at its `###` headings, then between blocks, then inside a table at row
 * boundaries or inside other blocks at lines, never inside code. Pieces after
 * the first under one heading are marked `(cont.)`.
 */
function splitLargeSection(section: Section): Section[] {
  // A `###` part under MIN_TOKENS (an intro line, a short subsection) goes
  // into the part after it, keeping its own `###` line, as phase 1 does for
  // a small `##` section.
  const parts = splitAtSubheadings(section);
  for (let i = 0; i < parts.length - 1; i++) {
    if (estimateTokens(parts[i].content) >= MIN_TOKENS) continue;
    const label = parts[i].heading === section.heading ? "" : `### ${parts[i].heading.split(" › ").pop()}\n\n`;
    parts[i + 1] = { heading: parts[i + 1].heading, content: `${label}${parts[i].content}\n\n${parts[i + 1].content}` };
    parts.splice(i, 1);
    i--;
  }
  const result: Section[] = [];
  for (const part of parts) {
    const pieces = estimateTokens(part.content) > MAX_TOKENS ? packBlocks(part.content) : [part.content];
    pieces.forEach((content, index) => {
      result.push({ heading: index === 0 ? part.heading : `${part.heading} (cont.)`, content });
    });
  }
  return result;
}

/**
 * The heading line a folded stub keeps inside the chunk it joins, so its text
 * still sits under its own heading: none when it continues the same heading,
 * `### sub` for a `## › ###` piece, `## heading` otherwise.
 */
function foldLabel(heading: string, previous: string): string {
  const base = (h: string) => h.replace(/ \(cont\.\)$/, "");
  if (heading === "(intro)" || base(heading) === base(previous)) return "";
  const sub = base(heading).split(" › ");
  return sub.length > 1 ? `### ${sub[sub.length - 1]}\n\n` : `## ${base(heading)}\n\n`;
}

/**
 * Deterministic markdown chunking by ## headings.
 *
 * - Splits content by ## headings into sections
 * - Merges small sections (<100 tokens) with the next section
 * - Splits large sections (>1000 tokens) at ### headings, then blank lines,
 *   then table rows (repeating the table header), never inside a fence
 * - Folds a final chunk under 100 tokens into the one before it, when the
 *   result stays within 1000: a closing link list or sign-off has no next
 *   section to merge into, and alone it is a chunk carrying almost no text
 */
export function chunkDocument(input: ChunkInput): Omit<Chunk, "id">[] {
  const sections = splitBySections(input.content);

  if (sections.length === 0) {
    return [];
  }

  // Phase 1: merge small sections with the next section
  const merged: Section[] = [];
  let i = 0;

  while (i < sections.length) {
    const section = sections[i];
    const tokens = estimateTokens(section.content);

    if (tokens < MIN_TOKENS && i + 1 < sections.length) {
      // Merge with the next section
      const next = sections[i + 1];
      sections[i + 1] = {
        heading: next.heading,
        content: `${section.heading !== "(intro)" ? `## ${section.heading}\n\n` : ""}${section.content}\n\n${next.content}`,
      };
      i++;
      continue;
    }

    merged.push(section);
    i++;
  }

  // Phase 2: split large sections by structure
  const final: Section[] = [];
  for (const section of merged) {
    const tokens = estimateTokens(section.content);
    if (tokens > MAX_TOKENS) {
      final.push(...splitLargeSection(section));
    } else {
      final.push(section);
    }
  }

  // Phase 3: fold a trailing stub back into the chunk before it
  if (final.length > 1) {
    const last = final[final.length - 1];
    const previous = final[final.length - 2];
    if (estimateTokens(last.content) < MIN_TOKENS) {
      const label = foldLabel(last.heading, previous.heading);
      const content = `${previous.content}\n\n${label}${last.content}`;
      if (estimateTokens(content) <= MAX_TOKENS) {
        final.splice(final.length - 2, 2, { heading: previous.heading, content });
      }
    }
  }

  // Phase 4: convert to Chunk objects
  return final.map((section, index) => ({
    document_id: input.documentId,
    chunk_index: index,
    heading: section.heading,
    content: section.content,
    token_estimate: estimateTokens(section.content),
  }));
}

/**
 * Format chunk text for embedding, prepending title, heading, and (when
 * available) an LLM-generated context blurb situating the chunk in its
 * document (contextual retrieval).
 */
export function chunkTextForEmbedding(
  title: string,
  heading: string,
  content: string,
  context?: string | null
): string {
  const contextLine = context ? `${context}\n` : "";
  return `[${title}] [${heading}]\n${contextLine}${content}`;
}
