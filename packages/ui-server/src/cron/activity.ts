import type { Database } from "bun:sqlite";

import type { AwaitableActivityStore } from "../activity/store.js";
import { observeWrite } from "../activity/store-writes.js";
import { resolveSystemPrincipal } from "../db/principals.js";

/** A cron run's root span in the activity store. */
interface CronSpan {
  runId: string;
  rootSpanId: string;
}

/**
 * Open the root span of one run of `name`, attributed to the scheduled-jobs
 * principal. The one shape every scheduled run writes, so a status read finds
 * each the same way: in the container cron process, a job the crontab wrapper
 * (`run-job.ts`) runs and module discovery; in the server process, the turn
 * journal's idle `journal-scrub` (`turn-journal.ts`).
 */
export function startCronSpan(db: Database, store: AwaitableActivityStore, name: string, failed: (error: unknown) => void = () => {}): CronSpan {
  const principal = resolveSystemPrincipal(db, {
    identity: "scheduled-jobs",
    label: "Scheduled jobs",
  });
  const runId = `cron-${name}-${Date.now()}`;
  const rootSpanId = `${runId}:root`;
  // A store that commits off the event loop reports a failed write to `failed`.
  observeWrite(store.startSpan({
    spanId: rootSpanId,
    runId,
    name: `cron ${name}`,
    kind: "cron",
    origin: "cron",
    jobName: name,
    principalId: principal.id,
  }), failed);
  return { runId, rootSpanId };
}
