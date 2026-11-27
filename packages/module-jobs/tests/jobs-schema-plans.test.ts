/** Schema v3: duplicate lookups plan through real indexes, the migration runs once, dedup marks atomically (#4810). */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { runDedup } from "../src/dedup";
import { searchJobs } from "../src/review";
import { ingestJobs } from "../src/scrape";
import type { RawJob } from "../src/types";

const dirs: string[] = [];
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobs-schema-"));
  dirs.push(dir);
  return join(dir, "jobs.db");
}

const DROPPED = ["idx_jobs_company_normalized", "idx_jobs_is_duplicate", "idx_jobs_published_at", "idx_jobs_title_normalized"];

/** The statements the module runs against `is_duplicate` and `duplicate_of`, as written in `src/`. */
const LOOKUPS: Record<string, [string, unknown[]]> = {
  "runDedup per-group read": [
    "SELECT id, source, first_seen_at FROM jobs WHERE fingerprint = ? AND is_duplicate = 0 ORDER BY first_seen_at ASC",
    ["fp"],
  ],
  releaseGroup: [
    "UPDATE jobs SET is_duplicate = 0, duplicate_of = NULL WHERE fingerprint = ? AND is_duplicate = 1 AND duplicate_of IS NOT NULL",
    ["fp"],
  ],
  releaseDependants: ["UPDATE jobs SET is_duplicate = 0, duplicate_of = NULL WHERE duplicate_of = ?", [1]],
  "deleteJob update": ["UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of = ?", [1]],
  getDuplicatesOf: ["SELECT * FROM jobs WHERE duplicate_of = ?", [1]],
};

function plan(db: Database, sql: string, params: unknown[]): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join("\n");
}

function indexNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

const sample: RawJob[] = [
  { source: "remoteok", source_id: "r1", title: "Senior Platform Engineer", company: "Ithaca Fleet", tags: ["sailing"] },
  { source: "remotive", source_id: "v1", title: "Senior Platform Engineer - Remote", company: "Ithaca Fleet Inc." },
  { source: "nodesk", source_id: "n1", title: "Wind Bag Custodian", company: "Aeolia Winds", description: "Keeps the winds tied." },
  { source: "remoteok", source_id: "r2", title: "Loom Weaver", company: "Ithaca Palace", description: "Weaves by day." },
];

test("duplicate lookups plan through an index and never through the boolean is_duplicate index", () => {
  const db = openDatabase(":memory:");
  handles.push(db);
  for (const [name, [sql, params]] of Object.entries(LOOKUPS)) {
    const detail = plan(db, sql, params);
    expect({ name, scan: detail.includes("SCAN jobs") }).toEqual({ name, scan: false });
    expect({ name, boolean: detail.includes("idx_jobs_is_duplicate") }).toEqual({ name, boolean: false });
  }
  expect(plan(db, ...LOOKUPS["runDedup per-group read"]!)).toContain("idx_jobs_fingerprint");
});

test("a version 2 database migrates to version 3 with its rows and search intact", () => {
  const path = tempPath();
  const seed = openDatabase(path);
  ingestJobs(seed, sample);
  runDedup(seed);
  // Return it to the version 2 index set, as main shipped it.
  seed.exec(`
    DROP INDEX idx_jobs_duplicate_of;
    CREATE INDEX idx_jobs_company_normalized ON jobs(company_normalized);
    CREATE INDEX idx_jobs_title_normalized ON jobs(title_normalized);
    CREATE INDEX idx_jobs_published_at ON jobs(published_at);
    CREATE INDEX idx_jobs_is_duplicate ON jobs(is_duplicate);
    UPDATE jobs_metadata SET value = '2' WHERE key = 'schema_version';
  `);
  const rowsBefore = seed.query("SELECT * FROM jobs ORDER BY id").all();
  const searchBefore = searchJobs(seed, "winds").map((job) => job.id);
  expect(rowsBefore.filter((row) => (row as { is_duplicate: number }).is_duplicate === 1)).toHaveLength(1);
  expect(searchBefore).toHaveLength(1);
  seed.close();

  const db = openDatabase(path, { create: false });
  handles.push(db);
  expect(db.query("SELECT value FROM jobs_metadata WHERE key = 'schema_version'").get()).toEqual({ value: "3" });
  const names = indexNames(db);
  for (const dropped of DROPPED) expect(names).not.toContain(dropped);
  expect(names).toContain("idx_jobs_duplicate_of");
  expect(db.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(rowsBefore);
  expect(searchJobs(db, "winds").map((job) => job.id)).toEqual(searchBefore);
});

test("an already-migrated database opens while another connection holds the write lock", () => {
  const path = tempPath();
  openDatabase(path).close();
  const writer = new Database(path, { readwrite: true });
  handles.push(writer);
  writer.exec("BEGIN IMMEDIATE");
  const db = openDatabase(path, { create: false });
  handles.push(db);
  expect(db.query("SELECT value FROM jobs_metadata WHERE key = 'schema_version'").get()).toEqual({ value: "3" });
});

test("runDedup marks nothing when one mark of the pass fails", () => {
  const db = openDatabase(":memory:");
  handles.push(db);
  const group: RawJob[] = ["remoteok", "remotive", "nodesk", "weworkremotely"].map((source, i) => ({
    source: source as RawJob["source"], source_id: `suitor-${i}`, title: "Suitor Wrangler", company: "Ithaca Palace",
  }));
  ingestJobs(db, group);
  const ids = (db.query("SELECT id FROM jobs ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
  expect(ids).toHaveLength(4);
  ids.forEach((id, i) => db.query("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(`2026-07-0${i + 1}T00:00:00Z`, id));
  // The canonical is the oldest row; the third mark is the fourth row.
  db.exec(`CREATE TRIGGER fail_third_mark BEFORE UPDATE OF is_duplicate ON jobs
    WHEN NEW.id = ${ids[3]} AND NEW.is_duplicate = 1 BEGIN SELECT RAISE(ABORT, 'third mark refused'); END`);

  expect(() => runDedup(db)).toThrow("third mark refused");
  expect(db.query("SELECT COUNT(*) AS c FROM jobs WHERE is_duplicate = 1").get()).toEqual({ c: 0 });
});
