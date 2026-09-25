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
import { createHash } from "crypto";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";

import { frontmatterLength } from "./document-parts.js";
import { getMarkdownFiles, indexAll } from "./indexer.js";
import type { Database } from "bun:sqlite";

import type { TagsConfig } from "./config.js";
import { collectTaggedDocuments, findRedundantTags, findVariantGroups } from "./tags.js";
import type { Taxonomy } from "./taxonomy.js";

export interface TagApplyOptions {
  /** Apply every variant group, not only those whose canonical tag is in `vocabulary`. */
  groups?: boolean;
  /** Also remove tags that repeat the document's type or a directory of its path. */
  redundant?: boolean;
  /** Only change this old tag. */
  only?: string;
  dryRun?: boolean;
  /** Test seam: runs after a file's rewrite is planned and before it is committed. */
  beforeCommit?: (path: string) => void;
}

export interface TagApplyReport {
  files: { path: string; from: string[]; to: string[] }[];
  /** Files left alone, with why. A reason starting `failed:` is an error, not a decision. */
  skipped: { path: string; reason: string }[];
}

/** What the CLI needs beyond the report: the exact bytes each write produced. */
export interface TagApplyResult {
  report: TagApplyReport;
  /** sha256 of each file's rewritten text, keyed by path. */
  written: Map<string, string>;
  /** True when a file could not be read or written. */
  failed: boolean;
}

/** The content hash the indexer stores for a file (`content_hash`). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface RenamePlan {
  /** Old tag → canonical tag, already resolved to the end of its chain. */
  renames: Map<string, string>;
  /** Tags whose alias chain loops, with the loop spelled out. Files carrying one are skipped. */
  cycles: Map<string, string>;
}

/**
 * One stable plan from the tags in use.
 *
 * Explicit `aliases` come first and resolve to the end of their chain; a
 * chain that loops (`a → b → c → b`) is a cycle, and every tag on it is left
 * alone and reported. Variant groups then add inferred renames, only for
 * groups whose canonical is a vocabulary member (every group with `groups`),
 * and never for a tag the aliases name: an alias key is already planned, and
 * an alias target is a canonical tag the owner chose, which inference must
 * not rename away. Groups are recomputed over the tags as the plan leaves
 * them until nothing more joins, so running the plan's result again plans
 * nothing.
 */
export function planRenames(counts: Map<string, number>, config: TagsConfig | null, groups: boolean): RenamePlan {
  const aliases = new Map<string, string>(Object.entries(config?.aliases ?? {}));
  const aliasTargets = new Set(aliases.values());
  const vocabulary = new Set(config?.vocabulary ?? []);
  const renames = new Map<string, string>();
  const cycles = new Map<string, string>();

  for (const from of aliases.keys()) {
    const path = [from];
    let to = from;
    while (aliases.has(to)) {
      to = aliases.get(to)!;
      path.push(to);
      if (path.indexOf(to) < path.length - 1) break;
    }
    if (path.indexOf(to) < path.length - 1) cycles.set(from, path.join(" → "));
    else if (to !== from) renames.set(from, to);
  }

  for (let round = 0; round <= counts.size; round++) {
    const projected = new Map<string, number>();
    for (const [tag, count] of counts) {
      const to = renames.get(tag) ?? tag;
      projected.set(to, (projected.get(to) ?? 0) + count);
    }
    let changed = false;
    for (const group of findVariantGroups(projected, config)) {
      if (!groups && !vocabulary.has(group.canonical)) continue;
      if (cycles.has(group.canonical)) continue;
      for (const { tag } of group.members) {
        if (tag === group.canonical || aliases.has(tag) || aliasTargets.has(tag) || cycles.has(tag)) continue;
        if (renames.has(tag)) continue;
        renames.set(tag, group.canonical);
        for (const [from, to] of renames) if (to === tag) renames.set(from, group.canonical);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { renames, cycles };
}

// ---------------------------------------------------------------------------
// Raw frontmatter editing
// ---------------------------------------------------------------------------

/**
 * Where the frontmatter's inner text lies: between the opening `---` line and
 * the closing `---`, by the span `frontmatterLength` measures with
 * gray-matter's rule (a leading byte order mark included).
 */
function frontmatterBounds(text: string): { start: number; end: number } | null {
  const length = frontmatterLength(text);
  if (length === 0) return null;
  const close = text.lastIndexOf("\n---", length);
  const start = text.indexOf("\n") + 1;
  return close !== -1 && start > 0 && start <= close + 1 ? { start, end: close + 1 } : null;
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

/** Per entry: the tag it becomes, or null to drop it. Or a reason to leave the file alone. */
export type EntryPlan = (tags: string[]) => (string | null)[] | { skip: string };

/** Byte ranges to cut from a flow sequence so the entries at `drop` go, gaps of the others untouched. */
function flowCuts(items: Token[], drop: boolean[]): [number, number][] {
  const cuts: [number, number][] = [];
  let i = 0;
  while (i < items.length) {
    if (!drop[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < items.length && drop[j + 1]) j++;
    // A run of dropped entries: cut up to the next entry, or back to the
    // previous one when the run ends the list.
    if (j + 1 < items.length) cuts.push([items[i].start, items[j + 1].start]);
    else if (i > 0) cuts.push([items[i - 1].end, items[j].end]);
    i = j + 1;
  }
  return cuts;
}

/**
 * Rewrite the `tags:` entries of one document as `plan` decides, on the raw
 * text. A renamed entry's scalar is replaced in place; a dropped flow entry
 * goes with the separator after it (before it, at the end of the list); a
 * dropped block entry's line goes, but a comment on it stays behind as a
 * comment line. Everything else keeps its bytes. Returns the new text, null
 * when nothing changes, or a reason the file is left alone.
 */
export function rewriteTags(
  text: string,
  plan: EntryPlan
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
  const entries = plan(from);
  if (!Array.isArray(entries)) return entries;
  if (entries.every((e, i) => e === from[i])) return null;
  const to = entries.filter((e): e is string => e !== null);

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

  // Edits as [start, end, replacement] in block offsets, applied from the end.
  const edits: [number, number, string][] = [];
  const drop = entries.map((e) => e === null);
  if (located.kind === "flow") {
    if (drop.every(Boolean)) {
      edits.push([located.open + 1, located.close, ""]);
    } else {
      for (const [a, b] of flowCuts(located.items, drop)) edits.push([a, b, ""]);
      located.items.forEach((token, i) => {
        if (!drop[i] && entries[i] !== from[i]) edits.push([token.start, token.end, yamlScalar(entries[i]!)]);
      });
    }
  } else {
    located.items.forEach((item, i) => {
      if (drop[i]) {
        const rest = block.slice(item.token.end, item.lineEnd);
        const comment = rest.indexOf("#");
        if (comment === -1) {
          edits.push([item.lineStart, Math.min(item.lineEnd + 1, block.length), ""]);
        } else {
          // Keep the entry's comment as a comment line at the entry's indent.
          const indent = /^[ \t]*/.exec(block.slice(item.lineStart))![0];
          edits.push([item.lineStart, item.token.end + comment, indent]);
        }
      } else if (entries[i] !== from[i]) {
        edits.push([item.token.start, item.token.end, yamlScalar(entries[i]!)]);
      }
    });
    if (drop.every(Boolean)) {
      // An empty block list would read as null; say [] on the key line instead.
      const keyLine = /^tags[ \t]*:/m.exec(block)!;
      edits.push([keyLine.index + keyLine[0].length, keyLine.index + keyLine[0].length, " []"]);
    }
  }
  let rewritten = block;
  for (const [a, b, replacement] of edits.sort((x, y) => y[0] - x[0] || y[1] - x[1])) {
    rewritten = rewritten.slice(0, a) + replacement + rewritten.slice(b);
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

/**
 * Replace a file with `text` only if it still holds exactly the bytes read
 * before: through a temporary file renamed into place, so a reader never
 * sees half a file. Returns false when the file changed in the meantime.
 */
function commitIfUnchanged(fullPath: string, expectedHash: string, text: string): boolean {
  if (contentHash(readFileSync(fullPath, "utf-8")) !== expectedHash) return false;
  const temp = `${fullPath}.brain-tags-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, "utf-8");
    chmodSync(temp, statSync(fullPath).mode);
    renameSync(temp, fullPath);
  } catch (e) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing was left behind.
    }
    throw e;
  }
  return true;
}

/**
 * Plan and (unless dry-run) write every document's tag migration. A file that
 * cannot be read or written is reported and the run goes on, so the files
 * already rewritten still get indexed and accepted by the caller.
 */
export function applyTagChanges(root: string, taxonomy: Taxonomy, opts: TagApplyOptions): TagApplyResult {
  const counts = new Map<string, number>();
  for (const doc of collectTaggedDocuments(root, taxonomy)) {
    for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const { renames, cycles } = planRenames(counts, taxonomy.tags, opts.groups ?? false);
  const result: TagApplyResult = { report: { files: [], skipped: [] }, written: new Map(), failed: false };
  const { report } = result;

  for (const path of getMarkdownFiles(root, taxonomy).sort()) {
    const fullPath = resolve(root, path);
    try {
      const text = readFileSync(fullPath, "utf-8");
      let type: string | null = null;
      try {
        const data = matter(text, {}).data;
        type = typeof data.type === "string" ? data.type : null;
      } catch {
        // rewriteTags reports it as skipped.
      }
      const plan: EntryPlan = (tags) => {
        const applies = (tag: string) => opts.only === undefined || tag === opts.only;
        const cycle = tags.find((tag) => applies(tag) && cycles.has(tag));
        if (cycle !== undefined) return { skip: `tag alias cycle: ${cycles.get(cycle)}` };
        const entries = tags.map((tag): string | null => {
          if (!applies(tag)) return tag;
          const next = renames.get(tag) ?? tag;
          if (opts.redundant && findRedundantTags([{ path, type, tags: [next] }]).length > 0) return null;
          return next;
        });
        // Merge only what the plan produced: a renamed entry that meets its
        // canonical keeps the first of them. Unrelated duplicates stay.
        const produced = new Set(entries.filter((e, i): e is string => e !== null && e !== tags[i]));
        const seen = new Set<string>();
        return entries.map((e) => {
          if (e === null || !produced.has(e)) return e;
          if (seen.has(e)) return null;
          seen.add(e);
          return e;
        });
      };
      const outcome = rewriteTags(text, plan);
      if (outcome === null) continue;
      if ("skip" in outcome) {
        report.skipped.push({ path, reason: outcome.skip });
        continue;
      }
      if (!opts.dryRun) {
        opts.beforeCommit?.(path);
        if (!commitIfUnchanged(fullPath, contentHash(text), outcome.text)) {
          report.skipped.push({ path, reason: "changed during apply" });
          continue;
        }
        result.written.set(path, contentHash(outcome.text));
      }
      report.files.push({ path, from: outcome.from, to: outcome.to });
    } catch (e) {
      result.failed = true;
      report.skipped.push({ path, reason: `failed: ${(e as Error).message}` });
    }
  }
  return result;
}

/**
 * Reindex, then accept the new mtime of each rewritten file whose indexed
 * content is exactly the bytes the rewrite wrote. A file edited since is not
 * accepted, so silent-edit detection still sees that edit; each one is
 * returned as a warning. Throws when reindexing fails.
 */
export async function indexAndAccept(
  db: Database,
  root: string,
  taxonomy: Taxonomy,
  written: Map<string, string>
): Promise<string[]> {
  await indexAll(db, { root, taxonomy, force: false, quiet: true });
  const accept = db.prepare(
    "UPDATE documents SET accepted_mtime = file_mtime WHERE path = ? AND content_hash = ? AND file_mtime IS NOT NULL"
  );
  const warnings: string[] = [];
  for (const [path, hash] of written) {
    if (accept.run(path, hash).changes === 1) continue;
    warnings.push(`${path} changed after its tags were rewritten; its mtime was not accepted`);
  }
  return warnings;
}
