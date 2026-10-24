/**
 * What is on disk, and what the index already knows.
 *
 * The two directory scans are exported because `okf export` and `brain doctor`
 * need the same view of the corpus without running an index.
 */
import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { resolve } from "path";

import { CHUNKER_VERSION } from "../chunker.js";
import { gitIgnoredMatcher } from "../git-ignore.js";
import { ASSET_EXTENSIONS } from "../types.js";
import type { Asset } from "../types.js";
import type { Taxonomy } from "../taxonomy.js";
import type { ExistingDoc, IndexOptions, IndexRun, ParseResult } from "./types.js";

/**
 * Scan `root` for *.md files, excluding configured dirs and files.
 */
export function getMarkdownFiles(root: string, taxonomy: Taxonomy): string[] {
  const glob = new Glob("**/*.md");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: root })) {
    if (!taxonomy.isExcludedPath(path)) {
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
  // Include both lowercase and uppercase extensions (.jpg and .JPG, etc.)
  const exts = ASSET_EXTENSIONS.map((e) => e.slice(1));
  const allExts = [...exts, ...exts.map((e) => e.toUpperCase())];
  const pattern = `**/*.{${allExts.join(",")}}`;
  const glob = new Glob(pattern);
  const assets: Asset[] = [];
  const ignored = gitIgnoredMatcher(root);

  for (const path of glob.scanSync({ cwd: root })) {
    // The path as it is on disk, the way the markdown scan, the stats corpus
    // walk and the MCP listing test it: exclude entries are literal. Only the
    // extension below is case-folded. Lowercasing here made `dirs: ["drafts"]`
    // take the assets out of `Drafts/` while keeping its notes (#234).
    if (taxonomy.isExcludedPath(path)) continue;
    if (ignored(path)) continue;

    // Skip Zone.Identifier files (Windows WSL metadata)
    if (path.includes(":Zone.Identifier")) continue;

    const ext = "." + path.split(".").pop()!.toLowerCase();
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
 * Loaded once per run and used for three different things, which is why it is
 * read even on a `--force` rebuild: change detection, the `accepted_mtime`
 * carry-over (a force rebuild that dropped it would silently reset every
 * silent-edit baseline), and the asset stat-fingerprint fast path.
 */
export function loadExistingDocs(db: Database): Map<string, ExistingDoc> {
  const rows = db
    .prepare("SELECT id, path, content_hash, chunker_version, accepted_mtime, stat_fingerprint FROM documents")
    .all() as (ExistingDoc & { path: string })[];
  const existing = new Map<string, ExistingDoc>();
  for (const row of rows) {
    existing.set(row.path, {
      id: row.id,
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
  const rows = run.db.prepare("SELECT path, asset_type FROM documents").all() as { path: string; asset_type: string }[];
  const markdown = rows.filter((row) => row.asset_type === "markdown").map((row) => row.path);
  if (markdown.length === 0) return undefined;
  for (const path of markdown) {
    const existing = existingDocs.get(path)!;
    if (existing.content_hash === null || existing.chunker_version !== CHUNKER_VERSION) return undefined;
  }
  const named = new Set(options.paths);
  return {
    present: [...named].filter((path) => isScannedMarkdown(run.root, run.taxonomy, path)).sort(),
    unnamed: markdown.filter((path) => !named.has(path)),
    assetsIndexed: new Set(rows.filter((row) => row.asset_type !== "markdown").map((row) => row.path)),
  };
}

/**
 * Add the corpus the targeted parse did not read to its maps: every unnamed
 * row's title and aliases, as the index recorded them from that row's own
 * frontmatter. Link resolution then sees the same corpus a complete run does.
 */
export function completeCorpusMaps(run: IndexRun, parsed: ParseResult, unnamed: readonly string[]): ParseResult {
  const read = run.db.prepare(
    "SELECT d.title, f.aliases FROM documents d LEFT JOIN documents_fts f ON f.rowid = d.id WHERE d.path = ?"
  );
  const titles = new Map(parsed.fileMap);
  const aliases = new Map<string, string[]>();
  for (const [alias, paths] of parsed.aliasMap) for (const path of paths) aliases.set(path, [...(aliases.get(path) ?? []), alias]);
  for (const path of unnamed) {
    const row = read.get(path) as { title: string; aliases: string | null } | null;
    if (!row) continue;
    titles.set(path, row.title);
    const keys = (row.aliases ?? "").split("\n").map((alias) => alias.toLowerCase().trim()).filter(Boolean);
    if (keys.length) aliases.set(path, keys);
  }
  // In scan order, as a complete run fills them.
  const order = [...titles.keys()].sort();
  const fileMap = new Map(order.map((path) => [path, titles.get(path)!]));
  const aliasMap = new Map<string, string[]>();
  for (const path of order) for (const key of aliases.get(path) ?? []) aliasMap.set(key, [...(aliasMap.get(key) ?? []), path]);
  return { files: parsed.files, fileMap, aliasMap };
}
