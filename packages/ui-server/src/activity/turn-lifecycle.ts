import type { ActivityTurnLifecycle, ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivityStore } from "./store.js";

export type LifecycleMilestone = "dequeuedAt" | "governedStartedAt" | "governedAcquiredAt" | "budgetStartedAt" | "budgetAdmittedAt" | "journalStartedAt" | "journalBeganAt" | "backendInvokedAt" | "firstFrameAt" | "failureObservedAt";

export function createTurnLifecycle(store: ActivityStore, turnId: string, sessionId: string | null,
  acceptedAt: number, onWrite: () => void, clock: () => number = Date.now) {
  const record: ActivityTurnLifecycle = {
    hostEvents: [], skippedPhases: [], lifecycleId: `lifecycle:${turnId}`, turnId, sessionId, backendRunId: null, acceptedAt, dequeuedAt: null,
    governedStartedAt: null, governedAcquiredAt: null, budgetStartedAt: null, budgetAdmittedAt: null,
    journalStartedAt: null, journalBeganAt: null, backendInvokedAt: null, firstFrameAt: null, failureObservedAt: null,
    endedAt: null, outcome: null, reason: null, totalElapsedMs: null, timeToFirstFrameMs: null,
    queueWaitMs: null, governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null,
  };
  // Observability, including fanout, must never fail the observed turn.
  const persist = () => { try { store.writeLifecycle(record); onWrite(); } catch { /* best effort */ } };
  persist();
  const recordHostEvent = (kind: ActivityTurnLifecycle["hostEvents"][number]["kind"], principalId: string) => {
    if (record.endedAt !== null) return;
    record.hostEvents.push({ principalId, kind, observedAt: clock() }); persist();
  };
  return {
    recordHostEvent,
    recordCancellation(principalId: string, kind: "turn" | "ask_user" = "turn") {
      recordHostEvent(kind === "turn" ? "turn_cancelled" : "ask_user_cancelled", principalId);
    },
    skip(phase: "governed" | "budget" | "journal") {
      if (record.endedAt === null && !record.skippedPhases.includes(phase)) { record.skippedPhases.push(phase); persist(); }
    },
    mark(milestone: LifecycleMilestone, at = clock()) {
      if (record.endedAt !== null || record[milestone] !== null) return;
      record[milestone] = at;
      persist();
    },
    bindSession(id: string) { if (record.endedAt === null) { record.sessionId = id; persist(); } },
    linkBackend(id: string) { if (record.endedAt === null) { record.backendRunId = id; persist(); } },
    firstFrame(id: string | null) {
      if (record.endedAt !== null || record.firstFrameAt !== null) return;
      record.firstFrameAt = clock(); record.backendRunId = id; persist();
    },
    finish(outcome: ActivitySpanOutcome, reason: string | null = null) {
      if (record.endedAt !== null) return;
      record.endedAt = clock(); record.outcome = outcome; record.reason = reason; persist();
    },
  };
}

/** Shared by every read path, including interrupted and historical data. */
export function lifecycleTiming(record: ActivityTurnLifecycle): ActivityTurnLifecycle {
  const elapsed = (start: number | null, end: number | null) => start === null || end === null ? null : Math.max(0, end - start);
  // Incomplete admissions still expose their actually observed terminal time.
  const phase = (start: number | null, end: number | null) => elapsed(start, end ?? record.failureObservedAt ?? record.endedAt);
  return { ...record,
    totalElapsedMs: elapsed(record.acceptedAt, record.endedAt),
    timeToFirstFrameMs: elapsed(record.acceptedAt, record.firstFrameAt),
    queueWaitMs: elapsed(record.acceptedAt, record.dequeuedAt),
    governedAdmissionMs: phase(record.governedStartedAt, record.governedAcquiredAt),
    budgetAdmissionMs: phase(record.budgetStartedAt, record.budgetAdmittedAt),
    journalBeginMs: phase(record.journalStartedAt, record.journalBeganAt),
    backendStartupMs: phase(record.backendInvokedAt, record.firstFrameAt),
  };
}
