/**
 * The index reads `brain briefing` makes for its sections, kept out of the
 * command so the CLI holds no SQL. The silent-edit section reads
 * `silentEdits` (hygiene.ts), the one query hygiene shares.
 */
import type { Database } from "bun:sqlite";

/** A document the focus document links to. */
export interface FocusLinkedDocument {
  path: string;
  title: string;
  type: string;
  updated: string;
  summary: string | null;
}

/** Every indexed document `path` wiki-links to, most recently updated first. */
export function focusLinkedDocuments(db: Database, path: string): FocusLinkedDocument[] {
  return db
    .prepare(
      `SELECT d.path, d.title, d.type, d.updated, d.summary
       FROM links l
       JOIN documents d ON d.id = l.target_id
       WHERE l.source_id = (SELECT id FROM documents WHERE path = ?)
       ORDER BY d.updated DESC`
    )
    .all(path) as FocusLinkedDocument[];
}

/** A non-archived document with a deadline. */
export interface DeadlineRow {
  deadline: string;
  path: string;
  title: string;
  summary: string | null;
}

/** Non-archived documents whose deadline falls in `from`..`to` (inclusive), soonest first. */
export function upcomingDeadlines(db: Database, from: string, to: string): DeadlineRow[] {
  return db
    .prepare(
      `SELECT deadline, path, title, summary FROM documents
       WHERE deadline >= ? AND deadline <= ? AND status != 'archived'
       ORDER BY deadline ASC`
    )
    .all(from, to) as DeadlineRow[];
}

/** A non-archived document whose `next_review` has passed. */
export interface OverdueReviewRow {
  next_review: string;
  path: string;
  title: string;
}

/** Non-archived documents whose `next_review` is before `today`, longest overdue first. */
export function overdueReviewRows(db: Database, today: string): OverdueReviewRow[] {
  return db
    .prepare(
      `SELECT next_review, path, title FROM documents
       WHERE next_review IS NOT NULL AND next_review < ? AND status != 'archived'
       ORDER BY next_review ASC`
    )
    .all(today) as OverdueReviewRow[];
}

/** The indexed frontmatter `updated` of `path`; null when it is not indexed or has none. */
export function documentUpdated(db: Database, path: string): string | null {
  const row = db.prepare("SELECT updated FROM documents WHERE path = ?").get(path) as { updated: string | null } | null;
  return row?.updated ?? null;
}
