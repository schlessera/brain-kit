/**
 * Frontmatter + wiki-link validation.
 *
 * Ported from the reference brain's scripts/validate.ts as a library (no
 * process.exit / console output): the CLI wraps validate() + checkIndexDrift()
 * and renders the result. Placed in lib/ alongside the other ported libs.
 *
 * CONFIG VALIDATION FIRST: building the Taxonomy handed in here
 * requires loading + schema-validating brain.config (loadUserConfig throws on
 * violations, initContext propagates it). So by the time validate() runs, the
 * config is already known-good; these checks cover the corpus, not the config.
 *
 * Type/status/relevance vocabularies and the wiki-link resolver all come from
 * the taxonomy so validation and the indexer's link graph agree exactly.
 */

import { parseFrontmatter } from "./frontmatter-parse.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

import { VALID_STATUSES, VALID_RELEVANCES } from "./types.js";
import type { Taxonomy } from "./taxonomy.js";
import { createWikiLinkResolver } from "./indexer/links.js";
import { supersedesTargets } from "./supersedes.js";
import {
  getMarkdownFiles,
  resolveAlias,
  extractWikiLinks,
} from "./indexer.js";

export interface ValidationIssue {
  file: string;
  level: "error" | "warning";
  message: string;
}

/**
 * A frontmatter value named by its kind, for a diagnostic. Never serialized:
 * YAML anchors can make a value cyclic, and JSON.stringify throws on that.
 */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "an empty value";
  if (Array.isArray(value)) return "a list";
  if (value instanceof Date) return "a date";
  if (typeof value === "object") return "a map";
  if (typeof value === "string") return "an empty string";
  return `a ${typeof value}`;
}

export function validate(root: string, taxonomy: Taxonomy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const files = getMarkdownFiles(root, taxonomy);
  const tagAliases = taxonomy.tags?.aliases;
  const vocabulary = taxonomy.tags?.vocabulary ? new Set(taxonomy.tags.vocabulary) : null;

  // Build the same maps the indexer uses, so validation and resolution agree
  const fileMap = new Map<string, string>();
  const aliasMap = new Map<string, string[]>();
  const basenameCounts = new Map<string, number>();
  // `supersedes` values as written, checked once every file is known.
  const supersedes = new Map<string, unknown>();
  for (const path of files) {
    fileMap.set(path, path);
    const basename = path.replace(/\.md$/, "").split("/").pop()!;
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
    try {
      const { data } = parseFrontmatter(readFileSync(resolve(root, path), "utf-8"));
      if (data.supersedes !== undefined) supersedes.set(path, data.supersedes);
      if (Array.isArray(data.aliases)) {
        for (const alias of data.aliases) {
          const key = String(alias).toLowerCase().trim();
          if (!key) continue;
          const paths = aliasMap.get(key) ?? [];
          paths.push(path);
          aliasMap.set(key, paths);
        }
      }
    } catch {
      // frontmatter errors reported in the main loop
    }
  }

  const resolveLink = createWikiLinkResolver(fileMap, taxonomy.dirAnchors);
  for (const filePath of files) {
    const fullPath = resolve(root, filePath);
    const raw = readFileSync(fullPath, "utf-8");

    // Check for frontmatter
    if (!raw.startsWith("---")) {
      issues.push({
        file: filePath,
        level: "error",
        message: "Missing YAML frontmatter",
      });
      continue;
    }

    let data: Record<string, any>;
    let content: string;
    try {
      const parsed = parseFrontmatter(raw);
      data = parsed.data;
      content = parsed.content;
    } catch (e) {
      issues.push({
        file: filePath,
        level: "error",
        message: `Invalid YAML frontmatter: ${e}`,
      });
      continue;
    }

    // Required fields
    if (!data.title) {
      issues.push({
        file: filePath,
        level: "error",
        message: "Missing required field: title",
      });
    }
    if (!data.type) {
      issues.push({
        file: filePath,
        level: "error",
        message: "Missing required field: type",
      });
    } else if (!taxonomy.isValidType(data.type)) {
      issues.push({
        file: filePath,
        level: "error",
        message: `Invalid type: "${data.type}". Valid: ${taxonomy.validTypes().join(", ")}`,
      });
    }
    if (!data.created) {
      issues.push({
        file: filePath,
        level: "warning",
        message: "Missing field: created",
      });
    }
    if (!data.updated) {
      issues.push({
        file: filePath,
        level: "warning",
        message: "Missing field: updated",
      });
    }
    if (!data.tags || !Array.isArray(data.tags) || data.tags.length === 0) {
      issues.push({
        file: filePath,
        level: "warning",
        message: "Missing or empty tags",
      });
    }

    // Optional field validation
    if (data.status && !VALID_STATUSES.includes(data.status)) {
      issues.push({
        file: filePath,
        level: "error",
        message: `Invalid status: "${data.status}". Valid: ${VALID_STATUSES.join(", ")}`,
      });
    }
    if (data.relevance && !VALID_RELEVANCES.includes(data.relevance)) {
      issues.push({
        file: filePath,
        level: "error",
        message: `Invalid relevance: "${data.relevance}". Valid: ${VALID_RELEVANCES.join(", ")}`,
      });
    }
    if ("generated_from" in data && (typeof data.generated_from !== "string" || data.generated_from.trim() === "")) {
      issues.push({
        file: filePath,
        level: "error",
        message: `Invalid generated_from: ${describeValue(data.generated_from)}. It must be a non-empty string: a repo-relative path or a tool name`,
      });
    }
    if (data.status === "archived" && data.relevance === "primary") {
      issues.push({
        file: filePath,
        level: "warning",
        message: "status: archived contradicts relevance: primary; set relevance: historical",
      });
    }

    // Tag format validation, then the configured vocabulary (taxonomy.tags)
    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        if (typeof tag !== "string" || tag !== tag.toLowerCase() || tag.includes(" ")) {
          issues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${tag}" should be lowercase and hyphenated (no spaces)`,
          });
        }
        const name = String(tag);
        if (tagAliases && Object.hasOwn(tagAliases, name)) {
          issues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${name}" is an alias in taxonomy.tags — use "${tagAliases[name]}"`,
          });
        } else if (vocabulary && !vocabulary.has(name)) {
          issues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${name}" is not in taxonomy.tags.vocabulary`,
          });
        }
      }
    }

    // Wiki-link validation — uses the indexer's resolver so warnings match
    // what the link graph will actually contain
    const wikiLinks = extractWikiLinks(content);
    for (const link of wikiLinks) {
      const resolved =
        resolveLink(link, filePath) ??
        resolveAlias(link, aliasMap, filePath);
      if (resolved) continue;

      const candidates = basenameCounts.get(link.split("/").pop()!) ?? 0;
      if (candidates > 1) {
        issues.push({
          file: filePath,
          level: "warning",
          message: `Ambiguous wiki-link: [[${link}]] matches ${candidates} files and none is a same-directory sibling — qualify it (e.g. [[dir/${link}]])`,
        });
      } else {
        issues.push({
          file: filePath,
          level: "warning",
          message: `Unresolved wiki-link: [[${link}]]`,
        });
      }
    }
  }

  issues.push(...validateSupersedes(supersedes, (target, from) => resolveLink(target, from) ?? resolveAlias(target, aliasMap, from)));
  return issues;
}

/**
 * `supersedes` (#412): each value must be a wiki-link target or a list of
 * them, each target must resolve, and no document may end up superseding
 * itself through a chain. All three are errors: a wrong entry silently
 * demotes nothing, or the wrong document.
 */
function validateSupersedes(
  values: Map<string, unknown>,
  resolveTarget: (target: string, from: string) => string | null
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const edges = new Map<string, string[]>();
  for (const [file, value] of values) {
    const targets = supersedesTargets(value);
    if (targets === null) {
      issues.push({
        file,
        level: "error",
        message: `Invalid supersedes: ${describeValue(value)}. It must be one wiki-link target, "[[target]]" or target, or a non-empty list of them`,
      });
      continue;
    }
    const resolved: string[] = [];
    for (const target of targets) {
      const path = resolveTarget(target, file);
      if (path) resolved.push(path);
      else issues.push({ file, level: "error", message: `Unresolved supersedes target: [[${target}]]` });
    }
    edges.set(file, resolved);
  }

  // Every document on a cycle is reported, once, naming the others it loops
  // with: the cycles are the strongly connected components (Tarjan) of more
  // than one document, or one that supersedes itself.
  for (const component of stronglyConnected(edges)) {
    const looped = component.length > 1 || (edges.get(component[0]!) ?? []).includes(component[0]!);
    if (!looped) continue;
    const members = [...component].sort();
    for (const file of members) {
      issues.push({ file, level: "error", message: `supersedes cycle among ${members.join(", ")}` });
    }
  }
  return issues;
}

/** The strongly connected components of a graph (Tarjan's algorithm). */
function stronglyConnected(edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next++;
    stack.push(node);
    onStack.add(node);
    for (const to of edges.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node)!, index.get(to)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };
  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components;
}

/**
 * Index drift check: compare markdown files on disk against the documents
 * table in brain.db. Skipped silently when the database doesn't exist.
 * Uses the indexer's own file-scanning rules so the comparison is 1:1.
 */
export async function checkIndexDrift(
  root: string,
  dbPath: string,
  taxonomy: Taxonomy
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (!existsSync(dbPath)) return issues;

  try {
    const { Database } = await import("bun:sqlite");

    const db = new Database(dbPath, { readonly: true });
    const dbPaths = new Set(
      (db.prepare("SELECT path FROM documents WHERE asset_type = 'markdown'").all() as { path: string }[])
        .map((r) => r.path)
    );
    db.close();

    const diskPaths = new Set(getMarkdownFiles(root, taxonomy));

    for (const path of diskPaths) {
      if (!dbPaths.has(path)) {
        issues.push({
          file: path,
          level: "warning",
          message: "Not in search index — run `brain index`",
        });
      }
    }
    for (const path of dbPaths) {
      if (!diskPaths.has(path)) {
        issues.push({
          file: path,
          level: "warning",
          message: "Stale index entry (file no longer on disk) — run `brain index`",
        });
      }
    }
  } catch {
    // DB unreadable or locked — drift check is best-effort
  }

  return issues;
}
