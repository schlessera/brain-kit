import type { Database } from "bun:sqlite";

// Scheduling is owned by the container crontab (config/crontab) — sync at
// 02:00, validate at 03:00, job scrape at 04:00. Its wrapper runs each job
// (cron/run-job.ts) and reports the run via recordCronRun below; this module
// only provides that recorder and the run history for the /api/status
// endpoint. The jobs' stdout/stderr still goes to syslog.

/** Listed by /api/status before their first run, so a fresh deployment shows them. */
const BASE_JOB_NAMES = ["sync", "validate"];

interface CronScheduler {
  getCronStatus(): Array<{
    name: string;
    lastRunAt: number | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }>;
}

/** One in-flight job run being recorded into `cron_runs`. */
interface CronRunRecord {
  /** Mark the run finished: success without an argument, error with one. */
  finish(error?: string): void;
}

/**
 * Record a job run in the `cron_runs` history that `/api/status` serves
 * (`cronJobs`, via {@link CronScheduler.getCronStatus}).
 *
 * The jobs are executed by the container crontab; its wrapper calls this
 * before the job and `finish()` after. A run whose process died before
 * `finish()` stays in status "running" — itself a signal.
 */
export function recordCronRun(db: Database, jobName: string): CronRunRecord {
  const startedAt = Date.now();
  db.prepare(
    "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'running')"
  ).run(jobName, startedAt);

  return {
    finish(error?: string) {
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      if (error === undefined) {
        db.prepare(
          "UPDATE cron_runs SET status = 'success', finished_at = ?, duration_ms = ? WHERE job_name = ? AND started_at = ?"
        ).run(finishedAt, durationMs, jobName, startedAt);
      } else {
        db.prepare(
          "UPDATE cron_runs SET status = 'error', finished_at = ?, duration_ms = ?, error_message = ? WHERE job_name = ? AND started_at = ?"
        ).run(finishedAt, durationMs, error, jobName, startedAt);
      }
    },
  };
}

export function createCronScheduler(deps: { db: Database }): CronScheduler {
  const { db } = deps;

  return {
    getCronStatus() {
      // Every job name that ever recorded a run: module jobs and the
      // maintain/digest crontab entries land in cron_runs through the same
      // recorder as sync and validate. Those two are unioned in so a fresh
      // deployment still lists them before their first run. One window query
      // yields each job's latest run.
      const lastRuns = db
        .query(
          `SELECT job_name, started_at, status, duration_ms, error_message FROM (
             SELECT *, ROW_NUMBER() OVER (
               PARTITION BY job_name ORDER BY started_at DESC
             ) AS rn FROM cron_runs
           ) WHERE rn = 1 ORDER BY job_name`
        )
        .all() as Array<{
        job_name: string;
        started_at: number;
        status: string;
        duration_ms: number | null;
        error_message: string | null;
      }>;
      const byName = new Map(lastRuns.map((r) => [r.job_name, r]));
      const names = [
        ...new Set([...BASE_JOB_NAMES, ...lastRuns.map((r) => r.job_name)]),
      ];
      return names.map((name) => {
        const lastRun = byName.get(name);
        return {
          name,
          lastRunAt: lastRun?.started_at ?? null,
          lastStatus: lastRun?.status ?? null,
          lastDurationMs: lastRun?.duration_ms ?? null,
          lastError: lastRun?.error_message ?? null,
        };
      });
    },
  };
}
