import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

// Drive the real writer and status reader; fixture SQL only seeds history.
import { recordCronRun, createCronScheduler } from "../src/cron/scheduler";

describe("cron scheduler logic", () => {
  let db: Database;

  // The shipped schema, not a hand-copied table, in memory: nothing on disk to collide or leak.
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
  });

  afterEach(() => db.close());

  test("getCronStatus returns latest run per job", () => {
    // Insert multiple runs for the same job
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO cron_runs (job_name, started_at, finished_at, status, duration_ms) VALUES (?, ?, ?, 'success', ?)"
      ).run("sync", 1000 + i * 100, 1000 + i * 100 + 50, 50);
    }

    const status = createCronScheduler({ db }).getCronStatus();
    expect(status.find((job) => job.name === "sync")!.lastRunAt).toBe(1400);
  });

  test("handles multiple job types independently", () => {
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'success')"
    ).run("sync", 1000);
    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'error')"
    ).run("validate", 2000);

    const status = createCronScheduler({ db }).getCronStatus();
    expect(status.find((job) => job.name === "sync")!.lastStatus).toBe("success");
    expect(status.find((job) => job.name === "validate")!.lastStatus).toBe("error");
  });

  // The whole status listing, pinned for an empty history and for one holding
  // the base jobs and a module job (#4681): the reader is unchanged by the
  // removal of the in-process runner.
  test("the status listing is exactly the base jobs, then every recorded job by name", () => {
    const never = { lastRunAt: null, lastStatus: null, lastDurationMs: null, lastError: null };
    expect(createCronScheduler({ db }).getCronStatus()).toEqual([
      { name: "sync", ...never },
      { name: "validate", ...never },
    ]);
    const seed = db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, finished_at, status, duration_ms, error_message) VALUES (?, ?, ?, ?, ?, ?)"
    );
    seed.run("sync", 1000, 1040, "success", 40, null);
    seed.run("sync", 2000, 2050, "error", 50, "brain sync failed (exit 2): the loom is tangled");
    seed.run("validate", 1500, 1520, "success", 20, null);
    seed.run("jobs-scrape", 1800, null, "running", null, null);
    expect(createCronScheduler({ db }).getCronStatus()).toEqual([
      { name: "sync", lastRunAt: 2000, lastStatus: "error", lastDurationMs: 50, lastError: "brain sync failed (exit 2): the loom is tangled" },
      { name: "validate", lastRunAt: 1500, lastStatus: "success", lastDurationMs: 20, lastError: null },
      { name: "jobs-scrape", lastRunAt: 1800, lastStatus: "running", lastDurationMs: null, lastError: null },
    ]);
  });

  test("no runs returns a null lastRunAt", () => {
    const status = createCronScheduler({ db }).getCronStatus();
    expect(status.find((job) => job.name === "sync")!.lastRunAt).toBeNull();
  });
});

describe("recordCronRun (external scheduler seam)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(readFileSync(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
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
    const startedAt = 1_000;
    const clock = spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      const record = recordCronRun(db, "sync");
      clock.mockReturnValue(startedAt + 1500);
      record.finish();
    } finally { clock.mockRestore(); }

    const row = lastRun("sync");
    expect(row.status).toBe("success");
    expect(row.started_at).toBe(startedAt);
    expect(row.finished_at).toBe(startedAt + 1500);
    expect(row.duration_ms).toBe(1500);
    expect(row.duration_ms).toBe(row.finished_at - row.started_at);
    expect(row.error_message).toBeNull();
  });

  test("finishing with an error writes the error shape", () => {
    const clock = spyOn(Date, "now").mockReturnValue(2_000);
    try {
      const record = recordCronRun(db, "validate");
      clock.mockReturnValue(2_750);
      record.finish("brain validate exited 1");
    } finally { clock.mockRestore(); }

    const row = lastRun("validate");
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("brain validate exited 1");
    expect(row.duration_ms).toBe(750);
    expect(row.finished_at).toBe(2_750);
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
