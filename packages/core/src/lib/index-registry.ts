/**
 * `_index.md` registry tables, generated from the children's frontmatter.
 *
 * An index opts in with a `registry:` block in its own frontmatter: the index
 * owns its view, so changing the columns needs no config reload. The table is
 * rendered into the index's `registry` generated region (see
 * generated-regions.ts); the prose around it stays the author's.
 *
 *     registry:
 *       columns: [link, status, updated]   # frontmatter keys, plus title/path/link
 *       where: { status: [active, paused] } # optional: keep children with these values
 *       sort: -updated                      # optional: a column key, `-` for descending
 *       split: status                       # optional: one table per value of this key
 *
 * The children are every markdown file under the index's directory, at any
 * depth, other than an `_index.md`.
 */
import { readFileSync } from "fs";
import matter from "gray-matter";
import { dirname, join, posix } from "path";
import { z } from "zod";

import { inertGeneratedText, rewriteGeneratedRegion, splitFrontmatterBlock } from "./generated-regions.js";
import { frontmatterLength } from "./document-parts.js";
import { writeFileSafely } from "./safe-path.js";
import { getMarkdownFiles } from "./indexer.js";
import type { Taxonomy } from "./taxonomy.js";

export const REGISTRY_REGION = "registry";

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const registrySpecSchema = z
  .object({
    columns: z.array(z.string().min(1)).min(1),
    where: z.record(z.string(), z.array(scalar).min(1)).optional(),
    sort: z.string().min(1).optional(),
    split: z.string().min(1).optional(),
  })
  .strict();

export type RegistrySpec = z.infer<typeof registrySpecSchema>;

/** One opted-in index, as `brain registry` and `brain audit` see it. */
export interface RegistryIndex {
  path: string;
  /** The file as it was read when the plan was made. */
  raw: string;
  /** The file as it would be after regeneration; null when the region is current. */
  next: string | null;
}

export interface RegistryProblem {
  path: string;
  error: string;
}

const inert = inertGeneratedText;

/** A frontmatter value as table text: dates as `YYYY-MM-DD`, lists joined, made inert. */
function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : Array.isArray(value)
        ? value.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))).join(", ")
        : String(value);
  return inert(text);
}

/** A value for comparison: the same text a cell shows, without the escaping. */
function key(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === undefined || value === null ? "" : String(value);
}

interface Child {
  /** Repo-relative path. */
  path: string;
  data: Record<string, unknown>;
}

function columnValue(child: Child, column: string, indexDir: string): unknown {
  if (column === "path") return posix.relative(indexDir, child.path);
  if (column === "link") return `[[${child.path.replace(/\.md$/, "")}]]`;
  return child.data[column];
}

/** Render the region content for one index: one table, or one per `split` value. */
export function renderRegistry(spec: RegistrySpec, children: Child[], indexDir: string): string {
  let rows = children;
  if (spec.where) {
    const where = Object.entries(spec.where).map(([k, values]) => [k, new Set(values.map(String))] as const);
    rows = rows.filter((child) =>
      where.every(([k, allowed]) => {
        const v = child.data[k];
        const candidates = Array.isArray(v) ? v.map(key) : [key(v)];
        return candidates.some((c) => allowed.has(c));
      })
    );
  }

  const sortKey = spec.sort?.replace(/^-/, "");
  const descending = spec.sort?.startsWith("-") ?? false;
  rows = [...rows].sort((a, b) => {
    if (sortKey) {
      const x = key(columnValue(a, sortKey, indexDir));
      const y = key(columnValue(b, sortKey, indexDir));
      if (x !== y) return (x < y ? -1 : 1) * (descending ? -1 : 1);
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const table = (group: Child[]): string =>
    [
      `| ${spec.columns.map(inert).join(" | ")} |`,
      `| ${spec.columns.map(() => "---").join(" | ")} |`,
      ...group.map((child) => `| ${spec.columns.map((c) => cell(columnValue(child, c, indexDir))).join(" | ")} |`),
    ].join("\n");

  if (rows.length === 0) return "_No entries._";
  if (!spec.split) return table(rows);

  const groups = new Map<string, Child[]>();
  for (const child of rows) {
    const value = key(child.data[spec.split]) || "—";
    const group = groups.get(value);
    if (group) group.push(child);
    else groups.set(value, [child]);
  }
  return [...groups.keys()]
    .sort()
    .map((value) => `**${inert(spec.split!)}: ${inert(value)}**\n\n${table(groups.get(value)!)}`)
    .join("\n\n");
}

/** A file as read for planning: its text and parsed frontmatter, or why it could not be read. */
type Read = { raw: string; data: Record<string, unknown> } | { raw: string | null; error: string };

function readFile(root: string, path: string): Read {
  let raw: string;
  try {
    raw = readFileSync(join(root, path), "utf8");
  } catch (error) {
    return { raw: null, error: `unreadable: ${firstLine(error)}` };
  }
  try {
    // gray-matter reads a block with no closing fence as frontmatter anyway;
    // the rewrite would then treat the whole file as body.
    splitFrontmatterBlock(raw);
    return { raw, data: matter(raw, {}).data as Record<string, unknown> };
  } catch (error) {
    return { raw, error: `frontmatter does not parse: ${firstLine(error)}` };
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/**
 * Every opted-in `_index.md` with what regenerating it would produce, and the
 * ones that cannot be generated: an invalid `registry:` block, an index or a
 * child that cannot be read or parsed, malformed region markers. Those are
 * reported and left as they are, never regenerated from missing data. An
 * `_index.md` whose frontmatter does not parse counts as opted in when it has
 * a `registry:` line; one that cannot be read at all is always reported.
 * Reads files only; writes nothing.
 */
export function planRegistry(
  root: string,
  taxonomy: Taxonomy,
  asOf: string
): { indexes: RegistryIndex[]; problems: RegistryProblem[] } {
  const files = getMarkdownFiles(root, taxonomy);
  const indexes: RegistryIndex[] = [];
  const problems: RegistryProblem[] = [];
  const reads = new Map<string, Read>();
  const readOf = (path: string) => {
    let read = reads.get(path);
    if (!read) reads.set(path, (read = readFile(root, path)));
    return read;
  };

  for (const path of files) {
    if (posix.basename(path) !== "_index.md") continue;
    const index = readOf(path);
    if ("error" in index) {
      const optedIn = index.raw === null || /^\s*["']?registry["']?\s*:/m.test(index.raw.slice(0, frontmatterLength(index.raw)));
      if (optedIn) problems.push({ path, error: index.error });
      continue;
    }
    const raw = index.data.registry;
    if (raw === undefined) continue;
    const parsed = registrySpecSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push({ path, error: parsed.error.issues.map((i) => `${i.path.join(".") || "registry"}: ${i.message}`).join("; ") });
      continue;
    }
    const indexDir = dirname(path) === "." ? "" : dirname(path);
    const prefix = indexDir ? `${indexDir}/` : "";
    const children: Child[] = [];
    const broken: string[] = [];
    for (const p of files) {
      if (p === path || !p.startsWith(prefix) || posix.basename(p) === "_index.md") continue;
      const child = readOf(p);
      if ("error" in child) broken.push(`${p}: ${child.error}`);
      else children.push({ path: p, data: child.data });
    }
    if (broken.length > 0) {
      problems.push({ path, error: `child ${broken.join("; child ")}` });
      continue;
    }
    try {
      const content = renderRegistry(parsed.data, children, indexDir);
      indexes.push({ path, raw: index.raw, next: rewriteGeneratedRegion(index.raw, REGISTRY_REGION, content, asOf) });
    } catch (error) {
      problems.push({ path, error: firstLine(error) });
    }
  }
  return { indexes, problems };
}

export interface RegistryRun {
  /** Opted-in indexes found, valid or not. */
  indexes: number;
  /** Indexes rewritten this run (never under `check`). */
  written: string[];
  /**
   * Indexes whose region is out of date and were left as they are: every one
   * under `check`, else one whose file changed between planning and writing.
   */
  stale: string[];
  /** Indexes that cannot be generated (see planRegistry); left untouched. */
  invalid: RegistryProblem[];
}

/**
 * Regenerate every opted-in index's registry region, writing only files whose
 * region changed, and bumping their `updated:` to `asOf`. With `check`,
 * nothing is written and the out-of-date indexes are listed instead.
 */
export function runRegistry(root: string, taxonomy: Taxonomy, opts: { check?: boolean; asOf: string }): RegistryRun {
  return applyRegistry(root, planRegistry(root, taxonomy, opts.asOf), opts);
}

/** Carry out a plan: write each index whose region changed, unless `check` or its file changed since. */
export function applyRegistry(
  root: string,
  { indexes, problems }: ReturnType<typeof planRegistry>,
  opts: { check?: boolean }
): RegistryRun {
  const run: RegistryRun = { indexes: indexes.length + problems.length, written: [], stale: [], invalid: problems };
  for (const index of indexes) {
    if (index.next === null) continue;
    if (opts.check) {
      run.stale.push(index.path);
      continue;
    }
    // Planning read the file a moment ago; an edit since then (an editor
    // saving the prose) must not be overwritten by that snapshot. Such a file
    // is left for the next run and listed as stale.
    let now: string | null;
    try {
      now = readFileSync(join(root, index.path), "utf8");
    } catch {
      now = null;
    }
    if (now !== index.raw) {
      run.stale.push(index.path);
      continue;
    }
    writeFileSafely(join(root, index.path), index.next);
    run.written.push(index.path);
  }
  return run;
}
