/**
 * Files the user marked untrusted (G6, #2673). A mark is a host record keyed
 * by the brain-relative path, kept in the server database rather than
 * `brain.db`, so neither a restart nor `brain index --force` drops it. A file
 * that moves or disappears keeps its old-path record; nothing follows a
 * rename (maintainer ruling B, 2026-10-23).
 */
import type { Database } from "bun:sqlite";
import { posix } from "node:path";

export interface UntrustedMark {
  path: string;
  markedAt: number;
  /** The marking principal's id, or null when it was never known. */
  markedBy: string | null;
  /** That principal's label while it is still on record. */
  markedByLabel: string | null;
}

/**
 * The record key for a brain-relative path, or null when the path cannot
 * name a file in the brain. `./a` and `a//b` name the same record as `a` and
 * `a/b`; the HTTP routes resolve the path against the brain before writing.
 */
export function markKey(path: string): string | null {
  // The same syntax `safeResolve` refuses for a read.
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\") || path.includes(":")) return null;
  const normalized = posix.normalize(path).replace(/\/$/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

const SELECT = `SELECT m.path, m.marked_at AS markedAt, m.marked_by AS markedBy, p.label AS markedByLabel
  FROM untrusted_marks m LEFT JOIN principals p ON p.id = m.marked_by`;

export function getUntrustedMark(db: Database, path: string): UntrustedMark | null {
  return db.query(`${SELECT} WHERE m.path = ?`).get(path) as UntrustedMark | null;
}

/** Every mark, newest first. */
export function listUntrustedMarks(db: Database): UntrustedMark[] {
  return db.query(`${SELECT} ORDER BY m.marked_at DESC, m.path`).all() as UntrustedMark[];
}

/** Whether a brain-relative path is marked: the recorder's lookup. */
export function isMarkedUntrusted(db: Database, path: string): boolean {
  return db.query("SELECT 1 FROM untrusted_marks WHERE path = ?").get(path) !== null;
}

/** The record writes. Each reports whether it changed anything, so a race is told apart from a change. */
export function untrustedMarkOperations(db: Database) {
  return {
    mark(path: string, principalId: string | null, at: number): "marked" | "already_marked" {
      const inserted = db.query("INSERT INTO untrusted_marks (path, marked_at, marked_by) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING")
        .run(path, at, principalId);
      return inserted.changes > 0 ? "marked" : "already_marked";
    },
    clear(path: string): "cleared" | "already_cleared" {
      return db.query("DELETE FROM untrusted_marks WHERE path = ?").run(path).changes > 0 ? "cleared" : "already_cleared";
    },
  };
}
