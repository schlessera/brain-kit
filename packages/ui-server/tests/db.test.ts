import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";

const TEST_DB = `/tmp/brain-ui-test-${process.pid}.db`;

describe("database migrations", () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Apply migration manually (same as 001_initial.sql)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        total_cost_usd REAL DEFAULT 0,
        num_turns INTEGER DEFAULT 0
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        error_message TEXT,
        duration_ms INTEGER
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_name, started_at DESC)"
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      )
    `);
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

  test("cron_runs index works for job lookup", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'success')"
      ).run("sync", base + i * 1000);
    }

    const latest = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'sync' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;
    expect(latest.started_at).toBe(base + 4000);
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
