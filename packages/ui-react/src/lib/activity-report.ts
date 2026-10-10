import { PROTOCOL_REV, isFailureOutcome, type ActivitySpan, type SystemStatus } from "@schlessera/brain-ui-sdk/protocol";

import type { ActivityRunRollup, ActivityRunSummary } from "./api-client.js";
import { formatDuration } from "./duration.js";
import { INCLUDED_TEXT_CAP, providerMessageInclusion, redactProviderMessage } from "./turn-failure.js";

/**
 * The Activity bug report's generated text (#598). Every line is an
 * allowlisted fact the app already holds; anything else — failure text, job
 * and run names, IDs, paths, payloads, events — is left out unless the reader
 * adds it by an explicit inclusion. Unknown facts are omitted or stated as
 * unknown, never inferred.
 */

/**
 * Built-in tool names safe to print; any other tool is `other tool`. Claude's
 * built-ins, and the file and shell tools the pi backend registers.
 */
export const BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Agent",
  "read_file", "write_file", "edit_file", "grep", "bash",
]);

/** The run fields a report reads: the history row's summary or the detail's rollup. */
export type ReportRun = Pick<ActivityRunSummary,
  "origin" | "outcome" | "durationMs" | "billingMode" | "failureReason" | "jobName"> & {
  detailPruned?: boolean;
};

/** What became of the run's own record when the report was drawn. */
export type ReportRecord =
  | { state: "retained"; spans: ActivitySpan[] }
  | { state: "pruned" }
  | { state: "not-found" }
  /** Being read: nothing is claimed about the record until it arrives. */
  | { state: "loading" }
  /** The read failed for a reason other than 404. */
  | { state: "unloaded"; offline: boolean };

export interface ReportContext {
  /** The ui-react release bundled in this client. */
  client: string | null;
  /** `/api/status`'s software identity, only when it was loaded and authorized. */
  server: SystemStatus["software"] | null;
}

/** Missing and development markers are not identities worth printing. */
function known(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !/^(dev|development|unknown)$/i.test(value.trim())
    ? value.trim() : null;
}

function originLine(origin: string): string {
  return origin === "cron" || origin === "session" || origin === "autonomous" ? origin : "other";
}

function failedSteps(spans: ActivitySpan[]): string | null {
  const failed = spans.filter(s => s.parentSpanId && isFailureOutcome(s.outcome));
  if (failed.length === 0) return null;
  return failed.map(s => (s.toolName && BUILT_IN_TOOLS.has(s.toolName) ? s.toolName : s.kind === "tool" ? "other tool" : s.kind)).join(", ");
}

/** The default report body: empty sections for the reader, then the facts. */
export function activityReportBody(run: ReportRun, record: ReportRecord, ctx: ReportContext): string {
  const facts = ["brain-kit activity failure", `protocol: ${PROTOCOL_REV}`];
  const client = known(ctx.client);
  if (client) facts.push(`client: ${client}`);
  const release = known(ctx.server?.release);
  const commit = known(ctx.server?.sourceCommit);
  if (release) facts.push(`server: ${release}`);
  if (commit) facts.push(`server commit: ${commit}`);
  facts.push(`origin: ${originLine(run.origin)}`);
  if (isFailureOutcome(run.outcome)) facts.push(`outcome: ${run.outcome}`);
  if (run.durationMs !== null && run.durationMs !== undefined) facts.push(`duration: ${formatDuration(run.durationMs)}`);
  const pruned = record.state === "pruned" || ((record.state === "unloaded" || record.state === "loading") && Boolean(run.detailPruned));
  if (pruned) facts.push("record: rollup only (detail pruned)");
  else if (record.state === "retained") facts.push(`record: retained · ${record.spans.length} ${record.spans.length === 1 ? "step" : "steps"}`);
  else if (record.state === "not-found") facts.push("record: not found");
  if (record.state === "retained") {
    const steps = failedSteps(record.spans);
    if (steps) facts.push(`failed steps: ${steps}`);
  } else if (record.state === "unloaded" && !pruned) {
    facts.push(record.offline ? "failed steps: not loaded (offline)" : "failed steps: not loaded");
  }
  if (run.billingMode === "subscription" || run.billingMode === "api") facts.push(`billing: ${run.billingMode}`);
  return [
    "## What were you doing?", "",
    "## Steps to reproduce", "1.", "",
    "## Expected", "",
    "## Actual", "",
    "---",
    ...facts,
  ].join("\n");
}

/** A title naming only allowlisted facts. */
export function activityReportTitle(run: Pick<ReportRun, "origin" | "outcome">): string {
  return `Activity run failed: ${originLine(run.origin)} · ${isFailureOutcome(run.outcome) ? run.outcome : "failure"}`;
}

/** The opt-in failure reason: the run's own, else the failed root span's. */
export function failureReasonInclusion(run: ReportRun, spans: ActivitySpan[] | null): string | null {
  const root = spans?.find(s => !s.parentSpanId);
  return providerMessageInclusion("Failure reason", run.failureReason ?? root?.outcomeReason ?? null);
}

/**
 * The opt-in job name, for cron runs that have one. A name is operator text,
 * so it gets the failure reason's best-effort redaction and visible cap.
 */
export function jobNameInclusion(run: ReportRun): string | null {
  if (run.origin !== "cron" || !run.jobName || !run.jobName.trim()) return null;
  const redacted = redactProviderMessage(run.jobName);
  const shown = redacted.slice(0, INCLUDED_TEXT_CAP);
  return `job: ${shown}${redacted.length > shown.length ? `\n[${redacted.length - shown.length} characters not included]` : ""}`;
}

/** A rollup as the report's run fields. */
export function rollupReportRun(rollup: ActivityRunRollup, detailPruned: boolean): ReportRun {
  return {
    origin: rollup.origin as ReportRun["origin"],
    outcome: rollup.outcome,
    durationMs: rollup.durationMs,
    billingMode: rollup.billingMode,
    failureReason: rollup.failureReason,
    jobName: rollup.jobName,
    detailPruned,
  };
}
