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

import matter from "gray-matter";

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
  const close = text.lastIndexOf("\n---", length);
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

/** Parsed data with its types kept for comparison: a Date is not the string it prints as. */
function typed(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(typed);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typed(v)]));
  }
  return value;
}

function parseData(text: string): Record<string, unknown> | null {
  try {
    // Options bypass gray-matter's cache, which shares one data object
    // between byte-identical inputs (#142).
    return matter(text, {}).data as Record<string, unknown>;
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
  /** Offset of the line's end, before its `\n`. */
  end: number;
  text: string;
}

function splitLines(block: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < block.length) {
    const nl = block.indexOf("\n", start);
    const end = nl === -1 ? block.length : nl;
    lines.push({ start, end, text: block.slice(start, end) });
    start = end + 1;
  }
  return lines;
}

const COMMENT_LINE = /^[ \t]*#/;
const BLANK_LINE = /^[ \t]*\r?$/;

/**
 * `text` with each key in `updates` set (or removed, for null), every other
 * byte kept. A missing key is appended at the end of the frontmatter.
 *
 * It rewrites a top-level key (plain or quoted) whose value is a one-line
 * scalar or flow sequence, a block list, an empty value, or a block scalar
 * (`|`, `>`). Comment lines inside a value's lines stay, except in a block
 * scalar, where they are its text. It refuses (null) anything else, such as a
 * multi-line flow sequence, a multi-line plain scalar, a flow map, or keys
 * indented under the fence; and it refuses when the result does not read back
 * as exactly the requested values, types included, with every other key
 * unchanged. Callers then fall back to their serializer.
 */
export function editFrontmatter(text: string, updates: Record<string, FrontmatterValue>): string | null {
  const bounds = frontmatterBounds(text);
  if (!bounds) return null;
  const block = text.slice(bounds.start, bounds.end);
  const lines = splitLines(block);
  const edits: [number, number, string][] = [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyPattern = new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')[ \\t]*:(?=[ \\t\\r]|$)`);
    const k = lines.findIndex((line) => keyPattern.test(line.text));
    if (k === -1) {
      if (value !== null) appended.push(`${key}: ${formatValue(value, null)}\n`);
      continue;
    }
    const keyLine = lines[k]!;
    const colonEnd = keyLine.start + keyPattern.exec(keyLine.text)![0].length;

    // The value's lines: indented or `- ` entries after the key, up to the
    // last one before the next top-level line (blank lines between them count).
    let last = k;
    for (let j = k + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (/^(?:[ \t]+\S|-(?:[ \t]|\r?$))/.test(t)) last = j;
      else if (!BLANK_LINE.test(t)) break;
    }
    const valueLines = lines.slice(k + 1, last + 1);

    let i = colonEnd;
    while (block[i] === " " || block[i] === "\t") i++;
    const inline = block.slice(i, keyLine.end).replace(/\r$/, "");
    const blockScalar = /^[|>]/.test(inline);
    // Comment lines survive the edit, except inside a block scalar, where
    // they are text.
    const comments = blockScalar ? [] : valueLines.filter((line) => COMMENT_LINE.test(line.text)).map((line) => line.text);
    const content = blockScalar
      ? valueLines
      : valueLines.filter((line) => !COMMENT_LINE.test(line.text) && !BLANK_LINE.test(line.text));
    const rangeEnd = last > k ? lines[last]!.end : keyLine.end;
    const kept = comments.map((comment) => `\n${comment}`).join("");

    if (value === null) {
      // The key line and its value go; its comment lines stay where they were.
      const next = rangeEnd < block.length ? rangeEnd + 1 : rangeEnd;
      edits.push([keyLine.start, next, comments.map((comment) => `${comment}\n`).join("")]);
      continue;
    }

    if (inline === "" || inline.startsWith("#")) {
      // An empty or block value (a `- item` list, most often): replaced on the
      // key's line, keeping the key's comment and the comment lines.
      edits.push([colonEnd, rangeEnd, ` ${formatValue(value, null)}${inline ? ` ${inline}` : ""}${kept}`]);
      continue;
    }
    if (blockScalar) {
      // `|` or `>` and its indented text, replaced; a comment after the
      // indicator stays.
      const comment = /[ \t]#.*$/.exec(inline)?.[0].trim() ?? "";
      edits.push([i, rangeEnd, `${formatValue(value, null)}${comment ? ` ${comment}` : ""}`]);
      continue;
    }
    if (content.length > 0) return null;
    if (block[i] === "{") return null;
    const token = block[i] === "[" ? readFlow(block, i) : readScalar(block, i);
    if (!token) return null;
    if (!/^[ \t]*(#.*)?\r?$/.test(block.slice(token.end, keyLine.end))) return null;
    edits.push([token.start, token.end, formatValue(value, Array.isArray(value) ? null : token.quote)]);
  }

  let newBlock = block;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    newBlock = newBlock.slice(0, start) + replacement + newBlock.slice(end);
  }
  if (appended.length > 0) {
    if (newBlock.length > 0 && !newBlock.endsWith("\n")) newBlock += "\n";
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
  const parsed = matter(raw, {});
  const data: Record<string, unknown> = { ...parsed.data };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete data[key];
    else data[key] = value;
  }
  return stringifyDocument(appendTo(parsed.content), data);
}
