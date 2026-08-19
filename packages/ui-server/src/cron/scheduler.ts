import type { Database } from "bun:sqlite";
import type { BrainClient } from "../brain/client.js";

// Scheduling is owned by the container crontab (config/crontab) — sync at
// 02:00, validate at 03:00, job scrape at 04:00. This module only provides
// manual triggers (triggerJob) and run history for the /api/status endpoint.
// Runs started by the crontab do not appear here; they log to syslog.

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

export function createCronScheduler(deps: {
  db: Database;
  brain: BrainClient;
}): CronScheduler {
  const { db, brain } = deps;

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

    db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, ?, 'running')"
    ).run(job.name, startedAt);

    try {
      await job.handler();
      const durationMs = Date.now() - startedAt;
      db.prepare(
        "UPDATE cron_runs SET status = 'success', finished_at = ?, duration_ms = ? WHERE job_name = ? AND started_at = ?"
      ).run(Date.now(), durationMs, job.name, startedAt);
      console.log(`[cron] ${job.name} completed in ${durationMs}ms`);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        "UPDATE cron_runs SET status = 'error', finished_at = ?, duration_ms = ?, error_message = ? WHERE job_name = ? AND started_at = ?"
      ).run(Date.now(), durationMs, message, job.name, startedAt);
      console.error(`[cron] ${job.name} failed: ${message}`);
    }
  }

  return {
    getCronStatus() {
      return jobs.map((job) => {
        const lastRun = db
          .query(
            "SELECT * FROM cron_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1"
          )
          .get(job.name) as any;

        return {
          name: job.name,
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
