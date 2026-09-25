/**
 * `brain stats --json`, spawned, over a brain that actually holds vectors.
 *
 * Nothing at this tier could ever be embedded: the spawned bin runs keyless,
 * so `brain index` leaves `vec_chunks` empty and every assertion read
 * `embeddings: 0` — the right number for the wrong reason, and byte-for-byte
 * what a count that threw and was swallowed produced. `brain stats` reported
 * exactly that on a fully embedded brain until 0.37.0 (#94, PR #117) and
 * nothing here could tell. These tests put the three states side by side: no
 * `vec_chunks` at all, an empty one, and one holding a known count.
 *
 * Keyless throughout: the vectors come from an injected fake provider, and the
 * spawned bin runs with every API key stripped from its environment.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";

import { openDatabase } from "../src/lib/db";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { embedTempBrain, loadVec, VEC_DIMENSIONS } from "./vec-fixture";

/** Vectors the fixture corpus yields: one per chunk, its three assets included. */
const CORPUS_VECTORS = 30;

interface Stats {
  chunks: number;
  embeddings: number | null;
  health: { embeddingCoverage: number | null };
}

/** Indexed keyless through the real bin: chunks, and an empty `vec_chunks`. */
let bare: string;
/** The same, with `vec_chunks` removed: a brain that has never been embedded. */
let absent: string;
/** The same corpus, indexed in-process with a fake provider: vectors and all. */
let embedded: string;
let staged: number;

beforeAll(async () => {
  // Staged first: without sqlite-vec this throws naming the extension, which
  // is the decided policy and the reason this file cannot go green with zero
  // vectors in an environment that lost it.
  embedded = makeTempBrain();
  staged = await embedTempBrain(embedded);

  bare = makeTempBrain();
  expect((await runCli(bare, ["index", "--json"])).code).toBe(0);

  absent = makeTempBrain();
  expect((await runCli(absent, ["index", "--json"])).code).toBe(0);
  await dropVecTable(absent);
});

afterAll(() => {
  for (const root of [bare, absent, embedded]) cleanup(root);
});

async function stats(root: string): Promise<Stats> {
  const { stdout, stderr, code } = await runCli(root, ["stats", "--json"]);
  expect(code).toBe(0);
  // The extension loaded on the stats connection; nothing may claim otherwise.
  expect(stderr).not.toContain("sqlite-vec not available");
  return JSON.parse(stdout) as Stats;
}

/** Vectors in `vec_chunks`, counted properly, or -1 when there is no table. */
async function countVectors(root: string): Promise<number> {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    await loadVec(db);
    // A missing table is -1, never 0: the two are the states this file exists
    // to keep apart, so the count may not quietly answer for the absence.
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
      .get();
    if (table === null) return -1;
    return (db.prepare("SELECT COUNT(*) AS count FROM vec_chunks").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

/** Drop the vec0 table, which needs the extension on this connection too. */
async function dropVecTable(root: string): Promise<void> {
  const db = new Database(join(root, "brain.db"), { readwrite: true, create: false });
  try {
    await loadVec(db);
    db.run("DROP TABLE IF EXISTS vec_chunks");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function meta(root: string, key: string): string | null {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

describe("brain stats --json over a brain with vectors", () => {
  test("reports the exact count the fixture staged", async () => {
    expect(staged).toBe(CORPUS_VECTORS);
    expect(await countVectors(embedded)).toBe(CORPUS_VECTORS);

    const out = await stats(embedded);
    expect(out.embeddings).toBe(CORPUS_VECTORS);
    expect(out.chunks).toBe(CORPUS_VECTORS);
    expect(out.health.embeddingCoverage).toBe(1);
  });

  test("the vectors are the fake provider's, so the fixture needs no key", () => {
    expect(meta(embedded, "embedding_model")).toBe(`fake:${VEC_DIMENSIONS}`);
    expect(meta(embedded, "embedding_dimensions")).toBe(String(VEC_DIMENSIONS));
  });
});

describe("an absent, an empty and a full vec_chunks are three different answers", () => {
  // The pair that was missing: until an embedded brain existed at this tier,
  // `embeddings` was 0 in every spawned assertion and the field carried no
  // information at all.
  test("no table and an empty table both report 0 with unknown coverage", async () => {
    expect(await countVectors(absent)).toBe(-1);
    const withoutTable = await stats(absent);
    expect(withoutTable.embeddings).toBe(0);
    expect(withoutTable.health.embeddingCoverage).toBeNull();

    // `brain index` creates `vec_chunks` whether or not it can fill it, so a
    // keyless index leaves an empty table rather than no table. The reported 0
    // is a real count here, and still means "nothing embedded".
    expect(await countVectors(bare)).toBe(0);
    const withEmptyTable = await stats(bare);
    expect(withEmptyTable.embeddings).toBe(0);
    expect(withEmptyTable.health.embeddingCoverage).toBeNull();
  });

  test("a full table reports the count and a coverage that is not null", async () => {
    const out = await stats(embedded);
    expect(out.embeddings).toBe(CORPUS_VECTORS);
    expect(out.embeddings).toBeGreaterThan(0);
    expect(out.health.embeddingCoverage).not.toBeNull();
  });
});

describe("the count is a count, not a swallowed failure", () => {
  // `openDatabase(.., { readonly: true })` does not load sqlite-vec, and vec0
  // is a per-connection module: the bare `SELECT COUNT(*)` below throws. Until
  // 0.37.0 a `catch` turned that into 0, which is why a fully embedded brain
  // reported `embeddings: 0`. This is the assertion that would have failed
  // then and passes now.
  test("counting vec_chunks without the extension does not produce the reported figure", async () => {
    const dbPath = join(embedded, "brain.db");

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(() => db.prepare("SELECT COUNT(*) AS count FROM vec_chunks").get()).toThrow(
        /no such module: vec0/
      );
    } finally {
      db.close();
    }

    const reported = (await stats(embedded)).embeddings;
    expect(reported).toBe(CORPUS_VECTORS);
    expect(swallowedCount(dbPath)).toBe(0);
    expect(reported).not.toBe(swallowedCount(dbPath));
  });
});

/** The pre-0.37.0 read, verbatim: no extension, and the failure swallowed. */
function swallowedCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM vec_chunks").get() as { count: number })
      .count;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * A brain whose vector table was churned the way incremental indexing churns
 * it: 3,000 extra vectors, then 800 edits that each delete five vectors at
 * random and insert five with new ids. Chunk rows go with them, so an index
 * run sees nothing orphaned. sqlite-vec never reuses a deleted slot, and a
 * random delete rarely empties a whole internal chunk, so the table grows.
 */
async function churnedBrain(): Promise<string> {
  const root = makeTempBrain();
  await embedTempBrain(root);
  const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: VEC_DIMENSIONS });
  try {
    await loadVec(db);
    const { id: docId } = db
      .prepare("SELECT id FROM documents WHERE asset_type = 'markdown' ORDER BY id LIMIT 1")
      .get() as { id: number };
    const insertChunk = db.prepare(
      "INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate) VALUES (?, ?, 'Churn', ?, 1)"
    );
    const insertVector = db.prepare(
      "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, 0, 'note')"
    );
    const deleteVector = db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
    const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
    let seed = 20260925;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const vector = () => new Float32Array(VEC_DIMENSIONS).map(() => random());
    let chunkIndex = 10_000;
    const live: number[] = [];
    const add = () => {
      const id = Number(insertChunk.run(docId, chunkIndex, `churn ${chunkIndex++}`).lastInsertRowid);
      insertVector.run(id, vector());
      live.push(id);
    };
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) add();
    })();
    for (let edit = 0; edit < 800; edit++) {
      db.transaction(() => {
        for (let k = 0; k < 5; k++) {
          const [gone] = live.splice(Math.floor(random() * live.length), 1);
          deleteVector.run(gone);
          deleteChunk.run(gone);
          add();
        }
      })();
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return root;
}

interface SlotStats {
  size: { db: { bytes: number; vectorSlots: { live: number | null; allocated: number | null } } };
}

async function slotStats(root: string): Promise<SlotStats["size"]["db"]> {
  return ((await stats(root)) as unknown as SlotStats).size.db;
}

/** The ten nearest vectors to a fixed query, by id, in rank order. */
async function nearest(root: string): Promise<number[]> {
  const db = new Database(join(root, "brain.db"), { readonly: true });
  try {
    await loadVec(db);
    const query = new Float32Array(VEC_DIMENSIONS).map((_, i) => (i % 3) / 3);
    return (
      db
        .prepare("SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? AND k = 10 ORDER BY distance")
        .all(query) as { chunk_id: number }[]
    ).map((r) => r.chunk_id);
  } finally {
    db.close();
  }
}

/** Slots in one internal chunk of sqlite-vec 0.1.9's vec0. */
const CHUNK_SLOTS = 1024;

describe("vector slots and compaction (#420)", () => {
  const LIVE = CORPUS_VECTORS + 3000;

  test("a churned table reports more than twice as many slots as live vectors", async () => {
    const root = await churnedBrain();
    try {
      const { vectorSlots } = await slotStats(root);
      expect(vectorSlots.live).toBe(LIVE);
      expect(vectorSlots.allocated!).toBeGreaterThan(2 * LIVE);
    } finally {
      cleanup(root);
    }
  }, 120_000);

  test("brain index --compact reclaims the dead slots and keeps every neighbour", async () => {
    const root = await churnedBrain();
    try {
      const before = await slotStats(root);
      const neighbours = await nearest(root);
      expect(neighbours.length).toBe(10);

      const result = await runCli(root, ["index", "--compact", "--json"]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.compacted).toBe(true);
      expect(body.before).toEqual(before.vectorSlots);

      const after = await slotStats(root);
      expect(body.after).toEqual(after.vectorSlots);
      expect(after.vectorSlots.live).toBe(LIVE);
      expect(after.vectorSlots.allocated! - LIVE).toBeGreaterThanOrEqual(0);
      expect(after.vectorSlots.allocated! - LIVE).toBeLessThan(CHUNK_SLOTS);
      expect(after.bytes).toBeLessThan(before.bytes);
      expect(await nearest(root)).toEqual(neighbours);
    } finally {
      cleanup(root);
    }
  }, 120_000);

  test("brain maintain compacts a churned table and leaves a fresh one alone", async () => {
    const churned = await churnedBrain();
    const fresh = makeTempBrain();
    try {
      await embedTempBrain(fresh);
      const freshBefore = await slotStats(fresh);
      expect(freshBefore.vectorSlots).toEqual({ live: CORPUS_VECTORS, allocated: CHUNK_SLOTS });

      const vectorsStep = async (root: string) => {
        const { stdout } = await runCli(root, ["maintain", "--json"]);
        return (JSON.parse(stdout) as Array<{ step: string; result: string }>).find((r) => r.step === "vectors");
      };

      const neighbours = await nearest(churned);
      expect(neighbours.length).toBe(10);
      expect((await vectorsStep(churned))?.result).toStartWith("ok — compacted ");
      const compacted = (await slotStats(churned)).vectorSlots;
      // Compaction must keep every vector: a step that emptied the table
      // would also leave few dead slots.
      expect(compacted.live).toBe(LIVE);
      expect(typeof compacted.allocated).toBe("number");
      expect(compacted.allocated! - LIVE).toBeGreaterThanOrEqual(0);
      expect(compacted.allocated! - LIVE).toBeLessThan(CHUNK_SLOTS);
      expect(await nearest(churned)).toEqual(neighbours);

      expect(await vectorsStep(fresh)).toEqual({
        step: "vectors",
        result: `ok — ${CORPUS_VECTORS} of ${CHUNK_SLOTS} slots live, nothing to reclaim`,
      });
      expect((await slotStats(fresh)).vectorSlots).toEqual(freshBefore.vectorSlots);
    } finally {
      cleanup(churned);
      cleanup(fresh);
    }
  }, 180_000);
});
