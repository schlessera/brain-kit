import type { Database } from "bun:sqlite";

import type { ActivityStore } from "../activity/store.js";
import { resolveSystemPrincipal } from "../db/principals.js";

/** A cron run's root span in the activity store. */
export interface CronSpan {
  runId: string;
  rootSpanId: string;
}

/**
 * Open the root span of one run of `name`, attributed to the scheduled-jobs
 * principal. The one shape both scheduling paths write — the container cron
 * wrapper (`run-job.ts`) and the in-process scheduler — so a status read
 * finds a run the same way whichever path ran it.
 */
export function startCronSpan(db: Database, store: ActivityStore, name: string): CronSpan {
  const principal = resolveSystemPrincipal(db, {
    identity: "scheduled-jobs",
    label: "Scheduled jobs",
  });
  const runId = `cron-${name}-${Date.now()}`;
  const rootSpanId = `${runId}:root`;
  store.startSpan({
    spanId: rootSpanId,
    runId,
    name: `cron ${name}`,
    kind: "cron",
    origin: "cron",
    jobName: name,
    principalId: principal.id,
  });
  return { runId, rootSpanId };
}
