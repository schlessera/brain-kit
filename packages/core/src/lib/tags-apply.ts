/**
 * `brain tags --apply`: migrate frontmatter tags from old forms to canonical
 * ones.
 *
 * The rewrite edits only the entries of the `tags:` key inside the
 * frontmatter fence, on the raw text. Every other byte of the file stays as
 * it was: comments, quoting, key order, flow or block style, the body. Parsed
 * frontmatter is read, never written back, and always parsed with options so
 * gray-matter's cache cannot hand one file's data object to another (#142).
 * Each rewrite is parsed again and must yield exactly the planned tags, or
 * the file is skipped.
 */

import matter from "gray-matter";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { getMarkdownFiles } from "./indexer.js";
import { findRedundantTags, tagReport } from "./tags.js";
import type { Taxonomy } from "./taxonomy.js";

export interface TagApplyOptions {
  /** Apply every variant group, not only those whose canonical tag is in `vocabulary`. */
  groups?: boolean;
  /** Also remove tags that repeat the document's type or a directory of its path. */
  redundant?: boolean;
  /** Only change this old tag. */
  only?: string;
  dryRun?: boolean;
}

export interface TagApplyReport {
  files: { path: string; from: string[]; to: string[] }[];
  skipped: { path: string; reason: string }[];
}

/**
 * Old tag → canonical tag: every `aliases` entry, then every variant group
 * whose canonical is a vocabulary member (every group with `groups`). An
 * alias chain (`a → b`, `b → c`) resolves to its end; a cycle keeps the tag.
 */
export function planRenames(root: string, taxonomy: Taxonomy, groups: boolean): Map<string, string> {
  const config = taxonomy.tags;
  const renames = new Map<string, string>(Object.entries(config?.aliases ?? {}));
  const vocabulary = new Set(config?.vocabulary ?? []);
  for (const group of tagReport(root, taxonomy).variantGroups) {
    if (!groups && !vocabulary.has(group.canonical)) continue;
    for (const { tag } of group.members) {
      if (tag !== group.canonical && !renames.has(tag)) renames.set(tag, group.canonical);
    }
  }
  const resolved = new Map<string, string>();
  for (const from of renames.keys()) {
    const seen = new Set([from]);
    let to = renames.get(from)!;
    while (renames.has(to) && !seen.has(to)) {
      seen.add(to);
      to = renames.get(to)!;
    }
    if (to !== from) resolved.set(from, to);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Raw frontmatter editing
// ---------------------------------------------------------------------------

/**
 * Where the frontmatter's inner text lies, by the rule gray-matter applies
 * when core reads a document: the file opens with `---` not followed by a
 * fourth `-`, and the block runs to the first `\n---`.
 */
function frontmatterBounds(text: string): { start: number; end: number } | null {
  if (!text.startsWith("---") || text.charAt(3) === "-") return null;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return null;
  const start = text.indexOf("\n") + 1;
  return start > 0 && start <= close + 1 ? { start, end: close + 1 } : null;
}

interface Token {
  /** Offsets of the scalar in the block text, quotes included. */
  start: number;
  end: number;
  value: string;
}

/** Read one scalar at `i`: quoted, or plain up to a stop character or ` #`. */
function readScalar(text: string, i: number, stops: string): Token | null {
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    let j = i + 1;
    let value = "";
    while (j < text.length) {
      const c = text[j];
      if (quote === "'" && c === "'" && text[j + 1] === "'") {
        value += "'";
        j += 2;
      } else if (quote === '"' && c === "\\") {
        const next = text[j + 1];
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        j += 2;
      } else if (c === quote) {
        return { start: i, end: j + 1, value };
      } else if (c === "\n" || c === "\r") {
        return null;
      } else {
        value += c;
        j++;
      }
    }
    return null;
  }
  let j = i;
  while (j < text.length && !stops.includes(text[j]) && !"\r\n".includes(text[j]) && !/^[ \t]#/.test(text.slice(j, j + 2))) {
    j++;
  }
  const raw = text.slice(i, j).replace(/[ \t]+$/, "");
  return raw ? { start: i, end: i + raw.length, value: raw } : null;
}

/** A tag as YAML: plain when that reads back as the same string, else double-quoted. */
function yamlScalar(tag: string): string {
  const plain =
    /^[\p{L}\p{N}][\p{L}\p{N}_.\-/]*$/u.test(tag) &&
    !/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+)$/i.test(tag);
  return plain ? tag : JSON.stringify(tag);
}

type Located =
  | { kind: "flow"; items: Token[]; open: number; close: number }
  | { kind: "block"; items: { token: Token; lineStart: number; lineEnd: number }[]; keyEnd: number }
  | { kind: "unsupported"; reason: string };

/** Find the top-level `tags:` entry in the frontmatter's inner text. */
function locateTags(block: string): Located | null {
  const key = /^tags[ \t]*:/m.exec(block);
  if (!key) return null;
  let i = key.index + key[0].length;
  while (block[i] === " " || block[i] === "\t") i++;

  if (block[i] === "[") {
    const open = i;
    const items: Token[] = [];
    i++;
    for (;;) {
      while (block[i] === " " || block[i] === "\t") i++;
      if (block[i] === "]") return { kind: "flow", items, open, close: i };
      if (block[i] === "\n" || block[i] === "\r" || i >= block.length) {
        return { kind: "unsupported", reason: "the tags flow sequence spans more than one line" };
      }
      const token = readScalar(block, i, ",]");
      if (!token) return { kind: "unsupported", reason: "a tags entry is not a scalar the rewrite can read" };
      items.push(token);
      i = token.end;
      while (block[i] === " " || block[i] === "\t") i++;
      if (block[i] === ",") i++;
      else if (block[i] !== "]") return { kind: "unsupported", reason: "a tags entry is not a scalar the rewrite can read" };
    }
  }

  // Block style: nothing but an optional comment after the colon, then `- item` lines.
  if (block[i] !== "\n" && block[i] !== "\r" && block[i] !== "#" && i < block.length) {
    return { kind: "unsupported", reason: "tags is not a list" };
  }
  const keyEnd = block.indexOf("\n", i);
  const items: { token: Token; lineStart: number; lineEnd: number }[] = [];
  let lineStart = keyEnd + 1;
  let dashIndent: number | null = null;
  while (keyEnd !== -1 && lineStart < block.length) {
    const nl = block.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? block.length : nl;
    const line = block.slice(lineStart, lineEnd);
    if (/^[ \t]*(#.*)?\r?$/.test(line)) {
      lineStart = lineEnd + 1;
      continue;
    }
    const item = /^([ \t]*)-[ \t]+/.exec(line);
    if (!item) {
      // Anything else ends the list, unless it is indented deeper than the dashes.
      if (dashIndent !== null && /^[ \t]/.test(line) && line.search(/\S/) > dashIndent) {
        return { kind: "unsupported", reason: "a tags entry spans more than one line" };
      }
      break;
    }
    dashIndent ??= item[1].length;
    const token = readScalar(block, lineStart + item[0].length, "");
    if (!token || !/^[ \t]*(#.*)?\r?$/.test(block.slice(token.end, lineEnd))) {
      return { kind: "unsupported", reason: "a tags entry is not a scalar the rewrite can read" };
    }
    items.push({ token, lineStart, lineEnd });
    lineStart = lineEnd + 1;
  }
  return { kind: "block", items, keyEnd };
}

/**
 * Rewrite the `tags:` entries of one document so they read `rename(tag)`,
 * dropping `drop(tag)` ones and later duplicates. Returns the new text, or a
 * reason the file is left alone.
 */
export function rewriteTags(
  text: string,
  plan: (tags: string[]) => string[]
): { text: string; from: string[]; to: string[] } | { skip: string } | null {
  let data: Record<string, unknown>;
  try {
    // Options bypass gray-matter's cache, which shares one data object between
    // byte-identical inputs (#142).
    data = matter(text, {}).data;
  } catch {
    return { skip: "frontmatter does not parse" };
  }
  if (!Array.isArray(data.tags) || data.tags.length === 0) return null;
  const from = data.tags.map((t) => String(t));
  const to = plan(from);
  if (to.length === from.length && to.every((t, i) => t === from[i])) return null;

  const bounds = frontmatterBounds(text);
  if (!bounds) return { skip: "no frontmatter block around the tags" };
  const block = text.slice(bounds.start, bounds.end);
  const located = locateTags(block);
  if (!located) return { skip: "the tags key is not a plain top-level `tags:` line" };
  if (located.kind === "unsupported") return { skip: located.reason };

  const tokens = located.kind === "flow" ? located.items : located.items.map((i) => i.token);
  if (tokens.length !== from.length || tokens.some((t, i) => t.value !== from[i])) {
    return { skip: "the tags entries do not read back as the parsed tags" };
  }

  // Each original entry becomes its renamed tag once, in first-seen order.
  const next = plan(from);
  const kept = new Set<string>();
  const keep: (string | null)[] = from.map((tag) => {
    const renamed = plan([tag])[0];
    if (renamed === undefined || kept.has(renamed) || !next.includes(renamed)) return null;
    kept.add(renamed);
    return renamed;
  });

  let rewritten: string;
  if (located.kind === "flow") {
    const separator = /,[ \t]+/.test(block.slice(located.open, located.close)) ? ", " : ",";
    const entries = located.items
      .map((token, i) => (keep[i] === null ? null : keep[i] === from[i] ? block.slice(token.start, token.end) : yamlScalar(keep[i]!)))
      .filter((e): e is string => e !== null);
    rewritten = block.slice(0, located.open + 1) + entries.join(separator) + block.slice(located.close);
  } else {
    let out = "";
    let at = 0;
    located.items.forEach((item, i) => {
      out += block.slice(at, item.lineStart);
      if (keep[i] !== null) {
        const token = keep[i] === from[i] ? block.slice(item.token.start, item.token.end) : yamlScalar(keep[i]!);
        out += block.slice(item.lineStart, item.token.start) + token + block.slice(item.token.end, item.lineEnd);
      }
      at = keep[i] === null ? Math.min(item.lineEnd + 1, block.length) : item.lineEnd;
    });
    out += block.slice(at);
    if (keep.every((k) => k === null)) {
      // An empty block list would read as null; say [] on the key line instead.
      const keyLine = /^tags[ \t]*:/m.exec(out)!;
      const colon = keyLine.index + keyLine[0].length;
      out = out.slice(0, colon) + " []" + out.slice(colon);
    }
    rewritten = out;
  }

  const result = text.slice(0, bounds.start) + rewritten + text.slice(bounds.end);
  let check: unknown;
  try {
    check = matter(result, {}).data.tags;
  } catch {
    return { skip: "the rewritten frontmatter does not parse" };
  }
  const readBack = Array.isArray(check) ? check.map((t) => String(t)) : null;
  if (!readBack || readBack.length !== to.length || readBack.some((t, i) => t !== to[i])) {
    return { skip: "the rewrite did not read back as the planned tags" };
  }
  return { text: result, from, to };
}

/** Plan and (unless dry-run) write every document's tag migration. */
export function applyTagChanges(root: string, taxonomy: Taxonomy, opts: TagApplyOptions): TagApplyReport {
  const renames = planRenames(root, taxonomy, opts.groups ?? false);
  const report: TagApplyReport = { files: [], skipped: [] };

  for (const path of getMarkdownFiles(root, taxonomy).sort()) {
    const fullPath = resolve(root, path);
    const text = readFileSync(fullPath, "utf-8");
    let type: string | null = null;
    try {
      const data = matter(text, {}).data;
      type = typeof data.type === "string" ? data.type : null;
    } catch {
      // rewriteTags reports it as skipped.
    }
    const plan = (tags: string[]): string[] => {
      const out: string[] = [];
      for (const tag of tags) {
        const applies = opts.only === undefined || tag === opts.only;
        const next = applies ? (renames.get(tag) ?? tag) : tag;
        if (applies && opts.redundant && findRedundantTags([{ path, type, tags: [next] }]).length > 0) continue;
        if (!out.includes(next)) out.push(next);
      }
      return out;
    };
    const outcome = rewriteTags(text, plan);
    if (outcome === null) continue;
    if ("skip" in outcome) {
      report.skipped.push({ path, reason: outcome.skip });
      continue;
    }
    if (!opts.dryRun) writeFileSync(fullPath, outcome.text, "utf-8");
    report.files.push({ path, from: outcome.from, to: outcome.to });
  }
  return report;
}
