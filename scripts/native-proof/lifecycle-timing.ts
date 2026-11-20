import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

/** Project the persisted raw record for --observation-timing, without joining clock origins. */
export function lifecycleTimingSample(record: ActivityTurnLifecycle | undefined) {
  if (!record) return null;
  const span = (start: number | null, end: number | null): number | null => {
    const terminal = end ?? record.failureObservedAt ?? record.endedAt;
    return start === null || terminal === null ? null : Math.max(0, terminal - start);
  };
  const steps: Record<string, number | null> = {};
  const observed = (record.subPhases ?? []).map(step => {
    const elapsedMs = step.timeBase === "worker" ? step.workerElapsedMs ?? null
      : span(step.startedAt, step.endedAt ?? (step.phase === "backend" ? record.firstRelayRequestAt ?? null : null));
    const key = `${step.phase}.${step.name}`;
    steps[key] = elapsedMs === null ? steps[key] ?? null : (steps[key] ?? 0) + elapsedMs;
    return { ...step, elapsedMs };
  });
  return { turnId: record.turnId, queueWaitMs: span(record.acceptedAt, record.dequeuedAt),
    governedAdmissionMs: span(record.governedStartedAt, record.governedAcquiredAt),
    budgetAdmissionMs: span(record.budgetStartedAt, record.budgetAdmittedAt), journalBeginMs: span(record.journalStartedAt, record.journalBeganAt),
    backendStartupMs: span(record.backendInvokedAt, record.firstFrameAt), timeToFirstFrameMs: span(record.acceptedAt, record.firstFrameAt),
    // An absent first request must not turn into a claimed receipt at failure/turn end.
    invocationToRelayMs: record.backendInvokedAt === null || record.firstRelayRequestAt == null ? null : Math.max(0, record.firstRelayRequestAt - record.backendInvokedAt),
    backendSteps: observed.filter(step => step.phase === "backend"), backendMissingEvidence: record.backendMissingEvidence ?? null, steps };
}
