import type { ActivityTurnLifecycle, ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { AwaitableActivityStore } from "./store.js";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { orderedWrites } from "./store-writes.js";

/**
 * Starts one named lifecycle step and returns its end (#3355, #4285, #4286).
 * Steps ride on the record's next persisted milestone or terminal, so timing
 * adds no write to the turn path.
 */
export type PhaseTimer = (name: string) => () => void;

type LifecycleMilestone = "dequeuedAt" | "governedStartedAt" | "governedAcquiredAt" | "budgetStartedAt" | "budgetAdmittedAt" | "journalStartedAt" | "journalBeganAt" | "backendInvokedAt" | "firstFrameAt" | "failureObservedAt";

export function createTurnLifecycle(store: AwaitableActivityStore, turnId: string, sessionId: string | null,
  acceptedAt: number, onWrite: () => void, clock: () => number = Date.now) {
  const record: ActivityTurnLifecycle = {
    hostEvents: [], skippedPhases: [], lifecycleId: `lifecycle:${turnId}`, turnId, sessionId, backendRunId: null, acceptedAt, dequeuedAt: null,
    governedStartedAt: null, governedAcquiredAt: null, budgetStartedAt: null, budgetAdmittedAt: null,
    journalStartedAt: null, journalBeganAt: null, backendInvokedAt: null, firstRelayRequestAt: null, backendMissingEvidence: [], firstFrameAt: null, failureObservedAt: null,
    endedAt: null, outcome: null, reason: null, totalElapsedMs: null, timeToFirstFrameMs: null,
    queueWaitMs: null, governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null, subPhases: [],
  };
  // Observability, including fanout, must never fail the observed turn. Each
  // write carries the record as it is now and fans out once committed (#2814).
  const writes = orderedWrites(store, () => { /* best effort */ });
  const persist = () => { writes.store.writeLifecycle(structuredClone(record)); writes.after(onWrite); };
  persist();
  const recordHostEvent = (kind: ActivityTurnLifecycle["hostEvents"][number]["kind"], principalId: string) => {
    if (record.endedAt !== null) return;
    record.hostEvents.push({ principalId, kind, observedAt: clock() }); persist();
  };
  const backendOpen = () => record.backendInvokedAt !== null && record.firstRelayRequestAt === null && record.endedAt === null;
  const phaseTimer = (phase: "governed" | "journal" | "backend"): PhaseTimer => name => {
    if (record.endedAt !== null || phase === "backend" && !backendOpen()) return () => {};
    const step = { phase, name, startedAt: clock(), endedAt: null as number | null, elapsedMs: null };
    (record.subPhases ??= []).push(step);
    return () => { if (record.endedAt === null && step.endedAt === null && (phase !== "backend" || backendOpen())) step.endedAt = clock(); };
  };
  const startupTiming: NonNullable<StartTurnRequest["startupTiming"]> = {
    start: phaseTimer("backend"),
    worker(name, durationMs) {
      if (!backendOpen() || !Number.isFinite(durationMs) || durationMs < 0) return;
      const at = clock();
      (record.subPhases ??= []).push({ phase: "backend", name, startedAt: at, endedAt: at, elapsedMs: null,
        timeBase: "worker", workerElapsedMs: durationMs });
    },
    // A later init frame may identify a server whose connection clock was
    // unavailable. This reports absence only, never a late timing mark.
    missing(name) { if (record.backendInvokedAt !== null && record.endedAt === null && !record.backendMissingEvidence!.includes(name)) record.backendMissingEvidence!.push(name); },
    received() {
      if (!backendOpen()) return;
      const at = clock(); record.firstRelayRequestAt = at;
      (record.subPhases ??= []).push({ phase: "backend", name: "first_relay_request", startedAt: record.backendInvokedAt!, endedAt: at, elapsedMs: null });
      persist();
    },
  };
  return {
    startupTiming,
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
    timer: phaseTimer,
    bindSession(id: string) { if (record.endedAt === null) { record.sessionId = id; persist(); } },
    linkBackend(id: string) { if (record.endedAt === null) { record.backendRunId = id; persist(); } },
    firstFrame(id: string | null) {
      if (record.endedAt !== null || record.firstFrameAt !== null) return;
      if (backendOpen()) (record.subPhases ??= []).push({ phase: "backend", name: "first_backend_frame", startedAt: record.backendInvokedAt!, endedAt: clock(), elapsedMs: null });
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
    // A step follows its phase's rules: unfinished, it measures to the failure boundary.
    ...(record.subPhases ? { subPhases: record.subPhases.map(step => ({ ...step, elapsedMs: step.timeBase === "worker" ? step.workerElapsedMs ?? null
      : phase(step.startedAt, step.endedAt ?? (step.phase === "backend" ? record.firstRelayRequestAt ?? null : null)) })) } : {}),
  };
}
