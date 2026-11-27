/** Opening jobs.db must not write, so WAL readers proceed while a writer holds the lock (#4809). */
import { afterEach, expect, test } from "bun:test";
import { tempDirs } from "../../../tests/helpers/temp";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { reviewJobs } from "../src/review-operation";
import { ingestJobs } from "../src/scrape";

const tempDir = tempDirs();

const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function seededRoot(): string {
  const root = tempDir("jobs-open-lock-");
  const db = openDatabase(join(root, "jobs.db"));
  try {
    ingestJobs(db, [
      { source: "remoteok", source_id: "ithaca-1", title: "Ithaca navigator", company: "Ithaca Fleet" },
      { source: "remotive", source_id: "ithaca-2", title: "Aeolus wind broker", company: "Aeolia Winds" },
    ], false);
    db.exec("UPDATE jobs SET relevance_score = 80, review_status = 'queued'");
  } finally { db.close(); }
  return root;
}

function holdWriteLock(path: string): Database {
  const writer = new Database(path, { readwrite: true });
  handles.push(writer);
  writer.exec("PRAGMA busy_timeout = 0");
  writer.exec("BEGIN IMMEDIATE");
  return writer;
}

test("reviewJobs reads the queue while another connection holds the write lock", () => {
  const root = seededRoot();
  holdWriteLock(join(root, "jobs.db"));
  const queue = reviewJobs(root, { dbPath: "jobs.db" }, { status: "queued" });
  expect(queue.map((job) => job.source_id).sort()).toEqual(["ithaca-1", "ithaca-2"]);
});

test("a fresh database holds exactly one metadata row, the schema version", () => {
  const db = openDatabase(":memory:");
  handles.push(db);
  expect(db.query("SELECT key FROM jobs_metadata ORDER BY key").all()).toEqual([{ key: "schema_version" }]);
});

test("an existing database keeps its previously seeded threshold rows untouched", () => {
  const root = tempDir("jobs-open-lock-");
  const path = join(root, "jobs.db");
  openDatabase(path).close();
  const legacy = new Database(path, { readwrite: true });
  legacy.exec("INSERT OR REPLACE INTO jobs_metadata (key, value) VALUES ('queue_threshold', '61'), ('dismiss_threshold', '34')");
  legacy.close();
  const before = new Database(path, { readonly: true });
  const rows = before.query("SELECT key, value FROM jobs_metadata ORDER BY key").all();
  before.close();

  const db = openDatabase(path, { create: false });
  handles.push(db);
  expect(db.query("SELECT key, value FROM jobs_metadata ORDER BY key").all()).toEqual(rows);
  expect(rows).toContainEqual({ key: "queue_threshold", value: "61" });
  expect(rows).toContainEqual({ key: "dismiss_threshold", value: "34" });
});
