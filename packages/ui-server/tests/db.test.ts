import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync, readFileSync } from "fs";

const TEST_DB = `/tmp/brain-ui-test-${process.pid}.db`;

describe("database migrations", () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Exercise the shipped initial schema instead of reconstructing it here.
    db.exec(readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    // Clean up WAL files too
    if (existsSync(TEST_DB + "-shm")) unlinkSync(TEST_DB + "-shm");
    if (existsSync(TEST_DB + "-wal")) unlinkSync(TEST_DB + "-wal");
  });

  test("sessions table exists and accepts inserts", () => {
    db.prepare(
      "INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)"
    ).run("s1", "Test Session", Date.now(), Date.now());

    const row = db.query("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(row).not.toBeNull();
    expect(row.title).toBe("Test Session");
    expect(row.total_cost_usd).toBe(0);
    expect(row.num_turns).toBe(0);
  });

  test("sessions table enforces primary key uniqueness", () => {
    db.prepare(
      "INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)"
    ).run("s1", "First", Date.now(), Date.now());

    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)"
        )
        .run("s1", "Duplicate", Date.now(), Date.now())
    ).toThrow();
  });

  test("cron_runs table tracks job execution", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'running')"
    ).run("sync", now);

    db.prepare(
      "UPDATE cron_runs SET status = 'success', finished_at = ?, duration_ms = ? WHERE job_name = ? AND started_at = ?"
    ).run(now + 5000, 5000, "sync", now);

    const row = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'sync' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;
    expect(row.status).toBe("success");
    expect(row.duration_ms).toBe(5000);
  });

  test("cron_runs enforces valid status values", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'invalid')"
        )
        .run("test", Date.now())
    ).toThrow();
  });

  test("cron_runs declares job_name ASC, started_at DESC lookup index keys", () => {
    const indexes = db.query("PRAGMA index_list('cron_runs')").all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain("idx_cron_runs_job");
    const columns = db.query("PRAGMA index_xinfo('idx_cron_runs_job')").all() as {
      name: string | null; desc: number; key: number;
    }[];
    // SQLite also reports an implicit rowid payload; only key entries define
    // the lookup order. index_info alone would miss the DESC requirement.
    expect(columns.filter((column) => column.key === 1).map(({ name, desc }) => ({ name, desc })))
      .toEqual([{ name: "job_name", desc: 0 }, { name: "started_at", desc: 1 }]);
  });

  test("_migrations table tracks applied migrations", () => {
    db.prepare(
      "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)"
    ).run("001_initial.sql", Date.now());

    const count = db
      .query("SELECT COUNT(*) as n FROM _migrations")
      .get() as any;
    expect(count.n).toBe(1);
  });

  test("_migrations enforces unique filenames", () => {
    db.prepare(
      "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)"
    ).run("001_initial.sql", Date.now());

    expect(() =>
      db
        .prepare(
          "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)"
        )
        .run("001_initial.sql", Date.now())
    ).toThrow();
  });
});
