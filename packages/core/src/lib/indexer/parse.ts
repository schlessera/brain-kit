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
 * A file whose bytes and chunker version match its row is read and hashed but
 * not parsed: a row is written only from a successful parse, so its title and
 * aliases are what a parse of those bytes produced, and the caller takes them
 * from the index (`completeCorpusMaps`). An alias that itself holds a line
 * break is the one thing the index cannot give back whole, because aliases
 * are stored one per line; `completeCorpusMaps` reads such a file's aliases
 * from the file instead.
 *
 * Nothing here writes to the database. A file that cannot be read or parsed is
 * skipped with a warning rather than aborting the run — a file can vanish
 * between the scan and the read (git checkout, editors that save via rename),
 * and one bad frontmatter block should not cost the other 5,000 documents
 * their index.
 */
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { resolve } from "path";

import { CHUNKER_VERSION } from "../chunker.js";
import type { ExistingDoc, IndexRun, ParsedFile, ParseResult } from "./types.js";

/** Why a file was skipped, in the words the user sees. */
type SkipReason = "unreadable" | "invalid frontmatter" | "missing required frontmatter";

function skip(run: IndexRun, path: string, reason: SkipReason, detail?: string): void {
  run.warn(`  SKIP: ${path} — ${reason}${detail ? ` (${detail})` : ""}`);
}

/**
 * Parse `files` and split them into "needs writing" and "unchanged".
 *
 * Unchanged files are part of the corpus even when this run has nothing to
 * write for them, so they still belong in `fileMap`/`aliasMap`. They are not
 * parsed: their paths come back in `unparsed`, in scan order, for the caller
 * to fill the maps from the index. `stats.unchanged` is incremented here;
 * every other counter belongs to the phase that writes.
 */
export function parseMarkdownFiles(
  run: IndexRun,
  files: string[],
  existingDocs: Map<string, ExistingDoc>
): ParseResult & { unparsed: string[] } {
  const unparsed: string[] = [];
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

    const existing = existingDocs.get(filePath);
    // Another chunker's chunks count as a change: an older one, one from
    // before versions were recorded (NULL), or a newer one after a rollback.
    // The file is re-chunked once. A file skipped below keeps its old version
    // and is retried next run. A rebuilt full-text table has every document
    // written again.
    const isChanged =
      !!existing &&
      (existing.content_hash !== hash || existing.chunker_version !== CHUNKER_VERSION || run.ftsRebuilt === true);

    if (!run.force && existing && !isChanged) {
      run.stats.unchanged++;
      unparsed.push(filePath);
      continue;
    }

    let data: Record<string, any>;
    let content: string;
    try {
      const front = parseFrontmatter(raw, { dataOnly: true });
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

    parsed.push({ path: filePath, data, content, hash, mtime, isNew: !existing, isChanged });
  }

  return { files: parsed, fileMap, aliasMap, unparsed };
}

/** The alias-map keys of a file's frontmatter `aliases`, in frontmatter order. */
export function aliasKeys(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) return [];
  return aliases.map((alias) => String(alias).toLowerCase().trim()).filter(Boolean);
}

/** Record this file's frontmatter aliases into the corpus-wide alias map. */
function collectAliases(
  aliasMap: Map<string, string[]>,
  aliases: unknown,
  filePath: string
): void {
  for (const key of aliasKeys(aliases)) {
    const paths = aliasMap.get(key) ?? [];
    paths.push(filePath);
    aliasMap.set(key, paths);
  }
}
