/**
 * A markdown document as the sync resolver merges it: its frontmatter, then
 * its body cut into heading-delimited sections, each a run of units.
 *
 * A unit is the smallest thing a merge keeps or drops whole: a paragraph, a
 * list item, a table row (or, for `table-union`, a whole table), a fenced
 * block. The body is parsed as GFM with the parser document-parts.ts uses, so
 * a `#` line inside a fence is code, not a heading, and a unit is cut from the
 * source by offset. Every unit keeps the whitespace that followed it, so a
 * document emitted from its own units comes back byte for byte.
 */

import { parseFrontmatter } from "../../frontmatter-parse.js";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { frontmatterLength } from "../../document-parts.js";
import { nameKey } from "../../name-key.js";

/*
 * The slice of mdast this reads, typed structurally (see document-parts.ts
 * for why not through `@types/mdast`).
 */
interface MdNode {
  type: string;
  depth?: number;
  ordered?: boolean;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Which input a unit or section was cut from. */
export type Side = "base" | "ours" | "theirs";

export type UnitKind = "block" | "item" | "head" | "row" | "table" | "entry";

/** The table a head, a row or a whole table belongs to. */
export interface TableShape {
  /** The header's cells, normalized and joined: two tables with the same header are the same table. */
  key: string;
  /** Header row and delimiter row, as written. */
  head: string;
  /** The header's cells as a reader sees them. */
  header: string[];
}

export interface TableRow {
  text: string;
  /** Each cell as a reader sees it. */
  cells: string[];
  /** Each cell as written, trimmed: what "unchanged" compares, so a new link target is a change. */
  source: string[];
  /** The first cell, normalized: what the row is keyed by. */
  key: string;
}

export interface Unit {
  kind: UnitKind;
  /** The unit's source, trailing whitespace excluded. */
  text: string;
  /** The whitespace that followed it in its source, up to the next unit or the end of its section. */
  sep: string;
  /** `text` without trailing blanks on any line: what "unchanged" compares. */
  norm: string;
  /** What aligns the unit across versions: `norm`, or for a whole table its header. */
  key: string;
  /** Where it was cut from; null for a unit the merge assembled. */
  origin: { side: Side; section: number; index: number } | null;
  /** A list item's list: its bullet or delimiter, so items of one list rejoin tightly. */
  marker?: string;
  table?: TableShape;
  /** A whole table's body rows (`table-union`). */
  rows?: TableRow[];
  /** A row's cells as a reader sees them. */
  cells?: string[];
}

export interface Section {
  /** Stable across versions: the normalized heading path and its occurrence. */
  key: string;
  /** Heading texts as written, outermost first; empty for the text before the first heading. */
  path: string[];
  /** Heading level; 0 for the text before the first heading. */
  level: number;
  /** The heading as written, without its line ending; "" before the first heading. */
  heading: string;
  /** Whitespace between the heading and the first unit (or the section's end). */
  lead: string;
  units: Unit[];
  /** The section's source, byte for byte. */
  text: string;
  side: Side;
  index: number;
}

export interface Doc {
  raw: string;
  /** The frontmatter block with its fences and closing line ending; "" when there is none. */
  frontmatter: string;
  data: Record<string, unknown>;
  body: string;
  sections: Section[];
}

/** A side the resolver cannot read: its frontmatter is not YAML it can parse. */
export class UnparseableError extends Error {}

export interface ParseOptions {
  /** `rows`: each table row is a unit. `whole`: each table is one unit keyed by its header. */
  tables: "rows" | "whole";
  /** Fold the subsections of a `Timeline` heading into it as entries (`timeline-append`). */
  timeline?: boolean;
}

/** The start of the line holding `offset`, so indentation before a block is kept. */
function lineStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== "\n" && text[i - 1] !== "\r") i--;
  return i;
}

function trimEndOffset(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  return e;
}

function span(node: MdNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

/**
 * Lines stripped of trailing blanks, except that two or more spaces before a
 * line ending stay as two: that is a hard line break, which a reader sees.
 */
export function normalizeText(text: string): string {
  return text.replace(/[ \t]+$/gm, (blanks) => (/ {2}$/.test(blanks) ? "  " : "")).replace(/\s+$/, "");
}

/** A heading or cell as a reader sees it: markup resolved, wiki-links read as their label. */
function visibleText(node: MdNode): string {
  return mdastToString(node, { includeHtml: false })
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A row key: the first cell with markup resolved, a wiki-link read as its
 * target (`[[plan|The plan]]` is `plan`), a markdown link as its text, then
 * trimmed and case-folded.
 */
function rowKey(cell: MdNode): string {
  const text = mdastToString(cell, { includeHtml: false }).replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1");
  return nameKey(text);
}

/** A cell's source without its pipes: `| [a](b) |` is `[a](b)`. */
function cellSource(body: string, cell: MdNode): string {
  const r = span(cell);
  return r ? body.slice(r[0], r[1]).replace(/^\|/, "").replace(/(?<!\\)\|$/, "").trim() : "";
}

function listMarker(body: string, item: MdNode, ordered: boolean): string {
  const [start] = span(item)!;
  const match = /^[ \t]*(?:([-*+])|\d{1,9}([.)]))/.exec(body.slice(start));
  return ordered ? `ordered${match?.[2] ?? "."}` : (match?.[1] ?? "-");
}

interface Piece {
  kind: UnitKind;
  start: number;
  end: number;
  extra?: Partial<Unit>;
}

/** The units one top-level node yields. */
function piecesOf(body: string, node: MdNode, tables: ParseOptions["tables"]): Piece[] {
  const range = span(node);
  if (!range) return [];
  const [start, end] = range;
  if (node.type === "list") {
    return (node.children ?? []).flatMap((item) => {
      const r = span(item);
      return r ? [{ kind: "item" as const, start: lineStart(body, r[0]), end: r[1], extra: { marker: listMarker(body, item, !!node.ordered) } }] : [];
    });
  }
  if (node.type === "table") {
    const rows = node.children ?? [];
    const headerRow = rows[0];
    const headerSpan = headerRow ? span(headerRow) : null;
    if (!headerRow || !headerSpan) return [{ kind: "block", start: lineStart(body, start), end }];
    const header = (headerRow.children ?? []).map(visibleText);
    const delimiterStart = body.indexOf("\n", headerSpan[1]) + 1;
    let delimiterEnd = delimiterStart > 0 ? body.indexOf("\n", delimiterStart) : -1;
    if (delimiterEnd === -1 || delimiterEnd > end) delimiterEnd = end;
    const headStart = lineStart(body, start);
    const shape: TableShape = {
      key: header.map(nameKey).join("|"),
      head: body.slice(headStart, trimEndOffset(body, headStart, delimiterEnd)),
      header,
    };
    const bodyRows: TableRow[] = [];
    const rowPieces: Piece[] = [];
    for (const row of rows.slice(1)) {
      const r = span(row);
      if (!r) continue;
      const rowStart = lineStart(body, r[0]);
      const cells = (row.children ?? []).map(visibleText);
      const source = (row.children ?? []).map((cell) => cellSource(body, cell));
      const text = body.slice(rowStart, trimEndOffset(body, rowStart, r[1]));
      bodyRows.push({ text, cells, source, key: row.children?.[0] ? rowKey(row.children[0]) : "" });
      rowPieces.push({ kind: "row", start: rowStart, end: r[1], extra: { table: shape, cells } });
    }
    if (tables === "whole") {
      return [{ kind: "table", start: headStart, end, extra: { table: shape, rows: bodyRows } }];
    }
    return [{ kind: "head", start: headStart, end: delimiterEnd, extra: { table: shape } }, ...rowPieces];
  }
  return [{ kind: "block", start: lineStart(body, start), end }];
}

function unitsOf(body: string, pieces: Piece[], sectionEnd: number, side: Side, section: number): Unit[] {
  return pieces.map((piece, index) => {
    const end = trimEndOffset(body, piece.start, piece.end);
    const next = index + 1 < pieces.length ? pieces[index + 1]!.start : sectionEnd;
    const text = body.slice(piece.start, end);
    const norm = normalizeText(text);
    const unit: Unit = {
      kind: piece.kind,
      text,
      sep: body.slice(end, next),
      norm,
      key: piece.kind === "table" ? `table:${piece.extra!.table!.key}` : norm,
      origin: { side, section, index },
      ...piece.extra,
    };
    return unit;
  });
}

/** The body's top-level nodes, parsed once. */
function topNodes(body: string): MdNode[] {
  return ((parser.parse(body) as MdNode).children ?? []).filter((node) => span(node) !== null);
}

/**
 * `read` run on a side's body, with the parser's recursion limit as an
 * `UnparseableError`: mdast walks nest one call per level, so a body nested
 * a few thousand blockquotes deep overflows the stack.
 */
function withinDepth<T>(label: string, read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof RangeError) throw new UnparseableError(`${label}: the body nests too deeply to parse`);
    throw e;
  }
}

/**
 * The visible text of every top-level heading in `text` (frontmatter
 * skipped). Throws `UnparseableError` when the body nests too deeply to parse.
 */
export function headingTexts(text: string): string[] {
  const body = text.slice(frontmatterLength(text));
  return withinDepth("text", () =>
    topNodes(body)
      .filter((node) => node.type === "heading")
      .map(visibleText)
  );
}

/** Frontmatter nested deeper than this is left for a human. */
export const MAX_FRONTMATTER_DEPTH = 64;
/** Nor one whose aliases expand it past this many values ("billion laughs"). */
export const MAX_FRONTMATTER_VALUES = 100_000;

/**
 * Why a frontmatter value cannot be merged, or null when it can. YAML
 * aliases make the parsed value a graph: `x: &x [*x]` contains itself, and
 * every recursive walk of it (comparison, the serializer) would never end;
 * and aliases of aliases can expand a short block into billions of values.
 * Walked with an explicit stack, so the check itself cannot overflow.
 */
function unsupportedStructure(data: Record<string, unknown>): string | null {
  const stack: { value: unknown; depth: number; exit?: true }[] = [{ value: data, depth: 0 }];
  const open = new Set<unknown>();
  let values = 0;
  while (stack.length > 0) {
    const { value, depth, exit } = stack.pop()!;
    if (exit) {
      open.delete(value);
      continue;
    }
    if (++values > MAX_FRONTMATTER_VALUES) return `frontmatter expands to more than ${MAX_FRONTMATTER_VALUES} values through YAML aliases`;
    if (!value || typeof value !== "object" || value instanceof Date) continue;
    if (open.has(value)) return "frontmatter refers to itself through a YAML alias";
    if (depth > MAX_FRONTMATTER_DEPTH) return `frontmatter nests deeper than ${MAX_FRONTMATTER_DEPTH} levels`;
    open.add(value);
    stack.push({ value, depth, exit: true });
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/** True when a heading's text names the timeline section. */
export function isTimelineHeading(text: string): boolean {
  return nameKey(text) === "timeline";
}

function sectionize(body: string, side: Side, opts: ParseOptions): Section[] {
  interface Open { heading: MdNode | null; start: number; nodes: MdNode[] }
  const groups: Open[] = [{ heading: null, start: 0, nodes: [] }];
  for (const node of topNodes(body)) {
    if (node.type === "heading") groups.push({ heading: node, start: lineStart(body, span(node)![0]), nodes: [] });
    else groups[groups.length - 1]!.nodes.push(node);
  }

  const stack: { level: number; text: string }[] = [];
  const seen = new Map<string, number>();
  const sections: Section[] = groups.map((group, index) => {
    const end = index + 1 < groups.length ? groups[index + 1]!.start : body.length;
    let path: string[] = [];
    let level = 0;
    let heading = "";
    let headingEnd = group.start;
    if (group.heading) {
      level = group.heading.depth ?? 1;
      const text = visibleText(group.heading);
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text });
      path = stack.map((entry) => entry.text);
      headingEnd = trimEndOffset(body, group.start, span(group.heading)![1]);
      heading = body.slice(group.start, headingEnd);
    }
    const pathKey = JSON.stringify(path.map(nameKey));
    const occurrence = seen.get(pathKey) ?? 0;
    seen.set(pathKey, occurrence + 1);
    const pieces = group.nodes.flatMap((node) => piecesOf(body, node, opts.tables));
    const units = unitsOf(body, pieces, end, side, index);
    return {
      key: `${pathKey}#${occurrence}`,
      path,
      level,
      heading,
      lead: body.slice(headingEnd, pieces[0]?.start ?? end),
      units,
      text: body.slice(group.start, end),
      side,
      index,
    };
  });
  // The text before the first heading is a section even when empty, so
  // every version has one and it always leads.
  return opts.timeline ? foldTimelines(sections) : sections;
}

/**
 * Each `Timeline` section absorbs the subsections nested under it, each as
 * one `entry` unit, so a dated `### 2026-05-01` block is merged as an entry
 * rather than as a section of its own.
 */
function foldTimelines(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    out.push(section);
    if (section.level === 0 || !isTimelineHeading(section.path[section.path.length - 1] ?? "")) continue;
    const units = [...section.units];
    let text = section.text;
    while (i + 1 < sections.length && sections[i + 1]!.level > section.level) {
      const sub = sections[++i]!;
      const trimmed = sub.text.replace(/\s+$/, "");
      units.push({
        kind: "entry",
        text: trimmed,
        sep: sub.text.slice(trimmed.length),
        norm: normalizeText(trimmed),
        key: normalizeText(trimmed),
        origin: { side: section.side, section: section.index, index: units.length },
      });
      text += sub.text;
    }
    out[out.length - 1] = { ...section, units, text };
  }
  return out;
}

/**
 * Parse one side. Throws `UnparseableError` when its frontmatter is not a
 * YAML map, or is one no comparison can walk, or its body nests too deeply.
 */
export function parseDoc(raw: string, side: Side, opts: ParseOptions): Doc {
  const length = frontmatterLength(raw);
  let data: Record<string, unknown> = {};
  if (length > 0) {
    let parsed: unknown;
    try {
      parsed = parseFrontmatter(raw).data;
    } catch (e) {
      throw new UnparseableError(`${side}: frontmatter is not valid YAML (${(e as Error).message.split("\n")[0]})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UnparseableError(`${side}: frontmatter is not a map of fields`);
    }
    data = parsed as Record<string, unknown>;
    const unsupported = unsupportedStructure(data);
    if (unsupported) throw new UnparseableError(`${side}: ${unsupported}`);
  }
  const body = raw.slice(length);
  const sections = withinDepth(side, () => sectionize(body, side, opts));
  for (const section of sections) {
    const rebuilt = section.heading + section.lead + section.units.map((unit) => unit.text + unit.sep).join("");
    if (rebuilt !== section.text) {
      throw new UnparseableError(`${side}: section "${section.path.join(" > ")}" does not split into blocks cleanly`);
    }
  }
  return { raw, frontmatter: raw.slice(0, length), data, body, sections };
}

/** The whitespace between two units that were not neighbours in any source. */
function joinWith(prev: Unit, next: Unit): string {
  if (prev.kind === "item" && next.kind === "item" && prev.marker === next.marker) return "\n";
  if ((prev.kind === "head" || prev.kind === "row") && next.kind === "row" && prev.table?.key === next.table?.key) {
    return "\n";
  }
  return "\n\n";
}

function isSuccessor(prev: Unit, next: Unit): boolean {
  const a = prev.origin;
  const b = next.origin;
  return !!a && !!b && a.side === b.side && a.section === b.section && b.index === a.index + 1;
}

/**
 * Units back into text. Two units that were neighbours in their source keep
 * the whitespace between them; any other pair gets the separator that keeps
 * both what they were — a blank line, or a single line ending between two
 * items of one list or two rows of one table. A row whose table did not come
 * with it gets its table's header, so it stays a row.
 */
export function emitUnits(units: Unit[]): string {
  let out = "";
  let prev: Unit | null = null;
  for (const unit of units) {
    if (unit.kind === "row" && !(prev && (prev.kind === "head" || prev.kind === "row") && prev.table?.key === unit.table?.key)) {
      const head: Unit = {
        kind: "head",
        text: unit.table!.head,
        sep: "\n",
        norm: normalizeText(unit.table!.head),
        key: normalizeText(unit.table!.head),
        origin: null,
        table: unit.table,
      };
      if (prev) out += joinWith(prev, head);
      out += head.text;
      prev = head;
    }
    if (prev) out += isSuccessor(prev, unit) ? prev.sep : joinWith(prev, unit);
    out += unit.text;
    prev = unit;
  }
  if (prev) out += prev.sep;
  return out;
}

/** A section's text rebuilt around `units`: its heading, a lead that still separates, the units. */
export function emitSection(heading: string, lead: string, units: Unit[]): string {
  const body = emitUnits(units);
  if (units.length === 0) return heading + lead;
  const opening = heading === "" || /\n/.test(lead) ? lead : "\n\n";
  return heading + opening + body;
}

/** One section of the merged body, and whether it is a source section taken whole. */
export interface OutSection {
  key: string;
  text: string;
  /** Set when `text` is a source section verbatim: which one, and the key that followed it there. */
  verbatim?: { next: string | null };
}

/**
 * Sections back into a body. A section followed by the one that followed it
 * in its source keeps its bytes; any other boundary gets a blank line, so a
 * paragraph never runs into the next heading. The last section ends with one
 * line ending unless it was also last where it came from.
 */
export function assembleBody(sections: OutSection[]): string {
  let out = "";
  sections.forEach((section, i) => {
    const next = sections[i + 1];
    const text = section.text;
    const trimmed = text.replace(/\s+$/, "");
    if (next) {
      if (section.verbatim && section.verbatim.next === next.key) out += text;
      else if (trimmed === "") out += text;
      else out += trimmed + "\n\n";
    } else if (section.verbatim && section.verbatim.next === null) {
      out += text;
    } else {
      out += trimmed === "" ? "" : trimmed + "\n";
    }
  });
  return out;
}
