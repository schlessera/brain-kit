/**
 * documents.indexed_at is indexed (#4787).
 *
 * `indexed_at` is stored behind the body, so `SELECT MAX(indexed_at)`, which
 * every supported query takes before it reads (`withSnapshot`) and the graph's
 * staleness check repeats, walked every body's overflow pages. These tests pin
 * the plan SQLite picks with the index, pin the embedding pager's plan so that
 * a later index on `asset_type` cannot silently turn it into a walk of
 * `documents`, and check the upgrade path in both directions: a writable open
 * adds the index, a read-only reader keeps serving the previous version.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { migrateVecSchema, openDatabase, SCHEMA_VERSION } from "../src/lib/db.js";
import { listIndexDocuments, readGraphMeta } from "../src/queries/index.js";
import { cleanup, makeTempBrain, runCli } from "./cli-harness.js";

/** The last schema without the index. Fixed, not SCHEMA_VERSION - 1: a later bump must not move it. */
const PRE_INDEX_VERSION = 15;

const NEWEST = "SELECT MAX(indexed_at) AS newest FROM documents";
const NEWEST_UNARCHIVED = "SELECT MAX(d.indexed_at) FROM documents d WHERE d.status != 'archived'";

/**
 * `chunksNeedingVectors` in src/lib/indexer/embeddings.ts, with the eligibility
 * fragment filled in for a taxonomy that excludes one type.
 */
const PAGER_HEAD = `SELECT c.id, c.document_id, c.heading, c.content, c.context, d.title, d.summary
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.asset_type = 'markdown' AND c.id > ? AND c.id <= ?
       AND (`;
const PAGER_TAIL = `)
       AND NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.chunk_id = c.id)
     ORDER BY c.id LIMIT ?`;
const PAGER = `${PAGER_HEAD}d.type NOT IN (?)${PAGER_TAIL}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-documents-index-"));
  dirs.push(dir);
  return join(dir, ".brain-index", "brain.db");
}

function seed(db: Database, docs: number): void {
  const insert = db.prepare(
    "INSERT INTO documents (path, title, type, status, created, updated, content, indexed_at, asset_type) VALUES (?, ?, 'note', ?, '2026-01-01', '2026-01-01', ?, ?, 'markdown')"
  );
  db.transaction(() => {
    for (let i = 0; i < docs; i++) {
      insert.run(`n${i}.md`, `N${i}`, i % 5 === 0 ? "archived" : "active", "x".repeat(4096), `2026-07-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`);
    }
  })();
}

function plan(db: Database, sql: string, ...params: (string | number)[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail);
}

function documentIndexes(db: Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents' AND sql IS NOT NULL")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function storedVersion(db: Database): number {
  const row = db.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as { value: string };
  return Number.parseInt(row.value, 10);
}

/** Turn a current database into one as the previous schema left it. */
function downgradeToPreIndex(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.run("DROP INDEX IF EXISTS idx_documents_indexed_at");
  raw.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(PRE_INDEX_VERSION)]);
  raw.close();
}

describe("documents.indexed_at index", () => {
  test("the statements under test are still the ones core runs", () => {
    // A stale copy would keep the plan tests green while the real query moved.
    const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");
    expect(src("queries/snapshot.ts")).toContain(`"${NEWEST}"`);
    expect(src("queries/graph.ts")).toContain(`"${NEWEST}"`);
    const pager = src("lib/indexer/embeddings.ts");
    expect(pager).toContain(PAGER_HEAD);
    expect(pager).toContain(PAGER_TAIL);
  });

  test("the newest index run is read from idx_documents_indexed_at, not by a scan of documents", () => {
    const db = openDatabase(tempDbPath());
    try {
      seed(db, 200);
      const newest = plan(db, NEWEST);
      expect(newest, newest.join("\n")).toEqual(["SEARCH documents USING COVERING INDEX idx_documents_indexed_at"]);
      // With a status filter SQLite still walks the index from its newest end;
      // it visits a row only to test `status`, and stops at the first match.
      const unarchived = plan(db, NEWEST_UNARCHIVED);
      expect(unarchived.filter((d) => /^SCAN\b/.test(d)), unarchived.join("\n")).toEqual([]);
      expect(unarchived, unarchived.join("\n")).toEqual(["SEARCH d USING INDEX idx_documents_indexed_at"]);
      expect(db.prepare(NEWEST).get()).toEqual({ newest: "2026-07-28T00:00:00Z" });
    } finally {
      db.close();
    }
  });

  test("the embedding pager still pages by chunk row id, not by a walk of every markdown document", async () => {
    const db = openDatabase(tempDbPath());
    try {
      expect(await migrateVecSchema(db, 8)).toBe(true);
      seed(db, 50);
      const detail = plan(db, PAGER, 0, 100, "excluded", 10);
      expect(detail[0], detail.join("\n")).toBe("SEARCH c USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
      expect(detail.filter((d) => /TEMP B-TREE/.test(d)), detail.join("\n")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test(`a v${PRE_INDEX_VERSION} database gains the index on its next writable open, with its rows intact`, () => {
    const dbPath = tempDbPath();
    const first = openDatabase(dbPath);
    seed(first, 50);
    first.close();
    downgradeToPreIndex(dbPath);

    const before = new Database(dbPath, { readonly: true });
    expect(documentIndexes(before)).not.toContain("idx_documents_indexed_at");
    expect(storedVersion(before)).toBe(PRE_INDEX_VERSION);
    const rowsBefore = before.prepare("SELECT * FROM documents ORDER BY id").all();
    before.close();

    openDatabase(dbPath).close();

    const after = new Database(dbPath, { readonly: true });
    try {
      expect(documentIndexes(after)).toContain("idx_documents_indexed_at");
      expect(storedVersion(after)).toBe(SCHEMA_VERSION);
      expect(after.prepare("SELECT * FROM documents ORDER BY id").all()).toEqual(rowsBefore);
      expect(plan(after, NEWEST)).toEqual(["SEARCH documents USING COVERING INDEX idx_documents_indexed_at"]);
    } finally {
      after.close();
    }
  });

  test(`a v${PRE_INDEX_VERSION} index is still served read-only, with the same results and nothing migrated`, async () => {
    const root = makeTempBrain();
    dirs.push(root);
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    const opts = { brainPath: root };
    const list = listIndexDocuments({ ...opts, limit: 100 });
    const meta = readGraphMeta(opts);
    expect(list.ok && meta.ok).toBe(true);
    if (!list.ok || !meta.ok) return;
    expect(list.value.length).toBeGreaterThan(0);
    expect(list.snapshot.schemaVersion).toBe(SCHEMA_VERSION);

    const dbPath = join(root, ".brain-index", "brain.db");
    downgradeToPreIndex(dbPath);

    const oldList = listIndexDocuments({ ...opts, limit: 100 });
    const oldMeta = readGraphMeta(opts);
    expect(oldList).toEqual({ ...list, snapshot: { ...list.snapshot, schemaVersion: PRE_INDEX_VERSION } });
    // Graph meta reports the version it read; everything else is unchanged.
    expect(oldMeta).toEqual({
      ...meta,
      value: { ...meta.value, schemaVersion: PRE_INDEX_VERSION },
      snapshot: { ...meta.snapshot, schemaVersion: PRE_INDEX_VERSION },
    });

    // A reader never migrates: the file is still at the previous version.
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(documentIndexes(raw)).not.toContain("idx_documents_indexed_at");
      expect(storedVersion(raw)).toBe(PRE_INDEX_VERSION);
    } finally {
      raw.close();
    }
  });

  test("brain doctor stops reporting an older schema once the upgraded database has been opened writable", async () => {
    const root = makeTempBrain();
    dirs.push(root);
    // Satisfy the MCP check via project config so doctor never falls through to
    // probing a host `claude` CLI (up to 15s per run, and machine-dependent).
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
    );
    const indexed = await runCli(root, ["index", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    const dbPath = join(root, ".brain-index", "brain.db");
    downgradeToPreIndex(dbPath);

    const dbCheck = async () => {
      const result = await runCli(root, ["doctor", "--json"]);
      // A warning is not a failure: doctor exits 0 in both states here.
      expect(result.code, result.stderr).toBe(0);
      const checks = JSON.parse(result.stdout).checks as { id: string; status: string; detail: string }[];
      return checks.find((c) => c.id === "db")!;
    };

    // Precondition: doctor does notice an old schema, so the assertion below
    // is not passing because the check is blind.
    const stale = await dbCheck();
    expect(stale.detail).toContain(`schema_version ${PRE_INDEX_VERSION} <`);

    openDatabase(dbPath).close();

    const upgraded = await dbCheck();
    expect(upgraded.detail).not.toContain("schema_version");
    expect(upgraded.status).toBe("pass");
  });
});
