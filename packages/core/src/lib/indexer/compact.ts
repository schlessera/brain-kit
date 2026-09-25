/**
 * Reclaiming the vector slots sqlite-vec leaves behind.
 *
 * `vec_chunks` is a vec0 table, and sqlite-vec 0.1.9 stores its vectors in
 * fixed-size internal chunks. Deleting a row only clears its bit in the
 * chunk's validity bitmap: the slot is never reused, and `VACUUM` cannot see
 * inside the chunk blob to reclaim it (asg017/sqlite-vec#220). An incremental
 * index deletes and re-inserts the vectors of every edited document, so a
 * long-lived brain accumulates chunks that are mostly dead slots. A chunk is
 * only dropped once every one of its slots is dead.
 *
 * The one way back is the one the v2 schema migration already uses: copy the
 * live rows out, recreate the table, copy them back. That rewrites vectors
 * that exist; it never calls a provider, so it is safe from cron.
 */
import type { Database } from "bun:sqlite";

import { hasVecSupport, vecTableExists } from "../db.js";
import { acquireEmbeddingLock } from "./embedding-lock.js";

/** Live vectors, and the slots sqlite-vec has allocated to hold them. */
export interface VectorSlots {
  /** Rows in `vec_chunks`; null when the table exists but cannot be read. */
  live: number | null;
  /** Slots across the table's internal chunks; null when they cannot be read. */
  allocated: number | null;
}

/** The shadow table vec0 keeps its internal chunks in, as sqlite-vec 0.1.9 names it. */
const CHUNK_SHADOW_TABLE = "vec_chunks_chunks";

/**
 * Whether the chunk shadow table has the shape this reader expects. A
 * sqlite-vec upgrade that renames the table or its columns answers false,
 * and the slot count becomes unknown rather than wrong.
 */
function chunkShadowReadable(db: Database): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${CHUNK_SHADOW_TABLE})`).all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));
    return names.has("chunk_id") && names.has("size") && names.has("validity");
  } catch {
    return false;
  }
}

/**
 * Read the slot figures. The caller loads sqlite-vec first (`loadVecSupport`):
 * without it the vec0 table cannot be counted, and both figures are null, not
 * 0. A brain with no vector table at all has a known 0 of each.
 */
export function readVectorSlots(db: Database): VectorSlots {
  if (!vecTableExists(db)) return { live: 0, allocated: 0 };
  if (!hasVecSupport(db)) return { live: null, allocated: null };
  let live: number | null = null;
  try {
    live = (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;
  } catch {
    // a table the extension cannot read
  }
  let allocated: number | null = null;
  if (chunkShadowReadable(db)) {
    try {
      allocated = (
        db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM ${CHUNK_SHADOW_TABLE}`).get() as { n: number }
      ).n;
    } catch {
      // unreadable after all: unknown, never 0
    }
  }
  return { live, allocated };
}

/** Slots per internal chunk, read from the chunks the table already has. */
function chunkSize(db: Database): number | null {
  if (!chunkShadowReadable(db)) return null;
  const row = db.prepare(`SELECT MAX(size) AS n FROM ${CHUNK_SHADOW_TABLE}`).get() as { n: number | null };
  return row.n && row.n > 0 ? row.n : null;
}

/**
 * Whether compacting would reclaim anything worth the rewrite: fewer than half
 * the slots are live, and at least one whole internal chunk would be freed.
 * The second condition keeps a small brain, whose few vectors sit in one
 * mostly empty chunk, from being rewritten on every maintenance run for
 * nothing.
 */
export function needsCompaction(db: Database, slots: VectorSlots = readVectorSlots(db)): boolean {
  const { live, allocated } = slots;
  if (live === null || allocated === null || live * 2 >= allocated) return false;
  const size = chunkSize(db);
  if (size === null) return false;
  return allocated - Math.ceil(live / size) * size >= size;
}

/**
 * Rebuild `vec_chunks` from its live rows, then `VACUUM` so the freed pages
 * leave the file. The table is recreated from its own stored definition, so
 * its width, distance metric and metadata columns are exactly what they were.
 *
 * Holds the embedding lock, so no index run writes vectors into the table
 * while it is being replaced. Returns false when there is no vector table.
 */
export function compactVectors(db: Database): boolean {
  if (!vecTableExists(db)) return false;
  if (!hasVecSupport(db)) throw new Error("sqlite-vec is not loaded: the vector table cannot be rebuilt");
  const release = acquireEmbeddingLock(db);
  try {
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
      .get() as { sql: string };
    // Staged through a plain temp table, in SQL, so a brain with many large
    // vectors is never held in memory at once.
    db.transaction(() => {
      db.run("DROP TABLE IF EXISTS temp.vec_chunks_compact");
      db.run(
        `CREATE TEMP TABLE vec_chunks_compact AS
         SELECT chunk_id, embedding, is_archived, doc_type FROM vec_chunks`
      );
      db.run("DROP TABLE vec_chunks");
      db.run(sql);
      db.run(
        `INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type)
         SELECT chunk_id, embedding, is_archived, doc_type FROM temp.vec_chunks_compact ORDER BY chunk_id`
      );
      db.run("DROP TABLE temp.vec_chunks_compact");
    }).immediate();
    db.run("VACUUM");
    // VACUUM writes through the WAL; the main file only shrinks once it is
    // checkpointed. Best-effort, like the one at the end of an index run.
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // a reader in the way: the next checkpoint finishes the job
    }
    return true;
  } finally {
    release();
  }
}
