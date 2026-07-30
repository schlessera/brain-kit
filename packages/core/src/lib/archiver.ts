import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import matter from "gray-matter";

import { openDatabase, initVecSupport } from "./db";
import { EMBEDDING_DIMENSIONS } from "./models";
import { stringifyDocument } from "./frontmatter";
import { safeResolve } from "./safe-path";

export interface ArchiveResult {
  path: string;
  status: "archived";
  moved: boolean;
  updated: string;
  dryRun?: boolean;
}

export interface ArchiveOptions {
  dryRun?: boolean;
  db?: Database;
  /**
   * Reindex the brain after the archive write (skipped on dryRun). The CLI
   * wires this to the incremental indexer's indexAll(); injected so this module
   * does not hard-couple to the indexer. Same shape ingestion.ts uses.
   */
  reindex?: (db: Database) => Promise<unknown>;
  /** Embedding dimensions for the vec table when opening a fresh db (fallback path). */
  embeddingDimensions?: number;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Archive a document: set status archived, bump updated, move
 * projects/active/ files to projects/archive/, and reindex.
 * With dryRun, reports what would happen without touching anything.
 */
export async function archiveDocument(
  root: string,
  relPath: string,
  options?: ArchiveOptions
): Promise<ArchiveResult> {
  const fullPath = safeResolve(root, relPath);
  if (!fullPath) {
    throw new Error("Path escapes the brain root directory");
  }
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${relPath}`);
  }

  const willMove = relPath.startsWith("projects/active/");
  const finalPath = willMove
    ? relPath.replace("projects/active/", "projects/archive/")
    : relPath;

  if (options?.dryRun) {
    return { path: finalPath, status: "archived", moved: willMove, updated: today(), dryRun: true };
  }

  const raw = readFileSync(fullPath, "utf-8");
  const parsed = matter(raw);
  parsed.data.status = "archived";
  parsed.data.updated = today();
  writeFileSync(fullPath, stringifyDocument(parsed.content, parsed.data), "utf-8");

  if (willMove) {
    // The DESTINATION needs containment too — a symlinked projects/archive
    // would otherwise rename the file straight out of the repo.
    const archiveFullPath = safeResolve(root, finalPath);
    if (!archiveFullPath) {
      throw new Error("Archive destination escapes the brain root directory");
    }
    mkdirSync(dirname(archiveFullPath), { recursive: true });
    renameSync(fullPath, archiveFullPath);
  }

  // Reindex is injected (indexAll lives in the indexer, another module). The
  // caller may hand in an open db; otherwise open one, load vec support, and
  // close it — mirroring the original two-branch behaviour.
  if (options?.reindex) {
    if (options.db) {
      await options.reindex(options.db);
    } else {
      const dimensions = options.embeddingDimensions ?? EMBEDDING_DIMENSIONS;
      const db = openDatabase(resolve(root, "brain.db"), { embeddingDimensions: dimensions });
      await initVecSupport(db, dimensions);
      await options.reindex(db);
      db.close();
    }
  }

  return { path: finalPath, status: "archived", moved: willMove, updated: today() };
}
