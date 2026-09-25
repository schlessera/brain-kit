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

/** A string as a YAML scalar: plain when that reads back as the same string, else double-quoted. */
function plainOrQuoted(value: string): string {
  const plain =
    /^[\p{L}\p{N}][\p{L}\p{N}_.\-/]*$/u.test(value) &&
    !/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

function formatValue(value: string | string[], quote: Token["quote"]): string {
  if (Array.isArray(value)) return `[${value.map(plainOrQuoted).join(", ")}]`;
  if (quote === "'") return `'${value.replace(/'/g, "''")}'`;
  if (quote === '"') return JSON.stringify(value);
  return plainOrQuoted(value);
}

/** Compare as the file will be read: dates as `YYYY-MM-DD`, lists entry by entry. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function parseData(text: string): Record<string, unknown> | null {
  try {
    // Options bypass gray-matter's cache, which shares one data object
    // between byte-identical inputs (#142).
    return normalize(matter(text, {}).data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * `text` with each key in `updates` set (or removed, for null), every other
 * byte kept. A missing key is appended at the end of the frontmatter. Returns
 * null when the text has no frontmatter, a key's current value is in a form
 * this does not rewrite (a block scalar, a multi-line flow sequence, a nested
 * map), or the result does not read back as intended.
 */
export function editFrontmatter(text: string, updates: Record<string, FrontmatterValue>): string | null {
  const bounds = frontmatterBounds(text);
  if (!bounds) return null;
  const block = text.slice(bounds.start, bounds.end);
  const edits: [number, number, string][] = [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}[ \\t]*:`, "m").exec(block);
    if (!match) {
      if (value !== null) appended.push(`${key}: ${formatValue(value, null)}\n`);
      continue;
    }
    const lineStart = match.index;
    let lineEnd = block.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = block.length;
    // Lines that belong to this key's value: indented, or `- ` list entries.
    let valueEnd = lineEnd;
    while (valueEnd < block.length) {
      const next = block.indexOf("\n", valueEnd + 1);
      const line = block.slice(valueEnd + 1, next === -1 ? block.length : next);
      if (!/^(?:[ \t]+\S|-(?:[ \t]|$))/.test(line)) break;
      valueEnd = next === -1 ? block.length : next;
    }

    if (value === null) {
      edits.push([lineStart, Math.min(valueEnd + 1, block.length), ""]);
      continue;
    }

    let i = match.index + match[0].length;
    while (block[i] === " " || block[i] === "\t") i++;
    const inlineEmpty = i >= lineEnd || block[i] === "#" || block[i] === "\r";
    if (inlineEmpty) {
      // A block value (a `- item` list, most often): replaced whole, on the
      // key's line, keeping any comment after the colon.
      if (valueEnd === lineEnd) {
        edits.push([match.index + match[0].length, match.index + match[0].length, ` ${formatValue(value, null)}`]);
      } else {
        const comment = block.slice(i, lineEnd).replace(/\r$/, "");
        edits.push([match.index + match[0].length, valueEnd, ` ${formatValue(value, null)}${comment ? ` ${comment}` : ""}`]);
      }
      continue;
    }
    if (valueEnd !== lineEnd) return null;
    if (block[i] === "|" || block[i] === ">" || block[i] === "{") return null;
    const token = block[i] === "[" ? readFlow(block, i) : readScalar(block, i);
    if (!token) return null;
    if (!/^[ \t]*(#.*)?\r?$/.test(block.slice(token.end, lineEnd))) return null;
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

  // The edit must read back as exactly the requested change.
  const before = parseData(text);
  const after = parseData(result);
  if (!before || !after) return null;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(updates)])) {
    if (key in updates) {
      const wanted = updates[key];
      if (wanted === null ? key in after : JSON.stringify(after[key]) !== JSON.stringify(wanted)) return null;
    } else if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
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
