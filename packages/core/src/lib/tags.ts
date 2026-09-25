/**
 * Tag hygiene report: variant groups, redundant tags, alias hits and
 * out-of-vocabulary tags, read from the markdown frontmatter (the source of
 * truth, so the report never depends on how fresh the index is).
 *
 * Detection is deterministic and belongs here; choosing between two plausible
 * canonical forms is judgment, so the report proposes one and `taxonomy.tags`
 * in brain.config (or a person) decides. Nothing here writes a file.
 */

import matter from "gray-matter";
import { readFileSync } from "fs";
import { resolve } from "path";

import type { TagsConfig } from "./config.js";
import { getMarkdownFiles } from "./indexer.js";
import type { Taxonomy } from "./taxonomy.js";

export interface TaggedDocument {
  path: string;
  type: string | null;
  tags: string[];
}

export interface VariantGroup {
  /** The proposed tag to keep: a vocabulary member, else the most used. */
  canonical: string;
  /** Every tag in the group, most used first. */
  members: { tag: string; count: number }[];
}

export interface RedundantTag {
  path: string;
  tag: string;
  /** What the tag repeats: the document's `type`, or a directory of its path. */
  repeats: "type" | "directory";
}

export interface AliasHit {
  path: string;
  tag: string;
  canonical: string;
}

export interface TagReport {
  /** Distinct tags in use. */
  tags: number;
  /** Markdown documents carrying at least one tag. */
  documents: number;
  variantGroups: VariantGroup[];
  redundant: RedundantTag[];
  aliasHits: AliasHit[];
  /** Tags outside `vocabulary`, most used first; null when no vocabulary is set. */
  outOfVocabulary: { tag: string; count: number }[] | null;
}

/** The frontmatter `tags` of every indexable markdown document, as the indexer reads them. */
export function collectTaggedDocuments(root: string, taxonomy: Taxonomy): TaggedDocument[] {
  const docs: TaggedDocument[] = [];
  for (const path of getMarkdownFiles(root, taxonomy)) {
    let data: Record<string, unknown>;
    try {
      data = matter(readFileSync(resolve(root, path), "utf-8")).data;
    } catch {
      continue; // unreadable or invalid frontmatter: `brain validate` reports it
    }
    if (!Array.isArray(data.tags)) continue;
    const tags = [...new Set(data.tags.map((t) => String(t)))];
    if (tags.length === 0) continue;
    docs.push({ path, type: typeof data.type === "string" ? data.type : null, tags });
  }
  return docs;
}

const MIN_STEM = 3;

/**
 * Length in characters (code points), not UTF-16 units: a tag of three
 * supplementary-plane characters is three long, like any other.
 */
function charLength(s: string): number {
  return Array.from(s).length;
}

/**
 * A simple English singular, applied only when the stem stays MIN_STEM or
 * longer. The suffixes are ASCII, so slicing them off by UTF-16 unit is exact.
 */
function singular(word: string): string {
  const length = charLength(word);
  if (word.endsWith("ies") && length - 3 >= MIN_STEM) return word.slice(0, -3) + "y";
  if (word.endsWith("es")) {
    const stem = word.slice(0, -2);
    if (length - 2 >= MIN_STEM && /(s|x|z|ch|sh)$/.test(stem)) return stem;
  }
  if (word.endsWith("s") && !word.endsWith("ss") && length - 1 >= MIN_STEM) return word.slice(0, -1);
  return word;
}

/** The key two variants share: lowercase, `-`/`_` stripped, English singular unless turned off. */
export function tagKey(tag: string, inflection: "en" | "off" = "en"): string {
  const key = tag.toLowerCase().replace(/[-_]/g, "");
  return inflection === "en" ? singular(key) : key;
}

/** Damerau-Levenshtein distance (optimal string alignment), over code points. */
export function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * How far apart two keys may be and still be one tag: none below 5
 * characters, 1 for 5-7, 2 for 8 or more, measured on the shorter key.
 *
 * Two exceptions. Keys with digits never match by distance, so `q1-2026` and
 * `q2-2026` stay apart. And a key that only extends the other (`trail` and
 * `trails`, `trade` and `trader`) is an ending, not a typo: whether endings
 * join is the inflection rule's call, and `inflection: "off"` must hold.
 */
function allowedDistance(a: string, b: string): number {
  if (/\p{Nd}/u.test(a) || /\p{Nd}/u.test(b)) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return 0;
  const len = Math.min(charLength(a), charLength(b));
  return len >= 8 ? 2 : len >= 5 ? 1 : 0;
}

/** The edit distance between two keys when it is within the allowed bound, else null. */
function withinDistance(a: string, b: string): number | null {
  const max = allowedDistance(a, b);
  if (max === 0 || Math.abs(charLength(a) - charLength(b)) > max) return null;
  const distance = editDistance(a, b);
  return distance <= max ? distance : null;
}

function byUse(a: { tag: string; count: number }, b: { tag: string; count: number }): number {
  return b.count - a.count || charLength(a.tag) - charLength(b.tag) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
}

/**
 * Group tags that normalize to the same key, or to keys within the allowed
 * distance. Two keys join only when every key of one group is within the
 * distance of every key of the other (complete linkage), so a middle tag
 * cannot chain two tags the rules keep apart: `trade`, `tradre` and `trader`
 * do not make `trade` and `trader` one group.
 */
export function findVariantGroups(counts: Map<string, number>, config: TagsConfig | null): VariantGroup[] {
  const inflection = config?.inflection ?? "en";
  const vocabulary = new Set(config?.vocabulary ?? []);

  // Tags sharing a key are one variant from the start; distance joins keys.
  const byKey = new Map<string, string[]>();
  for (const tag of counts.keys()) {
    const key = tagKey(tag, inflection);
    byKey.set(key, [...(byKey.get(key) ?? []), tag]);
  }
  const keys = [...byKey.keys()].sort();
  const near = new Set<string>();
  const edges: { i: number; j: number; distance: number }[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const distance = withinDistance(keys[i], keys[j]);
      if (distance === null) continue;
      near.add(`${i},${j}`);
      edges.push({ i, j, distance });
    }
  }
  const compatible = (i: number, j: number) => near.has(i < j ? `${i},${j}` : `${j},${i}`);

  // Closest pairs first, then key order, so the result does not depend on
  // the order tags were read in.
  edges.sort((x, y) => x.distance - y.distance || x.i - y.i || x.j - y.j);
  const clusterOf = keys.map((_, i) => i);
  const members = new Map<number, number[]>(keys.map((_, i) => [i, [i]]));
  for (const { i, j } of edges) {
    const [ci, cj] = [clusterOf[i], clusterOf[j]];
    if (ci === cj) continue;
    const left = members.get(ci)!;
    const right = members.get(cj)!;
    if (!left.every((a) => right.every((b) => compatible(a, b)))) continue;
    for (const k of right) clusterOf[k] = ci;
    left.push(...right);
    members.delete(cj);
  }

  const groups: VariantGroup[] = [];
  for (const cluster of members.values()) {
    const tags = cluster.flatMap((i) => byKey.get(keys[i])!);
    if (tags.length < 2) continue;
    const ranked = tags.map((tag) => ({ tag, count: counts.get(tag)! })).sort(byUse);
    const preferred = ranked.filter((m) => vocabulary.has(m.tag));
    groups.push({ canonical: (preferred[0] ?? ranked[0]).tag, members: ranked });
  }
  const total = (g: VariantGroup) => g.members.reduce((sum, m) => sum + m.count, 0);
  return groups.sort((a, b) => total(b) - total(a) || (a.canonical < b.canonical ? -1 : 1));
}

/** A tag that repeats the document's type or one of its path's directories. */
export function findRedundantTags(docs: TaggedDocument[]): RedundantTag[] {
  const redundant: RedundantTag[] = [];
  for (const doc of docs) {
    const dirs = new Set(doc.path.split("/").slice(0, -1));
    for (const tag of doc.tags) {
      if (tag === doc.type) redundant.push({ path: doc.path, tag, repeats: "type" });
      else if (dirs.has(tag)) redundant.push({ path: doc.path, tag, repeats: "directory" });
    }
  }
  return redundant;
}

/** Build the whole report for a brain. */
export function tagReport(root: string, taxonomy: Taxonomy): TagReport {
  const config = taxonomy.tags;
  const docs = collectTaggedDocuments(root, taxonomy);
  const counts = new Map<string, number>();
  for (const doc of docs) for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);

  const aliases = config?.aliases ?? {};
  const aliasHits: AliasHit[] = [];
  for (const doc of docs) {
    for (const tag of doc.tags) {
      if (Object.hasOwn(aliases, tag)) aliasHits.push({ path: doc.path, tag, canonical: aliases[tag] });
    }
  }

  let outOfVocabulary: TagReport["outOfVocabulary"] = null;
  if (config?.vocabulary) {
    const vocabulary = new Set(config.vocabulary);
    outOfVocabulary = [...counts]
      .filter(([tag]) => !vocabulary.has(tag))
      .map(([tag, count]) => ({ tag, count }))
      .sort(byUse);
  }

  return {
    tags: counts.size,
    documents: docs.length,
    variantGroups: findVariantGroups(counts, config),
    redundant: (config?.redundant ?? "warn") === "off" ? [] : findRedundantTags(docs),
    aliasHits,
    outOfVocabulary,
  };
}
