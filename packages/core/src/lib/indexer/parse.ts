/**
 * Read every markdown file, decide what changed, and build the corpus-wide
 * maps the rest of the run needs.
 *
 * Two things are deliberately corpus-wide rather than change-scoped: the
 * path→title map and the alias map. Wiki-link resolution depends on the whole
 * corpus (a link is ambiguous only relative to every other file's basename),
 * so building these from changed files alone would resolve links against a
 * partial view and silently produce different targets on an incremental run
 * than on a rebuild.
 *
 * Nothing here touches the database. A file that cannot be read or parsed is
 * skipped with a warning rather than aborting the run — a file can vanish
 * between the scan and the read (git checkout, editors that save via rename),
 * and one bad frontmatter block should not cost the other 5,000 documents
 * their index.
 */
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import matter from "gray-matter";
import { resolve } from "path";

import type { ExistingDoc, IndexRun, ParsedFile, ParseResult } from "./types.js";

/** Why a file was skipped, in the words the user sees. */
type SkipReason = "unreadable" | "invalid frontmatter" | "missing required frontmatter";

function skip(run: IndexRun, path: string, reason: SkipReason, detail?: string): void {
  run.warn(`  SKIP: ${path} — ${reason}${detail ? ` (${detail})` : ""}`);
}

/**
 * Parse `files` and split them into "needs writing" and "unchanged".
 *
 * Unchanged files still contribute to `fileMap`/`aliasMap` — they are part of
 * the corpus even when this run has nothing to write for them. `stats.unchanged`
 * is incremented here; every other counter belongs to the phase that writes.
 */
export function parseMarkdownFiles(
  run: IndexRun,
  files: string[],
  existingDocs: Map<string, ExistingDoc>
): ParseResult {
  const parsed: ParsedFile[] = [];
  const fileMap = new Map<string, string>();
  const aliasMap = new Map<string, string[]>();

  for (const filePath of files) {
    const fullPath = resolve(run.root, filePath);

    let raw: string;
    let mtime: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
      mtime = statSync(fullPath).mtime.toISOString().split("T")[0];
    } catch (e) {
      // Left in `files`, so the deletion sweep will not remove it either.
      skip(run, filePath, "unreadable", (e as Error).message);
      continue;
    }
    const hash = createHash("sha256").update(raw).digest("hex");

    let data: Record<string, any>;
    let content: string;
    try {
      const front = matter(raw);
      data = front.data;
      content = front.content;
    } catch {
      skip(run, filePath, "invalid frontmatter");
      continue;
    }

    if (!data.title || !data.type) {
      skip(run, filePath, "missing required frontmatter", "title, type");
      continue;
    }

    fileMap.set(filePath, String(data.title));
    collectAliases(aliasMap, data.aliases, filePath);

    const existing = existingDocs.get(filePath);
    const isNew = !existing;
    const isChanged = !isNew && existing!.content_hash !== hash;

    if (!run.force && !isNew && !isChanged) {
      run.stats.unchanged++;
      continue;
    }

    parsed.push({ path: filePath, data, content, hash, mtime, isNew, isChanged });
  }

  return { files: parsed, fileMap, aliasMap };
}

/** Record this file's frontmatter aliases into the corpus-wide alias map. */
function collectAliases(
  aliasMap: Map<string, string[]>,
  aliases: unknown,
  filePath: string
): void {
  if (!Array.isArray(aliases)) return;
  for (const alias of aliases) {
    const key = String(alias).toLowerCase().trim();
    if (!key) continue;
    const paths = aliasMap.get(key) ?? [];
    paths.push(filePath);
    aliasMap.set(key, paths);
  }
}
