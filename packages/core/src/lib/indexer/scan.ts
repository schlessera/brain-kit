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

import { ASSET_EXTENSIONS } from "../types.js";
import type { Asset } from "../types.js";
import type { Taxonomy } from "../taxonomy.js";
import type { ExistingDoc } from "./types.js";

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
 * Scan `root` for image and PDF assets, excluding configured dirs. Asset
 * type and title come from the taxonomy resolver (typeForPath / assetTitleFor),
 * which replaces the reference brain's inferAssetType/deriveAssetTitle tables.
 */
export function getAssetFiles(root: string, taxonomy: Taxonomy): Asset[] {
  // Include both lowercase and uppercase extensions (.jpg and .JPG, etc.)
  const exts = ASSET_EXTENSIONS.map((e) => e.slice(1));
  const allExts = [...exts, ...exts.map((e) => e.toUpperCase())];
  const pattern = `**/*.{${allExts.join(",")}}`;
  const glob = new Glob(pattern);
  const assets: Asset[] = [];

  for (const path of glob.scanSync({ cwd: root })) {
    // The path as it is on disk, the way the markdown scan, the stats corpus
    // walk and the MCP listing test it: exclude entries are literal. Only the
    // extension below is case-folded. Lowercasing here made `dirs: ["drafts"]`
    // take the assets out of `Drafts/` while keeping its notes (#234).
    if (taxonomy.isExcludedPath(path)) continue;

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
    .prepare("SELECT id, path, content_hash, accepted_mtime, stat_fingerprint FROM documents")
    .all() as (ExistingDoc & { path: string })[];
  const existing = new Map<string, ExistingDoc>();
  for (const row of rows) {
    existing.set(row.path, {
      id: row.id,
      content_hash: row.content_hash,
      accepted_mtime: row.accepted_mtime,
      stat_fingerprint: row.stat_fingerprint,
    });
  }
  return existing;
}
