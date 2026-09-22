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

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { embedTempBrain, loadVec, VEC_DIMENSIONS } from "./vec-fixture";

/** Vectors the fixture corpus yields: one per chunk, its three assets included. */
const CORPUS_VECTORS = 30;

interface Stats {
  chunks: number;
  embeddings: number;
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
