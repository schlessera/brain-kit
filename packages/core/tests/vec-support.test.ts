/**
 * Unit coverage for the two halves `initVecSupport` was split into:
 * `loadVecSupport` (read, writes nothing) and `migrateVecSchema` (write,
 * destructive). The user-visible proof that a read path no longer destroys
 * vectors lives in vec-read-path.test.ts; this file pins the primitives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  getMeta,
  loadVecSupport,
  migrateVecSchema,
  openDatabase,
  setMeta,
  storedVectorWidth,
} from "../src/lib/db";

const DIM = 16;

let vecAvailable = false;
const probe = new Database(":memory:");
try {
  const { load } = await import("sqlite-vec");
  load(probe);
  vecAvailable = true;
} catch {
  // Same optional-extension policy as indexer.test.ts.
} finally {
  probe.close();
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A file-backed brain.db carrying one vector, with the WAL folded in. */
async function stage(pending: string[] = []): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "brain-vec-support-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "brain.db");

  const db = openDatabase(dbPath, { embeddingDimensions: DIM });
  expect(await migrateVecSchema(db, DIM)).toBe(true);
  db.run(
    "INSERT INTO documents(id,path,title,type,status,created,updated,content,indexed_at) VALUES (1,'notes/1.md','Doc','note','active','2026-01-01','2026-01-01','topic','2026-01-01')"
  );
  db.run("INSERT INTO chunks(id,document_id,chunk_index,heading,content,token_estimate) VALUES (1,1,0,'','topic',1)");
  db.run("INSERT INTO vec_chunks(chunk_id,embedding,is_archived,doc_type) VALUES (1,?,0,'note')", [
    new Uint8Array(new Float32Array(DIM).fill(0.25).buffer),
  ]);
  setMeta(db, "embedding_dimensions", String(DIM));
  for (const key of pending) db.run("DELETE FROM index_metadata WHERE key = ?", [key]);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return dbPath;
}

function count(db: Database): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;
  } catch {
    return -1;
  }
}

describe.skipIf(!vecAvailable)("loadVecSupport", () => {
  test("makes stored vectors readable without touching a pending migration", async () => {
    const dbPath = await stage(["vec_distance_metric"]);
    for (const db of [
      openDatabase(dbPath, { readonly: true }),
      openDatabase(dbPath, { embeddingDimensions: DIM }),
      // A configured width that differs from the stored one used to be enough
      // to recreate the table at the wrong width.
      openDatabase(dbPath, { embeddingDimensions: DIM * 2 }),
    ]) {
      expect(await loadVecSupport(db)).toEqual({ ok: true });
      expect(count(db)).toBe(1);
      expect(getMeta(db, "vec_distance_metric")).toBeNull();
      db.close();
    }
  });

  test("reports a brain that has never been embedded as no-vector-table", async () => {
    const dbPath = await stage();
    const writer = openDatabase(dbPath, { embeddingDimensions: DIM });
    await loadVecSupport(writer); // dropping a vec0 table needs the extension
    writer.run("DROP TABLE IF EXISTS vec_chunks");
    writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.close();

    const db = openDatabase(dbPath, { readonly: true });
    expect(await loadVecSupport(db)).toEqual({ ok: false, reason: "no-vector-table" });
    db.close();
  });
});

describe.skipIf(!vecAvailable)("migrateVecSchema", () => {
  test("brings a pre-cosine index up to cosine and v2-metadata", async () => {
    const dbPath = await stage(["vec_distance_metric", "vec_schema"]);
    const db = openDatabase(dbPath, { embeddingDimensions: DIM });

    expect(await migrateVecSchema(db, DIM)).toBe(true);

    expect(getMeta(db, "vec_distance_metric")).toBe("cosine");
    expect(getMeta(db, "vec_schema")).toBe("v2-metadata");
    db.close();
  });
});

describe("storedVectorWidth", () => {
  test("prefers the width the index was built at over the configured one", () => {
    const db = openDatabase(":memory:", { embeddingDimensions: DIM });
    expect(storedVectorWidth(db, 1536)).toBe(DIM);

    db.run("DELETE FROM index_metadata WHERE key = 'embedding_dimensions'");
    expect(storedVectorWidth(db, 1536)).toBe(1536);

    setMeta(db, "embedding_dimensions", "not a number");
    expect(storedVectorWidth(db, 1536)).toBe(1536);
    db.close();
  });
});
