/**
 * Search asks the database what it has before it uses a later table or
 * column (#4715). It asks `indexShape`, which answers per connection under
 * SQLite's schema cookie: a repeated search compiles no `sqlite_master`
 * probe, and a long-lived reader still sees a migration another connection
 * ran.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "path";

import { openDatabase } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import { cleanup, makeTempBrain } from "./cli-harness";
import { embedTempBrain, fakeEmbeddingProvider, loadVec } from "./vec-fixture";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

async function stagedBrain(): Promise<string> {
  const root = makeTempBrain();
  roots.push(root);
  await embedTempBrain(root);
  return join(root, ".brain-index", "brain.db");
}

/** Every statement text `db` compiles through `prepare` or `query` while `fn` runs. */
async function compiled(db: Database, fn: () => Promise<unknown>): Promise<string[]> {
  const texts: string[] = [];
  const prepare = db.prepare;
  const query = db.query;
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    texts.push(sql);
    return (prepare as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.prepare;
  db.query = ((sql: string) => {
    texts.push(sql);
    return query.call(db, sql);
  }) as typeof db.query;
  try {
    await fn();
  } finally {
    db.prepare = prepare;
    db.query = query;
  }
  return texts;
}

describe("indexShape", () => {
  test("the second of two identical hybrid searches on one connection compiles no sqlite_master probe", async () => {
    const path = await stagedBrain();
    const db = openDatabase(path, { readonly: true });
    try {
      await loadVec(db);
      const search = () =>
        hybridSearch(db, { query: "Ithaca", mode: "hybrid", chunks: true, rerank: "none" }, { embeddings: fakeEmbeddingProvider() });
      const first = await compiled(db, search);
      // The first search does ask, so the probe this test looks for is the one search uses.
      expect(first.filter((sql) => sql.includes("sqlite_master")).length).toBeGreaterThan(0);
      const second = await compiled(db, search);
      expect(second.filter((sql) => sql.includes("sqlite_master"))).toEqual([]);
      // Both lanes ran: the vector lane was not skipped for a missing table or extension.
      expect((await search()).warnings).toEqual([]);
    } finally {
      db.close();
    }
  }, 120_000);

  test("a long-lived reader sees the tables a writable connection's migration added", async () => {
    const path = await stagedBrain();
    const old = openDatabase(path);
    for (const trigger of ["chunks_fts_insert", "chunks_fts_delete", "chunks_fts_update"]) old.run(`DROP TRIGGER ${trigger}`);
    old.run("DROP TABLE chunks_fts");
    old.run("DROP TABLE name_keys");
    old.run("UPDATE index_metadata SET value = '12' WHERE key = 'schema_version'");
    old.close();

    const reader = openDatabase(path, { readonly: true });
    try {
      const search = () => hybridSearch(reader, { query: "Ithaca", mode: "fts", chunks: true, rerank: "none" });
      let before!: Awaited<ReturnType<typeof search>>;
      const beforeSql = await compiled(reader, async () => (before = await search()));
      expect(before.results.length).toBeGreaterThan(0);
      expect(before.results.every((r) => r.chunks?.length === 0)).toBe(true);
      expect(beforeSql.some((sql) => sql.includes("FROM name_keys"))).toBe(false);

      // Another connection opens the file writable and migrates it.
      openDatabase(path).close();

      let after!: Awaited<ReturnType<typeof search>>;
      const afterSql = await compiled(reader, async () => (after = await search()));
      // The chunk table is read: the result carries its matching sections.
      expect(after.results.some((r) => (r.chunks?.length ?? 0) > 0)).toBe(true);
      // The exact-name lookup goes through the new table.
      expect(afterSql.some((sql) => sql.includes("FROM name_keys"))).toBe(true);
    } finally {
      reader.close();
    }
  }, 120_000);
});
