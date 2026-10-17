import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { formatDuration } from "../../lib/duration.js";

export function turnTimingText(lifecycle?: ActivityTurnLifecycle): string {
  if (!lifecycle) return "Total turn: unknown · First frame: unknown";
  const time = (value: number | null) => value === null ? "unavailable" : formatDuration(value);
  return `Total turn: ${time(lifecycle.totalElapsedMs)} · First frame: ${time(lifecycle.timeToFirstFrameMs)}`;
}

export function TurnTiming({ lifecycle }: { lifecycle?: ActivityTurnLifecycle }) {
  const phase = (start: number | null, end: number | null, elapsed: number | null, skipped = false) =>
    skipped ? "skipped (not configured)" : start === null ? "not reached" : end === null ? `${elapsed === null ? "pending" : formatDuration(elapsed)} (incomplete)` : formatDuration(elapsed!);
  return <div className="space-y-1 py-2 text-xs text-muted-foreground" data-turn-timing="">
    <p>{turnTimingText(lifecycle)}</p>
    {lifecycle && <>
      <p>Turn: {lifecycle.outcome ?? "in progress"}{lifecycle.reason ? ` · ${lifecycle.reason}` : ""}</p>
      <p>Queue wait: {lifecycle.queueWaitMs === null ? "unavailable" : formatDuration(lifecycle.queueWaitMs)}</p>
      <p>Governed admission: {phase(lifecycle.governedStartedAt, lifecycle.governedAcquiredAt, lifecycle.governedAdmissionMs,lifecycle.skippedPhases.includes("governed"))}</p>
      <p>Budget admission: {phase(lifecycle.budgetStartedAt, lifecycle.budgetAdmittedAt, lifecycle.budgetAdmissionMs,lifecycle.skippedPhases.includes("budget"))}</p>
      <p>Journal begin: {phase(lifecycle.journalStartedAt, lifecycle.journalBeganAt, lifecycle.journalBeginMs,lifecycle.skippedPhases.includes("journal"))}</p>
      <p>Backend startup: {phase(lifecycle.backendInvokedAt, lifecycle.firstFrameAt, lifecycle.backendStartupMs)}</p>
      {!lifecycle.backendRunId && <p>No backend run recorded.</p>}
    </>}
  </div>;
}
