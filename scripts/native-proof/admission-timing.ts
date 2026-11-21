import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

/** The original small-scenario projection. Additional clocks have a sibling artifact. */
export function admissionTimingSample(record: ActivityTurnLifecycle | undefined) {
  if (!record) return null;
  const span = (start: number | null, end: number | null) => start === null ? null : (end ?? record.failureObservedAt ?? record.endedAt) === null ? null
    : Math.max(0, (end ?? record.failureObservedAt ?? record.endedAt)! - start);
  const steps: Record<string, number | null> = {};
  for (const step of record.subPhases ?? []) {
    const key = `${step.phase}.${step.name}`, ms = span(step.startedAt, step.endedAt);
    steps[key] = ms === null ? steps[key] ?? null : (steps[key] ?? 0) + ms;
  }
  return { turnId: record.turnId, queueWaitMs: span(record.acceptedAt, record.dequeuedAt), governedAdmissionMs: span(record.governedStartedAt, record.governedAcquiredAt),
    budgetAdmissionMs: span(record.budgetStartedAt, record.budgetAdmittedAt), journalBeginMs: span(record.journalStartedAt, record.journalBeganAt),
    backendStartupMs: span(record.backendInvokedAt, record.firstFrameAt), timeToFirstFrameMs: span(record.acceptedAt, record.firstFrameAt), steps };
}
