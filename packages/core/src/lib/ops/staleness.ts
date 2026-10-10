/**
 * Whether the index still describes the markdown on disk. One definition,
 * shared by the MCP read tools' staleness warning and `brain doctor`'s `db`
 * check, so the two can never disagree about the same brain (#1349).
 */
import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { resolve } from "path";

import { getMarkdownFiles } from "../indexer.js";
import type { Taxonomy } from "../taxonomy.js";

export interface IndexStaleness {
  /** Markdown files newer than their index row, missing from the index, or indexed and since deleted. */
  stale: number;
  /** Markdown documents in the index. */
  indexed: number;
}

/**
 * Compare every markdown file the indexer would scan with its `indexed_at`.
 * A file is stale when it was modified after it was indexed, was never
 * indexed, or is indexed but no longer on disk.
 */
export function indexStaleness(db: Database, root: string, taxonomy: Taxonomy): IndexStaleness {
  const rows = db
    .prepare("SELECT path, indexed_at FROM documents WHERE asset_type = 'markdown'")
    .all() as { path: string; indexed_at: string }[];
  const indexed = new Map(rows.map((r) => [r.path, Date.parse(r.indexed_at)]));

  let stale = 0;
  const seen = new Set<string>();
  for (const path of getMarkdownFiles(root, taxonomy)) {
    seen.add(path);
    const indexedAt = indexed.get(path);
    try {
      if (indexedAt === undefined || statSync(resolve(root, path)).mtimeMs > indexedAt) stale++;
    } catch {
      // Vanished between the scan and the stat: already marked seen, so not counted.
    }
  }
  for (const path of indexed.keys()) if (!seen.has(path)) stale++;
  return { stale, indexed: rows.length };
}
