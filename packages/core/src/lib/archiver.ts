import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, linkSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import matter from "gray-matter";

import { openDatabase, migrateVecSchema, storedVectorWidth } from "./db.js";
import { EMBEDDING_DIMENSIONS } from "./models.js";
import { updateDocument } from "./frontmatter-edit.js";
import { safeResolve } from "./safe-path.js";

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
 * The relevance a document gets when it is archived, by any route (#413,
 * #450): an archived doc claiming primary would still take the primary search
 * boost whenever archived docs are included, so a primary or unset relevance
 * becomes historical. An explicit secondary or historical is the author's
 * call and stays, which is `undefined` here: leave the key alone.
 */
export function relevanceOnArchive(raw: string): "historical" | undefined {
  const relevance = matter(raw, {}).data.relevance;
  return !relevance || relevance === "primary" ? "historical" : undefined;
}

/**
 * Archive a document: set status archived, demote a primary or unset
 * relevance to historical, bump updated, move
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

  // Validate the DESTINATION before mutating the source — a symlinked
  // projects/archive would otherwise rename the file out of the repo, and
  // failing after the rewrite would leave an active-path document marked
  // archived but not moved or reindexed.
  let archiveFullPath: string | null = null;
  if (willMove) {
    archiveFullPath = safeResolve(root, finalPath);
    if (!archiveFullPath) {
      throw new Error("Archive destination escapes the brain root directory");
    }
    if (existsSync(archiveFullPath)) {
      throw new Error(`Archive destination already exists: ${finalPath}`);
    }
  }

  if (options?.dryRun) {
    return { path: finalPath, status: "archived", moved: willMove, updated: today(), dryRun: true };
  }

  const raw = readFileSync(fullPath, "utf-8");
  const updates: Record<string, string> = { status: "archived" };
  const relevance = relevanceOnArchive(raw);
  if (relevance) updates.relevance = relevance;
  updates.updated = today();
  // Only these keys change; the rest of the file keeps its bytes (#449).
  const output = updateDocument(raw, updates);
  if (archiveFullPath) {
    mkdirSync(dirname(archiveFullPath), { recursive: true });
    // Publish a complete file with an atomic no-clobber link. Unlike rename,
    // link fails if a concurrent archive claimed the destination after our
    // preflight. Keep the source untouched until publication succeeds.
    const staging = mkdtempSync(join(dirname(archiveFullPath), ".brain-archive-"));
    try {
      const staged = join(staging, "document");
      writeFileSync(staged, output, { encoding: "utf-8", mode: statSync(fullPath).mode });
      try {
        linkSync(staged, archiveFullPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Archive destination already exists: ${finalPath}`);
        }
        throw error;
      }
      unlinkSync(fullPath);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    writeFileSync(fullPath, output, "utf-8");
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
      await migrateVecSchema(db, storedVectorWidth(db, dimensions));
      await options.reindex(db);
      db.close();
    }
  }

  return { path: finalPath, status: "archived", moved: willMove, updated: today() };
}
