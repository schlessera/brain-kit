import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { BrainClient } from "../brain/client.js";

// Scheduling is owned by the container crontab (config/crontab) — sync at
// 02:00, validate at 03:00, job scrape at 04:00. This module only provides
// manual triggers (triggerJob) and run history for the /api/status endpoint.
// Runs started by the crontab report themselves via recordCronRun below;
// their stdout/stderr still goes to syslog.

export interface CronScheduler {
  getCronStatus(): Array<{
    name: string;
    lastRunAt: number | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }>;
  triggerJob(name: string): Promise<boolean>;
}

interface CronJob {
  name: string;
  handler: () => Promise<void>;
}

/** One in-flight job run being recorded into `cron_runs`. */
export interface CronRunRecord {
  /** Mark the run finished: success without an argument, error with one. */
  finish(error?: string): void;
}

/**
 * Record a job run in the `cron_runs` history that `/api/status` serves
 * (`cronJobs`, via {@link CronScheduler.getCronStatus}).
 *
 * The scheduler in this module only writes the table for its own manual
 * triggers; in the shipped deployment the jobs are executed by the container
 * crontab, whose runs were invisible to `/api/status`. An external scheduler's
 * wrapper calls this before the job and `finish()` after, writing exactly the
 * rows the in-process runner writes. A run whose process died before
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

export function createCronScheduler(deps: {
  db: Database;
  brain: BrainClient;
  /** Where run outcomes are reported; absent means silence. */
  log?: Logger;
}): CronScheduler {
  const { db, brain, log } = deps;

  const jobs: CronJob[] = [
    {
      name: "sync",
      handler: async () => {
        await brain.sync();
        await brain.index();
      },
    },
    {
      name: "validate",
      handler: async () => {
        await brain.validate();
      },
    },
  ];

  async function runJob(job: CronJob) {
    const startedAt = Date.now();
    // Same recorder the external-scheduler path uses, so the two can never
    // drift in what a cron_runs row looks like.
    const record = recordCronRun(db, job.name);

    try {
      await job.handler();
      record.finish();
      log?.emit({
        severityText: "INFO",
        body: "job completed",
        attributes: { job: job.name, "duration.ms": Date.now() - startedAt },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.finish(message);
      log?.emit({
        severityText: "ERROR",
        body: "job failed",
        attributes: { job: job.name, error: message },
      });
    }
  }

  return {
    getCronStatus() {
      // Every job name that ever recorded a run, not just the two in-process
      // triggers: module jobs and the maintain/digest crontab entries land in
      // cron_runs through the same recorder and were previously invisible
      // here (the "cron-status name gap"). The in-process names are unioned
      // in so a fresh deployment still lists them before their first run.
      // One window query yields each job's latest run.
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
        ...new Set([...jobs.map((j) => j.name), ...lastRuns.map((r) => r.job_name)]),
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

    async triggerJob(name: string): Promise<boolean> {
      const job = jobs.find((j) => j.name === name);
      if (!job) return false;
      // Run async (don't await - let it run in background)
      runJob(job);
      return true;
    },
  };
}
