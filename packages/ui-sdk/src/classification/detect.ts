/**
 * Candidate detection (D42 §1): the deterministic half.
 *
 * Walks the markdown of one text part and collects the constructs that
 * MIGHT be one of the kit's answer blocks — a GFM table, an ordered list, a
 * bullet list whose items open with a time, a blockquote, a run of
 * key-colon-value lines. Nothing here judges; it extracts what the text
 * plainly contains, with the character span each candidate occupies, so a
 * later swap can cut the part at those offsets and the classifier can be
 * asked about the candidate alone rather than the whole answer.
 *
 * Most answers yield no candidates, which is the case that must cost
 * nothing: no call is made without one.
 */

import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/*
 * The slice of mdast this walk reads, typed structurally rather than through
 * `@types/mdast`: a type-only import would still put a bare `mdast` specifier
 * in a published source file, and the walk touches a handful of fields.
 */
interface Node {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
}
interface Paragraph extends Node {
  type: "paragraph";
  children: Node[];
}
interface ListItem extends Node {
  type: "listItem";
  checked?: boolean | null;
  children: Node[];
}
interface List extends Node {
  type: "list";
  ordered?: boolean | null;
  start?: number | null;
  children: ListItem[];
}
interface TableRow extends Node {
  type: "tableRow";
  children: Node[];
}
interface Table extends Node {
  type: "table";
  align?: Array<"left" | "right" | "center" | null> | null;
  children: TableRow[];
}
interface Blockquote extends Node {
  type: "blockquote";
  children: Node[];
}
type RootContent = Node;
interface Root {
  type: "root";
  children: RootContent[];
}

/** Where a candidate sits in its text part: character offsets, end exclusive. */
export interface CandidateSpan {
  start: number;
  end: number;
}

export interface TableCandidate extends CandidateSpan {
  kind: "table";
  id: string;
  headers: string[];
  align: Array<"left" | "right" | "center" | null>;
  rows: string[][];
}

export interface OrderedListCandidate extends CandidateSpan {
  kind: "ordered_list";
  id: string;
  items: Array<{ title: string; detail?: string; checked?: boolean }>;
}

export interface TimedListCandidate extends CandidateSpan {
  kind: "timed_list";
  id: string;
  items: Array<{ time: string; title: string; detail?: string }>;
}

export interface BlockquoteCandidate extends CandidateSpan {
  kind: "blockquote";
  id: string;
  text: string;
  /** A trailing attribution line the text plainly carries (`— Homer`). */
  source?: string;
}

export interface KeyValueRunCandidate extends CandidateSpan {
  kind: "kv_run";
  id: string;
  rows: Array<{ k: string; v: string }>;
}

export type Candidate =
  | TableCandidate
  | OrderedListCandidate
  | TimedListCandidate
  | BlockquoteCandidate
  | KeyValueRunCandidate;

export type CandidateKind = Candidate["kind"];

const parser = unified().use(remarkParse).use(remarkGfm);

/** Parse one text part to mdast. Exposed for tests; the walk is `detectCandidates`. */
export function parseMarkdown(text: string): Root {
  return parser.parse(text) as unknown as Root;
}

interface Link extends Node {
  type: "link";
  url: string;
  title?: string | null;
  children: Node[];
}
interface Text extends Node {
  type: "text";
  value: string;
}

/** A stretch of the source that reads as `text` once its markup is flattened. */
interface Flattened extends CandidateSpan {
  text: string;
}

const MAILTO = /^mailto:/i;

/** The last character of `text` as a reader counts it: `𝒜` is one, not two halves. */
const lastCodePoint = (text: string): string => Array.from(text.slice(-2)).at(-1) ?? "";

/** Nodes that sit inside a line of text; any other node starts a new one. */
const INLINE = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "footnoteReference",
  "html",
]);

/**
 * Inline nodes that flatten to their text with nothing lost but a face. A
 * link's text is admitted only when it is made of these, so an image, a
 * reference-style one included, is never dropped with it.
 */
const PLAIN_INLINE = new Set(["text", "emphasis", "strong", "delete", "inlineCode"]);
const isPlainInline = (node: Node): boolean =>
  PLAIN_INLINE.has(node.type) && (node.children ?? []).every(isPlainInline);

/**
 * The text a link flattens to without losing anything, or null. That is a
 * link whose text is its own destination — what GFM makes of a bare address,
 * `<…>` or not — and nothing else: `[the docs](https://…)` would lose where it
 * points, a title would be dropped, and so would anything inside it that is
 * not plain text. A `mailto:` destination reads as the bare address (#167).
 */
function bareAddress(link: Link): string | null {
  if (link.title || !link.children.every(isPlainInline)) return null;
  const text = mdastToString(link);
  if (!text || (link.url !== text && link.url !== `mailto:${text}`)) return null;
  // A backtick is legal in an address, but a key-value run's value has its
  // backticks stripped as code-span markup, which would change the address.
  if (text.includes("`")) return null;
  return MAILTO.test(link.url) ? text.replace(MAILTO, "") : text;
}

/**
 * Replace every bare address in the tree with the text it flattens to, and
 * return where each one sat in the source. After this the tree carries a link
 * only where flattening would lose something, so `hasRichInline` keeps
 * rejecting exactly those. A `mailto:` typed as prose just before an email
 * address — GFM links the address and leaves the scheme outside it — goes
 * with it, so the address reads the same however it was written.
 */
function flattenBareAddresses(root: Node, source: string, out: Flattened[]): void {
  // The last character a reader sees before each text node, carried across
  // inline nodes and reset at every block, so `mailto:` is judged a word of
  // its own by what is on the page: `**not**mailto:` and `x**mailto:…**` are
  // the author's text, `(mailto:` and a scheme opening a line are schemes.
  const seenBefore = new Map<Node, string>();
  let last = "";
  const walk = (node: Node): void => {
    const children = node.children;
    if (!Array.isArray(children)) return;
    const block = !INLINE.has(node.type);
    if (block) last = "";
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "text") {
        seenBefore.set(child, last);
        last = lastCodePoint((child as Text).value) || last;
        continue;
      }
      if (child.type === "inlineCode") {
        last = lastCodePoint((child as Text).value) || last;
        continue;
      }
      if (child.type === "break") {
        last = "\n";
        continue;
      }
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const text = child.type === "link" ? bareAddress(child as Link) : null;
      if (text === null || typeof start !== "number" || typeof end !== "number") {
        walk(child);
        continue;
      }
      let from = start;
      const before = children[i - 1];
      // Read the scheme from the source, not the decoded prose: `mailto&#58;`
      // decodes to the same seven characters from eleven.
      const scheme = "mailto:".length;
      if (
        MAILTO.test((child as Link).url) &&
        before?.type === "text" &&
        before.position?.end.offset === start &&
        MAILTO.test(source.slice(start - scheme, start)) &&
        /mailto:$/i.test((before as Text).value)
      ) {
        const prose = (before as Text).value;
        const ahead = lastCodePoint(prose.slice(0, -scheme)) || (seenBefore.get(before) ?? "");
        if (!/[\p{L}\p{N}]/u.test(ahead)) {
          (before as Text).value = prose.slice(0, -scheme);
          from = start - scheme;
        }
      }
      children[i] = { type: "text", value: text, position: { start: { offset: from }, end: { offset: end } } } as Text;
      out.push({ start: from, end, text });
      last = lastCodePoint(text);
    }
    if (block) last = "";
  };
  walk(root);
}

/** The source between `start` and `end`, with every flattened stretch read as its text. */
function flatSource(source: string, span: CandidateSpan, flattened: readonly Flattened[]): string {
  let out = "";
  let at = span.start;
  for (const flat of flattened) {
    if (flat.start < span.start || flat.end > span.end) continue;
    out += source.slice(at, flat.start) + flat.text;
    at = flat.end;
  }
  return out + source.slice(at, span.end);
}

/**
 * Inline markup the kit's cells cannot hold. A candidate carrying any is
 * left as markdown: flattening a labelled link to its text would lose where
 * it points, and the plain render is not wrong, only less shaped. The
 * reference-style spellings (`[the docs][ref]`, `![alt][ref]`, `[^note]`)
 * point elsewhere just the same (#220). A bare address never gets here —
 * `flattenBareAddresses` has already made it text. Emphasis and code spans
 * flatten to their text with nothing lost but a face, so they pass — the
 * model writes `**Key**: \`value\`` far more often than it writes links.
 */
const REFERS_ELSEWHERE = new Set(["link", "image", "html", "linkReference", "imageReference", "footnoteReference"]);

function hasRichInline(node: Node): boolean {
  const type = node.type;
  if (REFERS_ELSEWHERE.has(type)) return true;
  return Array.isArray(node.children) && node.children.some((child) => hasRichInline(child));
}

function spanOf(node: RootContent): CandidateSpan | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

/**
 * A node's text on one line. `toString` emits nothing for a hard break, so
 * `Sail`, a break and `home` would read `Sailhome`; the break is a space
 * here (#240).
 */
function cellText(node: Node): string {
  return plainText(node).replace(/\s+/g, " ").trim();
}

function plainText(node: Node): string {
  if (node.type === "break") return " ";
  if (Array.isArray(node.children)) return node.children.map(plainText).join("");
  return mdastToString(node);
}

function tableCandidate(node: Table, id: string, span: CandidateSpan): TableCandidate | null {
  if (node.children.length < 2) return null;
  if (node.children.some((row) => row.children.some((cell) => hasRichInline(cell)))) return null;
  const [head, ...body] = node.children;
  const headers = head!.children.map(cellText);
  const width = headers.length;
  if (width < 2) return null;
  const rows = body.map((row) => {
    const cells = row.children.map(cellText);
    // GFM pads or truncates ragged rows to the header width; mirror that so
    // the kit never receives a row shorter than its columns.
    while (cells.length < width) cells.push("");
    return cells.slice(0, width);
  });
  const align = (node.align ?? []).slice(0, width);
  while (align.length < width) align.push(null);
  return { kind: "table", id, headers, align, rows, ...span };
}

/**
 * The first paragraph is the item's title; the rest of its prose is detail.
 * An item holding any other block — a nested list, code, a table, a quote, a
 * heading, a definition — is not one the kit can draw without losing it (#240).
 */
function itemParts(item: ListItem): { title: string; detail?: string } | null {
  const paragraphs = item.children.filter((child): child is Paragraph => child.type === "paragraph");
  if (paragraphs.length === 0 || paragraphs.length !== item.children.length) return null;
  if (paragraphs.some((paragraph) => hasRichInline(paragraph))) return null;
  const title = cellText(paragraphs[0]!);
  const detail = paragraphs.slice(1).map(cellText).filter(Boolean).join(" ");
  return detail ? { title, detail } : { title };
}

function orderedListCandidate(
  node: List,
  id: string,
  span: CandidateSpan
): OrderedListCandidate | null {
  if (node.children.length < 2) return null;
  // A list continuing from 5 is numbered 5, 6 in markdown; `StepList` counts
  // from 1, so such a list stays as it is rather than being renumbered.
  if (typeof node.start === "number" && node.start !== 1) return null;
  const items: OrderedListCandidate["items"] = [];
  for (const item of node.children) {
    const parts = itemParts(item);
    if (!parts) return null;
    items.push(
      typeof item.checked === "boolean" ? { ...parts, checked: item.checked } : parts
    );
  }
  return { kind: "ordered_list", id, items, ...span };
}

/**
 * A time token at the head of a line: a clock time, a four-digit year, a
 * day-of-week or month name with an optional day number. Deliberately
 * narrow — a bullet list is only a timeline candidate when the reader can
 * see the times.
 */
const TIME_HEAD =
  /^((?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]m)?|\d{4}|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:\s\d{1,2})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2}(?:,?\s\d{4})?|Day\s\d+)\s*(?:[—–\-:·]\s*)?(.+)$/i;

function timedListCandidate(node: List, id: string, span: CandidateSpan): TimedListCandidate | null {
  if (node.children.length < 2) return null;
  const items: TimedListCandidate["items"] = [];
  for (const item of node.children) {
    const parts = itemParts(item);
    if (!parts) return null;
    const match = TIME_HEAD.exec(parts.title);
    if (!match) return null;
    const entry: TimedListCandidate["items"][number] = { time: match[1]!, title: match[2]!.trim() };
    if (parts.detail) entry.detail = parts.detail;
    items.push(entry);
  }
  return { kind: "timed_list", id, items, ...span };
}

/** `**Key:** value`, `**Key**: value`, `Key: value` — one row of a receipt-shaped run. */
const KV_LINE = /^(?:\*\*([^*:]{1,40})(?::\*\*|\*\*:)|([A-Z][^:]{0,39}):)\s+(.+)$/;

function kvRows(lines: string[]): Array<{ k: string; v: string }> | null {
  const rows: Array<{ k: string; v: string }> = [];
  for (const line of lines) {
    const match = KV_LINE.exec(line.trim());
    if (!match) return null;
    // Read from the raw source (the `**` around the key is the signal), so
    // a code span's backticks are still here; the kit's cells are plain text.
    rows.push({ k: (match[1] ?? match[2] ?? "").trim(), v: match[3]!.replace(/`/g, "").trim() });
  }
  return rows.length >= 2 ? rows : null;
}

/** A paragraph of key-colon-value lines, or a bullet list whose items are such lines. */
function kvRunCandidate(
  node: Paragraph | List,
  id: string,
  span: CandidateSpan,
  source: string,
  flattened: readonly Flattened[]
): KeyValueRunCandidate | null {
  if (node.type === "paragraph") {
    if (hasRichInline(node)) return null;
    // Raw source lines, not `toString`: the `**` around the key is the
    // signal, and toString would strip it. A bare address still reads as its
    // text, so `<…>` does not reach a cell.
    const lines = flatSource(source, span, flattened).split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
    const rows = kvRows(lines);
    return rows ? { kind: "kv_run", id, rows, ...span } : null;
  }
  if (node.ordered || node.children.length < 2) return null;
  const lines: string[] = [];
  for (const item of node.children) {
    const paragraphs = item.children.filter((child): child is Paragraph => child.type === "paragraph");
    if (paragraphs.length !== 1 || item.children.length !== 1 || hasRichInline(paragraphs[0]!)) return null;
    const itemSpan = spanOf(paragraphs[0]!);
    if (!itemSpan) return null;
    lines.push(flatSource(source, itemSpan, flattened));
  }
  const rows = kvRows(lines);
  return rows ? { kind: "kv_run", id, rows, ...span } : null;
}

const ATTRIBUTION = /^(?:[—–-]\s*|Source:\s*|From:\s*)(.+)$/;

function blockquoteCandidate(
  node: Blockquote,
  next: RootContent | undefined,
  id: string,
  span: CandidateSpan
): BlockquoteCandidate | null {
  if (node.children.length === 0) return null;
  if (node.children.some((child) => child.type !== "paragraph" || hasRichInline(child))) return null;
  const text = node.children.map((child) => cellText(child)).join("\n\n");
  if (!text) return null;
  const candidate: BlockquoteCandidate = { kind: "blockquote", id, text, ...span };
  if (next?.type === "paragraph" && !hasRichInline(next)) {
    const line = cellText(next);
    const match = ATTRIBUTION.exec(line);
    const nextSpan = spanOf(next);
    if (match && nextSpan && line.length <= 120) {
      candidate.source = match[1]!.trim();
      candidate.end = nextSpan.end;
    }
  }
  return candidate;
}

/**
 * The candidates in one text part, in document order. `ids` are stable
 * within the part (`c0`, `c1`, …) and double as the state keys of the
 * classification request.
 */
export function detectCandidates(text: string): Candidate[] {
  if (!text.trim()) return [];
  const root = parseMarkdown(text);
  const flattened: Flattened[] = [];
  // Document order, which `flatSource` relies on: the walk is depth-first.
  flattenBareAddresses(root, text, flattened);
  const out: Candidate[] = [];
  const children = root.children;
  const consumed = new Set<number>();
  for (let i = 0; i < children.length; i++) {
    if (consumed.has(i)) continue;
    const node = children[i]!;
    const span = spanOf(node);
    if (!span) continue;
    const id = `c${out.length}`;
    let candidate: Candidate | null = null;
    switch (node.type) {
      case "table":
        candidate = tableCandidate(node as Table, id, span);
        break;
      case "list": {
        const list = node as List;
        candidate = list.ordered
          ? orderedListCandidate(list, id, span)
          : (timedListCandidate(list, id, span) ?? kvRunCandidate(list, id, span, text, flattened));
        break;
      }
      case "blockquote": {
        candidate = blockquoteCandidate(node as Blockquote, children[i + 1], id, span);
        if (candidate?.source) consumed.add(i + 1);
        break;
      }
      case "paragraph":
        candidate = kvRunCandidate(node as Paragraph, id, span, text, flattened);
        break;
      default:
        break;
    }
    if (candidate) out.push(candidate);
  }
  return out;
}
