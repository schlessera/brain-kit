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

import { rewriteGeneratedRegion } from "./generated-regions.js";
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
  /** The file as it would be after regeneration; null when the region is current. */
  next: string | null;
}

export interface RegistryProblem {
  path: string;
  error: string;
}

/** A frontmatter value as table text: dates as `YYYY-MM-DD`, lists joined, pipes and newlines made safe. */
function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : Array.isArray(value)
        ? value.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))).join(", ")
        : String(value);
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
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
      `| ${spec.columns.join(" | ")} |`,
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
    .map((value) => `**${spec.split}: ${value.replace(/\|/g, "\\|")}**\n\n${table(groups.get(value)!)}`)
    .join("\n\n");
}

function readFrontmatter(root: string, path: string): Record<string, unknown> {
  return matter(readFileSync(join(root, path), "utf8")).data as Record<string, unknown>;
}

/**
 * Every opted-in `_index.md` with what regenerating it would produce, and the
 * ones whose `registry:` block is invalid. Reads files only; writes nothing.
 */
export function planRegistry(
  root: string,
  taxonomy: Taxonomy,
  asOf: string
): { indexes: RegistryIndex[]; problems: RegistryProblem[] } {
  const files = getMarkdownFiles(root, taxonomy);
  const indexes: RegistryIndex[] = [];
  const problems: RegistryProblem[] = [];
  const frontmatter = new Map<string, Record<string, unknown>>();
  const dataOf = (path: string) => {
    let data = frontmatter.get(path);
    if (!data) {
      try {
        data = readFrontmatter(root, path);
      } catch {
        data = {};
      }
      frontmatter.set(path, data);
    }
    return data;
  };

  for (const path of files) {
    if (posix.basename(path) !== "_index.md") continue;
    const raw = dataOf(path).registry;
    if (raw === undefined) continue;
    const parsed = registrySpecSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push({ path, error: parsed.error.issues.map((i) => `${i.path.join(".") || "registry"}: ${i.message}`).join("; ") });
      continue;
    }
    const indexDir = dirname(path) === "." ? "" : dirname(path);
    const prefix = indexDir ? `${indexDir}/` : "";
    const children = files
      .filter((p) => p !== path && p.startsWith(prefix) && posix.basename(p) !== "_index.md")
      .map((p) => ({ path: p, data: dataOf(p) }));
    const content = renderRegistry(parsed.data, children, indexDir);
    const fileText = readFileSync(join(root, path), "utf8");
    indexes.push({ path, next: rewriteGeneratedRegion(fileText, REGISTRY_REGION, content, asOf) });
  }
  return { indexes, problems };
}

export interface RegistryRun {
  /** Opted-in indexes found, valid or not. */
  indexes: number;
  /** Indexes rewritten this run (never under `check`). */
  written: string[];
  /** Indexes whose region is out of date (under `check`: left as they are). */
  stale: string[];
  /** Indexes whose `registry:` block is invalid; left untouched. */
  invalid: RegistryProblem[];
}

/**
 * Regenerate every opted-in index's registry region, writing only files whose
 * region changed, and bumping their `updated:` to `asOf`. With `check`,
 * nothing is written and the out-of-date indexes are listed instead.
 */
export function runRegistry(root: string, taxonomy: Taxonomy, opts: { check?: boolean; asOf: string }): RegistryRun {
  const { indexes, problems } = planRegistry(root, taxonomy, opts.asOf);
  const run: RegistryRun = { indexes: indexes.length + problems.length, written: [], stale: [], invalid: problems };
  for (const index of indexes) {
    if (index.next === null) continue;
    if (opts.check) {
      run.stale.push(index.path);
    } else {
      writeFileSafely(join(root, index.path), index.next);
      run.written.push(index.path);
    }
  }
  return run;
}
