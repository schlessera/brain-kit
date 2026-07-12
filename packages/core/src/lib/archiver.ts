import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import matter from "gray-matter";

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
  /**
   * Reindex hook run after the archive write (skipped on dryRun). The CLI wires
   * this to the incremental indexer; left undefined, the file is archived but
   * the index is not refreshed. Injected so this module does not hard-couple to
   * the indexer.
   */
  reindex?: () => Promise<void>;
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
    const archiveFullPath = resolve(root, finalPath);
    mkdirSync(dirname(archiveFullPath), { recursive: true });
    renameSync(fullPath, archiveFullPath);
  }

  if (options?.reindex) {
    await options.reindex();
  }

  return { path: finalPath, status: "archived", moved: willMove, updated: today() };
}
