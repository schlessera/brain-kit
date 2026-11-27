/**
 * A `--force --embeddings` rebuild carries its markdown vectors through a temp
 * table, not the JS heap (#4783): the carry never reads every stored vector in
 * one result set, and the table is gone once the run ends, whether or not the
 * provider failed. Which vectors are reused is pinned by "--force with the
 * same provider reuses every unchanged vector" in indexer.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { indexAll } from "../src/lib/indexer";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import type { Enrichment } from "../src/lib/enrichment";
import type { EmbeddingProvider } from "../src/lib/seams";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { loadVec, vecAvailable } from "./vec-fixture";

const DIM = 16;
const taxonomy = buildTaxonomy({ user: null });

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** Three sections, each big enough to be a chunk of its own. */
function airships(last = "dirigible"): string {
  const sections = ["zeppelin", "blimp", last].flatMap((word) => [`## About ${word}`, "", `${word} `.repeat(120).trim(), ""]);
  return ["---", "type: note", "title: Airships", 'created: "2026-01-01"', 'updated: "2026-01-02"', "---", "", ...sections].join("\n");
}

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-carry-test-"));
  fixtures.push(root);
  const file = join(root, "notes/airships.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, airships());
  return root;
}

function provider(opts: { fail?: boolean; embedded?: string[] } = {}): EmbeddingProvider {
  return {
    id: "fake:v1",
    dimensions: DIM,
    async embed(texts) {
      opts.embedded?.push(...texts);
      if (opts.fail) throw new Error("fake embed failure");
      return texts.map((t, i) => new Float32Array(DIM).fill((t.length + i) % 7));
    },
    async embedQuery() {
      return new Float32Array(DIM).fill(1);
    },
  };
}

const enrichment: Enrichment = {
  async describeAsset() {
    return "A fixture asset.";
  },
  async generateChunkContext(_title, _text, heading) {
    return `Context for ${heading}`;
  },
};

async function open(root: string): Promise<Database> {
  const db = openDatabase(join(root, ".brain-index", "brain.db"), { embeddingDimensions: DIM });
  await loadVec(db);
  await migrateVecSchema(db, DIM);
  return db;
}

async function embed(db: Database, root: string, opts: { force?: boolean; provider?: EmbeddingProvider } = {}) {
  return indexAll(db, { root, taxonomy, quiet: true, embeddings: true, force: opts.force, provider: opts.provider ?? provider(), enrichment });
}

/** The temp tables on `db`'s connection. */
function tempTables(db: Database): string[] {
  return (db.query("SELECT name FROM temp.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

/**
 * Run `fn` with every statement `db` compiles wrapped, recording the text of
 * each one whose rows are read all at once with `.all()`.
 */
async function allReads<T>(db: Database, fn: () => Promise<T>): Promise<{ result: T; texts: string[] }> {
  const texts: string[] = [];
  const wrap = <S extends object>(statement: S, sql: string): S =>
    new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key === "all") {
          return (...args: unknown[]) => {
            texts.push(sql);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  const prepare = db.prepare;
  const query = db.query;
  db.prepare = ((sql: string, ...rest: unknown[]) =>
    wrap((prepare as (...a: unknown[]) => object).call(db, sql, ...rest), sql)) as typeof db.prepare;
  db.query = ((sql: string) => wrap(query.call(db, sql), sql)) as typeof db.query;
  try {
    return { result: await fn(), texts };
  } finally {
    db.prepare = prepare;
    db.query = query;
  }
}

describe("a --force rebuild carries its vectors through a temp table", () => {
  test.if(vecAvailable)("no statement reads the embedding of every markdown chunk in one result set", async () => {
    const root = corpus();
    const db = await open(root);
    try {
      await embed(db, root);
      const embedded: string[] = [];
      const { result: stats, texts } = await allReads(db, () => embed(db, root, { force: true, provider: provider({ embedded }) }));
      // Every vector came back from the carry, so the carry really ran.
      expect(embedded).toEqual([]);
      expect(stats.embeddings).toBe(3);
      expect(texts.filter((sql) => /\bembedding\b/.test(sql) && /\bvec_chunks\b/.test(sql))).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.if(vecAvailable)("the carry table is gone after a run that completes", async () => {
    const root = corpus();
    const db = await open(root);
    try {
      await embed(db, root);
      const stats = await embed(db, root, { force: true });
      expect(stats.embeddings).toBe(3);
      expect(tempTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.if(vecAvailable)("the carry table is gone after a run whose provider throws", async () => {
    const root = corpus();
    const db = await open(root);
    try {
      await embed(db, root);
      // One section changed, so the provider is asked for it and fails.
      writeFileSync(join(root, "notes/airships.md"), airships("balloon"));
      const embedded: string[] = [];
      const stats = await embed(db, root, { force: true, provider: provider({ fail: true, embedded }) });
      expect(embedded.length).toBe(1);
      expect(stats.embeddings).toBe(2); // the two unchanged sections, from the carry
      expect(tempTables(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.if(!vecAvailable)("skipped — sqlite-vec unavailable in this environment", () => {});
});
