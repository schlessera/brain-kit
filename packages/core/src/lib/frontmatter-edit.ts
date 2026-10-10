/**
 * Edit a few top-level frontmatter keys on the raw text (#449).
 *
 * Serializing parsed frontmatter back (gray-matter's stringify) drops YAML
 * comments, removes optional quotes and restyles sequences, so a one-field
 * change rewrote bytes nobody asked to change. This edits only the keys it is
 * given and keeps every other byte of the file: comments, quoting, key order,
 * flow or block style, blank lines, the body. The result is parsed again and
 * must hold exactly the requested values with every other key unchanged, or
 * the edit is refused (null) and the caller falls back to its serializer.
 *
 * `brain tags --apply` (#391) edits entries inside `tags:` the same way; this
 * helper replaces whole values.
 */

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

import { frontmatterLength } from "./document-parts.js";
import { stringifyDocument } from "./frontmatter.js";

/** A new value: a string, a list of strings (written in flow style), or null to remove the key. */
export type FrontmatterValue = string | string[] | null;

interface Token {
  start: number;
  end: number;
  quote: '"' | "'" | null;
}

/** The frontmatter's inner text: after the opening `---` line, up to the closing `---` line. */
function frontmatterBounds(text: string): { start: number; end: number } | null {
  const length = frontmatterLength(text);
  if (length === 0) return null;
  // The first `\n---` after the opening fence, as frontmatterLength finds it:
  // a later `---` or `----` line is a horizontal rule in the body.
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const close = text.indexOf("\n---", bom + 3);
  const start = text.indexOf("\n") + 1;
  return close !== -1 && start > 0 && start <= close + 1 ? { start, end: close + 1 } : null;
}

/** One scalar at `i`: quoted to its closing quote, or plain up to the line end or ` #`. */
function readScalar(block: string, i: number): Token | null {
  const quote = block[i];
  if (quote === '"' || quote === "'") {
    for (let j = i + 1; j < block.length; j++) {
      const c = block[j];
      if (c === "\n" || c === "\r") return null;
      if (quote === '"' && c === "\\") j++;
      else if (quote === "'" && c === "'" && block[j + 1] === "'") j++;
      else if (c === quote) return { start: i, end: j + 1, quote };
    }
    return null;
  }
  let j = i;
  while (j < block.length && block[j] !== "\n" && block[j] !== "\r" && !/^[ \t]#/.test(block.slice(j, j + 2))) j++;
  const raw = block.slice(i, j).replace(/[ \t]+$/, "");
  return raw ? { start: i, end: i + raw.length, quote: null } : null;
}

/** A one-line flow sequence at `i`: up to its `]`, quoted entries skipped whole. */
function readFlow(block: string, i: number): Token | null {
  for (let j = i + 1; j < block.length; j++) {
    const c = block[j];
    if (c === "\n" || c === "\r") return null;
    if (c === "[" || c === "{") return null;
    if (c === '"' || c === "'") {
      const token = readScalar(block, j);
      if (!token) return null;
      j = token.end - 1;
    } else if (c === "]") {
      return { start: i, end: j + 1, quote: null };
    }
  }
  return null;
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A string as a YAML scalar: plain when that reads back as the same string,
 * else double-quoted. A bare `YYYY-MM-DD` stays plain only where `dates` is
 * true: a scalar like `updated` is a date by convention, but a list entry must
 * stay a string, and plain it would read back as a Date.
 */
function plainOrQuoted(value: string, dates: boolean): string {
  const plain =
    /^[\p{L}\p{N}][\p{L}\p{N}_.\-/]*$/u.test(value) &&
    !/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+)$/i.test(value) &&
    (dates ? !/^\d{4}-\d{2}-\d{2}./.test(value) : !/^\d{4}-\d{1,2}-\d{1,2}/.test(value));
  return plain ? value : JSON.stringify(value);
}

function formatValue(value: string | string[], quote: Token["quote"]): string {
  if (Array.isArray(value)) return `[${value.map((entry) => plainOrQuoted(entry, false)).join(", ")}]`;
  if (quote === "'") return `'${value.replace(/'/g, "''")}'`;
  if (quote === '"') return JSON.stringify(value);
  return plainOrQuoted(value, true);
}

/**
 * Parsed data with its types kept for comparison: a Date is not the string it
 * prints as. A YAML alias can make a value contain itself; a value met again
 * inside itself becomes a marker instead of being walked forever.
 */
function typed(value: unknown, open: Set<object> = new Set()): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value && typeof value === "object") {
    if (open.has(value)) return { $cycle: true };
    open.add(value);
    const out = Array.isArray(value)
      ? value.map((v) => typed(v, open))
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typed(v, open)]));
    open.delete(value);
    return out;
  }
  return value;
}

function parseData(text: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(text).data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whether a parsed value is what was asked for: a list of exactly these strings, or the string (a bare date may read back as that Date). */
function readsAs(actual: unknown, wanted: string | string[]): boolean {
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && actual.length === wanted.length && actual.every((v, i) => v === wanted[i]);
  }
  if (actual instanceof Date) return BARE_DATE.test(wanted) && actual.toISOString().slice(0, 10) === wanted;
  return actual === wanted;
}

interface Line {
  start: number;
  /** Offset where the line's text ends, before its terminator. */
  end: number;
  /** The line without its terminator. */
  text: string;
  /** `\n`, `\r\n`, or empty for a last line without one. */
  eol: string;
}

function splitLines(block: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < block.length) {
    const nl = block.indexOf("\n", start);
    const stop = nl === -1 ? block.length : nl;
    const end = stop > start && block[stop - 1] === "\r" && nl !== -1 ? stop - 1 : stop;
    lines.push({ start, end, text: block.slice(start, end), eol: nl === -1 ? "" : block.slice(end, nl + 1) });
    start = stop + 1;
  }
  return lines;
}

const COMMENT_LINE = /^[ \t]*#/;
const BLANK_LINE = /^[ \t]*$/;
const indentOf = (text: string) => /^[ \t]*/.exec(text)![0].length;

/**
 * The lines after key line `k` that make up its value, as the index of the
 * last one (k when the value is on the key line only).
 *
 * A block scalar owns every line indented at least as far as its content
 * (its indentation indicator, else its first non-blank line), blank lines
 * between them included. Any other value owns the indented lines and the
 * `- ` entries after the key, with comment lines (at any column) and blank
 * lines between them. Trailing blank and comment lines are never part of it.
 */
function valueEnd(lines: Line[], k: number, blockScalar: string | null): number {
  let last = k;
  if (blockScalar !== null) {
    // `|4`, `|-4`, `>+2`: an explicit indentation indicator.
    const explicit = /^[|>][+-]?([1-9])/.exec(blockScalar);
    let indent = explicit ? Number(explicit[1]) : 0;
    for (let j = k + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (BLANK_LINE.test(t)) continue;
      if (indent === 0) indent = indentOf(t);
      if (indent === 0 || indentOf(t) < indent) break;
      last = j;
    }
    return last;
  }
  for (let j = k + 1; j < lines.length; j++) {
    const t = lines[j]!.text;
    if (/^(?:[ \t]+\S|-(?:[ \t]|$))/.test(t) && !COMMENT_LINE.test(t)) last = j;
    else if (!BLANK_LINE.test(t) && !COMMENT_LINE.test(t)) break;
  }
  return last;
}

/**
 * `text` with each key in `updates` set (or removed, for null), every other
 * byte kept. A missing key is appended at the end of the frontmatter, with
 * the frontmatter's own line ending.
 *
 * It rewrites a top-level key whose value is a one-line scalar or flow
 * sequence, a block list, an empty value, or a block scalar (`|`, `>`). The
 * key may be plain or quoted, but a quoted key spelled with escapes
 * (`"sta\\u0074us"`) is not recognised. Comment and blank lines among a
 * value's lines stay, except inside a block scalar, where they are its text;
 * comment and blank lines after a value are outside it and stay too. A known
 * limit: in a block scalar whose first text line is whitespace only, the
 * extent is inferred from the next line, which can differ from YAML's reading. It refuses (null)
 * anything else, such as a multi-line flow sequence, a multi-line plain
 * scalar, a flow map, or keys indented under the fence; and it refuses when
 * the result does not read back as exactly the requested values, types
 * included, with every other key unchanged. Callers then fall back to their
 * serializer.
 */
export function editFrontmatter(text: string, updates: Record<string, FrontmatterValue>): string | null {
  const bounds = frontmatterBounds(text);
  if (!bounds) return null;
  const block = text.slice(bounds.start, bounds.end);
  const lines = splitLines(block);
  // The opening fence's line ending is the file's convention.
  const eol = text[text.indexOf("\n") - 1] === "\r" ? "\r\n" : "\n";
  const edits: [number, number, string][] = [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyPattern = new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')[ \\t]*:(?=[ \\t]|$)`);
    const k = lines.findIndex((line) => keyPattern.test(line.text));
    if (k === -1) {
      if (value !== null) appended.push(`${key}: ${formatValue(value, null)}${eol}`);
      continue;
    }
    const keyLine = lines[k]!;
    const colonEnd = keyLine.start + keyPattern.exec(keyLine.text)![0].length;
    let i = colonEnd;
    while (block[i] === " " || block[i] === "\t") i++;
    const inline = block.slice(i, keyLine.end);
    const blockScalar = /^[|>]/.test(inline) ? inline : null;
    const last = valueEnd(lines, k, blockScalar);
    const valueLines = lines.slice(k + 1, last + 1);
    // The whole-line span from the key line through the value's last line.
    const spanEnd = lines[last]!.end + lines[last]!.eol.length;
    // Comment and blank lines among the value's lines stay, with their own
    // endings; in a block scalar every line is text.
    const kept = blockScalar === null
      ? valueLines.filter((line) => COMMENT_LINE.test(line.text) || BLANK_LINE.test(line.text)).map((line) => line.text + line.eol).join("")
      : "";

    if (value === null) {
      edits.push([keyLine.start, spanEnd, kept]);
      continue;
    }

    const keyText = block.slice(keyLine.start, colonEnd);
    if (inline === "" || inline.startsWith("#") || blockScalar !== null) {
      // An empty, block-list or block-scalar value: rewritten on the key's
      // line, keeping a comment after the colon or the indicator.
      const comment = inline.startsWith("#") ? inline : /[ \t](#.*)$/.exec(inline)?.[1] ?? "";
      edits.push([keyLine.start, spanEnd, `${keyText} ${formatValue(value, null)}${comment ? ` ${comment}` : ""}${keyLine.eol}${kept}`]);
      continue;
    }
    if (last > k) return null;
    if (block[i] === "{") return null;
    const token = block[i] === "[" ? readFlow(block, i) : readScalar(block, i);
    if (!token) return null;
    if (!/^[ \t]*(#.*)?$/.test(block.slice(token.end, keyLine.end))) return null;
    edits.push([token.start, token.end, formatValue(value, Array.isArray(value) ? null : token.quote)]);
  }

  let newBlock = block;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    newBlock = newBlock.slice(0, start) + replacement + newBlock.slice(end);
  }
  if (appended.length > 0) {
    if (newBlock.length > 0 && !newBlock.endsWith("\n")) newBlock += eol;
    newBlock += appended.join("");
  }
  const result = text.slice(0, bounds.start) + newBlock + text.slice(bounds.end);

  // The edit must read back as exactly the requested change, types included.
  const before = parseData(text);
  const after = parseData(result);
  if (!before || !after) return null;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(updates)])) {
    if (key in updates) {
      const wanted = updates[key];
      if (wanted === null ? key in after : !readsAs(after[key], wanted)) return null;
    } else if (JSON.stringify(typed(after[key])) !== JSON.stringify(typed(before[key]))) {
      return null;
    }
  }
  return result;
}

/**
 * A document with frontmatter `updates` applied and, optionally, `append`
 * added to the end of its body: through `editFrontmatter` when it can,
 * keeping every other byte, else through the serializer as before. The body
 * is never re-serialized on the first path.
 */
export function updateDocument(raw: string, updates: Record<string, FrontmatterValue>, append?: string): string {
  const appendTo = (body: string) => (append ? `${body.replace(/\n*$/, "\n\n")}${append.trim()}\n` : body);
  const edited = editFrontmatter(raw, updates);
  if (edited !== null) {
    const length = frontmatterLength(edited);
    return edited.slice(0, length) + appendTo(edited.slice(length));
  }
  const parsed = parseFrontmatter(raw);
  const data: Record<string, unknown> = { ...parsed.data };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete data[key];
    else data[key] = value;
  }
  return stringifyDocument(appendTo(parsed.content), data);
}
