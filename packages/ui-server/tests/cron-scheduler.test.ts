import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";

// The raw-SQL tests below predate the factory and assert the row shapes
// directly; recordCronRun is the exported writer of those same rows.
import { recordCronRun } from "../src/cron/scheduler";

const TEST_DB = `/tmp/brain-ui-cron-test-${process.pid}.db`;

describe("cron scheduler logic", () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE cron_runs (
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
      "CREATE INDEX idx_cron_runs_job ON cron_runs(job_name, started_at DESC)"
    );
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
    }
  });

  test("records a successful job run", () => {
    const startedAt = Date.now();
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'running')"
    ).run("sync", startedAt);

    const durationMs = 1500;
    db.prepare(
      "UPDATE cron_runs SET status = 'success', finished_at = ?, duration_ms = ? WHERE job_name = ? AND started_at = ?"
    ).run(startedAt + durationMs, durationMs, "sync", startedAt);

    const row = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'sync' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;

    expect(row.status).toBe("success");
    expect(row.duration_ms).toBe(1500);
    expect(row.finished_at).toBe(startedAt + 1500);
    expect(row.error_message).toBeNull();
  });

  test("records a failed job run with error message", () => {
    const startedAt = Date.now();
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'running')"
    ).run("validate", startedAt);

    db.prepare(
      "UPDATE cron_runs SET status = 'error', finished_at = ?, duration_ms = ?, error_message = ? WHERE job_name = ? AND started_at = ?"
    ).run(startedAt + 500, 500, "Connection refused", "validate", startedAt);

    const row = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'validate' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;

    expect(row.status).toBe("error");
    expect(row.error_message).toBe("Connection refused");
  });

  test("getCronStatus pattern returns latest run per job", () => {
    // Insert multiple runs for the same job
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO cron_runs (job_name, started_at, finished_at, status, duration_ms) VALUES (?, ?, ?, 'success', ?)"
      ).run("sync", 1000 + i * 100, 1000 + i * 100 + 50, 50);
    }

    const lastRun = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1"
      )
      .get("sync") as any;

    expect(lastRun.started_at).toBe(1400);
  });

  test("handles multiple job types independently", () => {
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'success')"
    ).run("sync", 1000);
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'error')"
    ).run("validate", 2000);

    const syncRun = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'sync' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;
    const validateRun = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'validate' ORDER BY started_at DESC LIMIT 1"
      )
      .get() as any;

    expect(syncRun.status).toBe("success");
    expect(validateRun.status).toBe("error");
  });

  test("no runs returns null from query", () => {
    const row = db
      .query(
        "SELECT * FROM cron_runs WHERE job_name = 'nonexistent' ORDER BY started_at DESC LIMIT 1"
      )
      .get();

    expect(row).toBeNull();
  });
});

describe("recordCronRun (external scheduler seam)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
        error_message TEXT,
        duration_ms INTEGER
      )
    `);
  });

  afterEach(() => db.close());

  const lastRun = (job: string) =>
    db
      .query("SELECT * FROM cron_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1")
      .get(job) as any;

  test("a run is visible as 'running' between start and finish", () => {
    const record = recordCronRun(db, "sync");

    const row = lastRun("sync");
    expect(row.status).toBe("running");
    expect(row.finished_at).toBeNull();

    record.finish();
    expect(lastRun("sync").status).toBe("success");
  });

  test("finishing without an error writes the success shape runJob writes", () => {
    recordCronRun(db, "sync").finish();

    const row = lastRun("sync");
    expect(row.status).toBe("success");
    expect(row.finished_at).toBeGreaterThanOrEqual(row.started_at);
    expect(row.duration_ms).toBe(row.finished_at - row.started_at);
    expect(row.error_message).toBeNull();
  });

  test("finishing with an error writes the error shape", () => {
    recordCronRun(db, "validate").finish("brain validate exited 1");

    const row = lastRun("validate");
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("brain validate exited 1");
    expect(row.duration_ms).toBeNumber();
  });

  test("concurrent runs of different jobs do not cross-write", () => {
    const sync = recordCronRun(db, "sync");
    const validate = recordCronRun(db, "validate");

    validate.finish("boom");
    sync.finish();

    expect(lastRun("sync").status).toBe("success");
    expect(lastRun("validate").error_message).toBe("boom");
  });
});
