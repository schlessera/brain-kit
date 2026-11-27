/**
 * What is on disk, and what the index already knows.
 *
 * The two directory scans are exported because `okf export` and `brain doctor`
 * need the same view of the corpus without running an index.
 */
import { discoveryFiles } from "../discovery-walk.js";
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "fs";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { resolve } from "path";

import { CHUNKER_VERSION } from "../chunker.js";
import { gitIgnoredMatcher, isAssetPath } from "../git-ignore.js";
import { nameKey } from "../name-key.js";
import { aliasKeys } from "./parse.js";
import { ASSET_EXTENSIONS } from "../types.js";
import type { Asset } from "../types.js";
import type { Taxonomy } from "../taxonomy.js";
import type { ExistingDoc, IndexOptions, IndexRun, ParseResult } from "./types.js";

/**
 * Scan `root` for *.md files, excluding configured dirs and files.
 */
export function getMarkdownFiles(root: string, taxonomy: Taxonomy): string[] {
  const files: string[] = [];
  for (const path of discoveryFiles(root, path => taxonomy.isExcludedDirectory(path))) {
    if (path.endsWith(".md") && !taxonomy.isExcludedPath(path)) {
      files.push(path);
    }
  }
  return files.sort();
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

/**
 * Scan `root` for image and PDF assets, excluding configured dirs and
 * whatever git ignores. Asset type and title come from the taxonomy resolver
 * (typeForPath / assetTitleFor), which replaces the reference brain's
 * inferAssetType/deriveAssetTitle tables.
 *
 * An ignored asset exists on this clone only, so indexing it would pay a
 * vision call and an embedding for something the other clones never see, and
 * make their search results differ. One that becomes ignored drops out of
 * this scan, and the deletion sweep removes it like a deleted file. Markdown
 * is not filtered this way: gitignored local notes stay searchable.
 */
export function getAssetFiles(root: string, taxonomy: Taxonomy): Asset[] {
  const assets: Asset[] = [];
  const candidates=[...discoveryFiles(root,path=>taxonomy.isExcludedDirectory(path))]
    .filter(path=>!taxonomy.isExcludedPath(path));
  const ignored = gitIgnoredMatcher(root,candidates.filter(isAssetPath));

  for (const path of candidates) {
    // The path as it is on disk, the way the markdown scan, the stats corpus
    // walk and the MCP listing test it: exclude entries are literal. Only the
    // extension below is case-folded. Lowercasing here made `dirs: ["drafts"]`
    // take the assets out of `Drafts/` while keeping its notes (#234).
    if (taxonomy.isExcludedPath(path)) continue;
    if (ignored(path)) continue;

    // Skip Zone.Identifier files (Windows WSL metadata)
    if (path.includes(":Zone.Identifier")) continue;

    const dot = path.lastIndexOf(".");
    if (dot <= path.lastIndexOf("/")) continue;
    const suffix = path.slice(dot + 1);
    if (!ASSET_EXTENSIONS.some(ext => suffix === ext.slice(1) || suffix === ext.slice(1).toUpperCase())) continue;
    const ext = "." + suffix.toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) continue;

    const fullPath = resolve(root, path);
    let sizeBytes: number;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      continue;
    }

    assets.push({
      path,
      mimeType,
      title: taxonomy.assetTitleFor(path),
      type: taxonomy.typeForPath(path),
      sizeBytes,
    });
  }

  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every document row already in the index, keyed by path.
 *
 * Loaded once per run and used for four different things, which is why it is
 * read even on a `--force` rebuild: change detection, the `accepted_mtime`
 * carry-over (a force rebuild that dropped it would silently reset every
 * silent-edit baseline), the asset stat-fingerprint fast path, and the
 * candidates of the deletion sweep. A targeted run plans from it too.
 */
export function loadExistingDocs(db: Database): Map<string, ExistingDoc> {
  const rows = db
    .prepare("SELECT id, path, asset_type, content_hash, chunker_version, accepted_mtime, stat_fingerprint FROM documents")
    .all() as (ExistingDoc & { path: string })[];
  const existing = new Map<string, ExistingDoc>();
  for (const row of rows) {
    existing.set(row.path, {
      id: row.id,
      asset_type: row.asset_type,
      content_hash: row.content_hash,
      chunker_version: row.chunker_version,
      accepted_mtime: row.accepted_mtime,
      stat_fingerprint: row.stat_fingerprint,
    });
  }
  return existing;
}

/** What a targeted run reads, and what it takes on trust from the index. */
export interface TargetedScan {
  /** Named paths that are markdown documents on disk the scan would find. */
  present: string[];
  /** Markdown rows the index holds for paths that were not named. */
  unnamed: string[];
  /** Asset rows the index holds; a targeted run leaves every one in place. */
  assetsIndexed: Set<string>;
}

/** Would `getMarkdownFiles` list this exact path? */
function isScannedMarkdown(root: string, taxonomy: Taxonomy, path: string): boolean {
  const parts = path.split("/");
  // `Glob` skips dot-entries and never yields traversal or an empty segment.
  if (!path.endsWith(".md") || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  if (taxonomy.isExcludedPath(path)) return false;
  try { return statSync(resolve(root, path)).isFile(); } catch { return false; }
}

/**
 * Plan a run over named paths only, or return undefined for a complete run.
 *
 * A targeted run is only as good as the rows it does not reread. It trusts
 * them only when they are what a complete run would leave: the index already
 * holds markdown, no row waits for a re-chunk or a cleared hash, and the
 * full-text table is not being rebuilt. Anything else, including the very
 * first index of a brain, is a complete run.
 */
export function targetedScan(run: IndexRun, options: IndexOptions, existingDocs: Map<string, ExistingDoc>): TargetedScan | undefined {
  if (!options.paths || run.force || run.wantEmbeddings || run.ftsRebuilt) return undefined;
  const markdown: string[] = [];
  const assetsIndexed = new Set<string>();
  for (const [path, existing] of existingDocs) {
    if (existing.asset_type !== "markdown") {
      assetsIndexed.add(path);
      continue;
    }
    if (existing.content_hash === null || existing.chunker_version !== CHUNKER_VERSION) return undefined;
    markdown.push(path);
  }
  if (markdown.length === 0) return undefined;
  const named = new Set(options.paths);
  return {
    present: [...named].filter((path) => isScannedMarkdown(run.root, run.taxonomy, path)).sort(),
    unnamed: markdown.filter((path) => !named.has(path)),
    assetsIndexed,
  };
}

/** A row as `completeCorpusMaps` reads it. */
interface CorpusRow {
  path: string;
  title: string;
  aliases: string | null;
  /** The row's `name_keys`, one per line; read only when `aliases` spans lines. */
  name_keys: string | null;
}

/**
 * Could one of a row's aliases span lines? An alias that does is a run of
 * two or more adjacent lines, and its name key (whitespace, line breaks
 * included, collapsed to one space) is among the row's name keys, which were
 * written from the whole aliases. No such run means every line is an alias of
 * its own. A run that matches may also be a separate alias or the title that
 * happens to equal those lines joined; that costs one file read, never a
 * wrong key.
 */
function mayHoldMultiLineAlias(lines: readonly string[], storedKeys: ReadonlySet<string>): boolean {
  for (let first = 0; first < lines.length - 1; first++) {
    for (let last = first + 1; last < lines.length; last++) {
      if (storedKeys.has(nameKey(lines.slice(first, last + 1).join("\n")))) return true;
    }
  }
  return false;
}

/**
 * A row's alias keys, as a parse of its file gives them.
 *
 * The `aliases` column holds one alias per line, so an alias that itself
 * holds a line break reads back as two. When one may (see
 * `mayHoldMultiLineAlias`), the aliases are read from the file itself, as a
 * fresh build reads them; a file that is gone or no longer parses leaves the
 * lines, for the run that reads it next.
 */
function storedAliasKeys(run: IndexRun, row: CorpusRow): string[] {
  const lines = (row.aliases ?? "").split("\n");
  if (row.name_keys !== null && mayHoldMultiLineAlias(lines, new Set(row.name_keys.split("\n")))) {
    try {
      return aliasKeys(parseFrontmatter(readFileSync(resolve(run.root, row.path), "utf-8"), { dataOnly: true }).data.aliases);
    } catch {
      // Gone or unparseable: the lines are what the index has.
    }
  }
  return aliasKeys(lines);
}

/**
 * Add the corpus the parse did not read to its maps: the title and aliases of
 * every row in `fromIndex` (a targeted run's unnamed rows, and any file the parse
 * found unchanged), as the index recorded them from that row's own
 * frontmatter. Link resolution then sees the same corpus a full parse does.
 */
export function completeCorpusMaps(run: IndexRun, parsed: ParseResult, fromIndex: readonly string[]): ParseResult {
  const wanted = new Set(fromIndex);
  const titles = new Map(parsed.fileMap);
  const aliases = new Map<string, string[]>();
  for (const [alias, paths] of parsed.aliasMap) for (const path of paths) aliases.set(path, [...(aliases.get(path) ?? []), alias]);
  // One statement for the whole corpus, not one per row it fills. Name keys
  // are read only for a row whose aliases span lines.
  const rows = run.db.prepare<CorpusRow, []>(
    `SELECT d.path, d.title, f.aliases,
       CASE WHEN instr(f.aliases, char(10)) > 0
         THEN (SELECT group_concat(k.key, char(10)) FROM name_keys k WHERE k.document_id = d.id) END AS name_keys
     FROM documents d LEFT JOIN documents_fts f ON f.rowid = d.id WHERE d.asset_type = 'markdown'`
  );
  for (const row of rows.iterate()) {
    const path = row.path;
    if (!wanted.has(path)) continue;
    titles.set(path, row.title);
    const keys = storedAliasKeys(run, row);
    if (keys.length) aliases.set(path, keys);
  }
  // In scan order, as a complete run fills them.
  const order = [...titles.keys()].sort();
  const fileMap = new Map(order.map((path) => [path, titles.get(path)!]));
  const aliasMap = new Map<string, string[]>();
  for (const path of order) for (const key of aliases.get(path) ?? []) aliasMap.set(key, [...(aliasMap.get(key) ?? []), path]);
  return { files: parsed.files, fileMap, aliasMap };
}
