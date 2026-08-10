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

import matter from "gray-matter";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

import { VALID_STATUSES, VALID_RELEVANCES } from "./types.js";
import type { Taxonomy } from "./taxonomy.js";
import {
  getMarkdownFiles,
  resolveWikiLink,
  resolveAlias,
  extractWikiLinks,
} from "./indexer.js";

export interface ValidationIssue {
  file: string;
  level: "error" | "warning";
  message: string;
}

export function validate(root: string, taxonomy: Taxonomy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const files = getMarkdownFiles(root, taxonomy);

  // Build the same maps the indexer uses, so validation and resolution agree
  const fileMap = new Map<string, string>();
  const aliasMap = new Map<string, string[]>();
  const basenameCounts = new Map<string, number>();
  for (const path of files) {
    fileMap.set(path, path);
    const basename = path.replace(/\.md$/, "").split("/").pop()!;
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
    try {
      const { data } = matter(readFileSync(resolve(root, path), "utf-8"));
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
      const parsed = matter(raw);
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

    // Tag format validation
    if (Array.isArray(data.tags)) {
      for (const tag of data.tags) {
        if (typeof tag !== "string" || tag !== tag.toLowerCase() || tag.includes(" ")) {
          issues.push({
            file: filePath,
            level: "warning",
            message: `Tag "${tag}" should be lowercase and hyphenated (no spaces)`,
          });
        }
      }
    }

    // Wiki-link validation — uses the indexer's resolver so warnings match
    // what the link graph will actually contain
    const wikiLinks = extractWikiLinks(content);
    for (const link of wikiLinks) {
      const resolved =
        resolveWikiLink(link, fileMap, filePath, taxonomy.dirAnchors) ??
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

  return issues;
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
