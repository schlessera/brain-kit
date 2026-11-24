import packageInfo from "@schlessera/brain-ui-server/package.json" with { type: "json" };
import { parseBuildRevision } from "../config/env.js";
import type { ActivityTurnLifecycle, ActivityTurnSubPhase, ActivityTurnOpenSubPhase, ActivitySpanOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { AwaitableActivityStore } from "./store.js";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { orderedWrites } from "./store-writes.js";

/**
 * Starts one named lifecycle step and returns its end (#3355, #4285, #4286).
 * Steps ride on the record's next persisted milestone or terminal, so timing
 * adds no write to the turn path.
 */
export type PhaseTimer = (name: string) => () => void;

const BACKEND_STEP_LIMIT = 16, BACKEND_STEP_BYTES = 2048;
const BACKEND_DIAGNOSTIC_LIMIT = 8, BACKEND_DIAGNOSTIC_BYTES = 256, BACKEND_NAME_BYTES = 96;

/** Bound only the additive backend evidence, including older persisted rows. */
function boundBackendEvidence(record: ActivityTurnLifecycle): ActivityTurnLifecycle {
  let omitted = record.backendEvidenceOmitted ?? 0, steps = 0, stepBytes = 2, diagnosticBytes = 2;
  const count = () => { omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1); };
  const fitsName = (name: string) => typeof name === "string" && name.length <= BACKEND_NAME_BYTES && Buffer.byteLength(name) <= BACKEND_NAME_BYTES;
  const openSubPhases = record.openSubPhases?.filter(step => {
    if (step.phase !== "backend") return true;
    if (!fitsName(step.name)) { count(); return false; }
    const bytes = Buffer.byteLength(JSON.stringify(step)) + 1;
    if (steps >= BACKEND_STEP_LIMIT || stepBytes + bytes > BACKEND_STEP_BYTES) { count(); return false; }
    steps++; stepBytes += bytes; return true;
  });
  const names: string[] = [];
  for (const name of record.backendMissingEvidence ?? []) {
    if (!fitsName(name)) { count(); continue; }
    const bytes = Buffer.byteLength(JSON.stringify(name)) + 1;
    if (names.length >= BACKEND_DIAGNOSTIC_LIMIT || diagnosticBytes + bytes > BACKEND_DIAGNOSTIC_BYTES) { count(); continue; }
    diagnosticBytes += bytes; names.push(name);
  }
  return { ...record, ...(record.openSubPhases ? { openSubPhases } : {}),
    ...(record.backendMissingEvidence ? { backendMissingEvidence: names } : {}),
    ...(omitted || record.backendEvidenceOmitted !== undefined ? { backendEvidenceOmitted: omitted } : {}) };
}

/** A restarted host cannot recover elapsed downtime from a prior monotonic clock. */
export function lastLifecycleObservation(record: ActivityTurnLifecycle): number {
  const marks = [record.acceptedAt, record.dequeuedAt, record.governedStartedAt, record.governedAcquiredAt,
    record.budgetStartedAt, record.budgetAdmittedAt, record.journalStartedAt, record.journalBeganAt,
    record.backendInvokedAt, record.firstFrameAt, record.firstRelayRequestAt, record.failureObservedAt, record.recorderSettledAt, record.idleEmittedAt,
    ...(record.hostEvents ?? []).map(event => event.observedAt),
    ...[...(record.subPhases ?? []), ...(record.openSubPhases ?? [])].flatMap(step => [step.startedAt, step.endedAt])];
  return marks.reduce<number>((latest, at) => typeof at === "number" && Number.isFinite(at) ? Math.max(latest, at) : latest, record.acceptedAt);
}

type LifecycleMilestone = "dequeuedAt" | "governedStartedAt" | "governedAcquiredAt" | "budgetStartedAt" | "budgetAdmittedAt" | "journalStartedAt" | "journalBeganAt" | "backendInvokedAt" | "firstFrameAt" | "failureObservedAt" | "recorderSettledAt" | "idleEmittedAt";

export function createTurnLifecycle(store: AwaitableActivityStore, turnId: string, sessionId: string | null,
  acceptedAt: number, onWrite: () => void, clock?: () => number, principalId?: string, identity: { buildRevision?: string } = {}) {
  // Keep one epoch anchor for the whole lifecycle. Wall-clock corrections must
  // not reorder admission, backend observations or terminal boundaries.
  if (!clock) {
    const epoch = Date.now(), started = performance.now();
    clock = () => epoch + (performance.now() - started);
  }
  const observedClock = () => { try { return clock(); } catch { return undefined; } };
  const buildRevision = parseBuildRevision(identity.buildRevision);
  const record: ActivityTurnLifecycle = {
    packageVersion: packageInfo.version, ...(buildRevision ? { buildRevision } : {}),
    recorderSettledAt: null, idleEmittedAt: null,
    hostEvents: [], skippedPhases: [], lifecycleId: `lifecycle:${turnId}`, turnId, sessionId, backendRunId: null, acceptedAt, dequeuedAt: null,
    governedStartedAt: null, governedAcquiredAt: null, budgetStartedAt: null, budgetAdmittedAt: null,
    journalStartedAt: null, journalBeganAt: null, backendInvokedAt: null, firstRelayRequestAt: null, backendMissingEvidence: [], backendEvidenceOmitted: 0, firstFrameAt: null, failureObservedAt: null,
    endedAt: null, outcome: null, reason: null, totalElapsedMs: null, timeToFirstFrameMs: null,
    queueWaitMs: null, governedAdmissionMs: null, budgetAdmissionMs: null, journalBeginMs: null, backendStartupMs: null, subPhases: [], openSubPhases: [],
  };
  // Observability, including fanout, must never fail the observed turn. Each
  // write carries the record as it is now and fans out once committed (#2814).
  const writes = orderedWrites(store, () => { /* best effort */ });
  const persist = () => { writes.store.writeLifecycle(structuredClone(record), principalId); writes.after(onWrite); };
  persist();
  const recordHostEvent = (kind: ActivityTurnLifecycle["hostEvents"][number]["kind"], principalId: string) => {
    if (record.endedAt !== null) return;
    const at = observedClock(); if (at === undefined) return;
    record.hostEvents.push({ principalId, kind, observedAt: at }); persist();
  };
  const backendOpen = () => record.backendInvokedAt !== null && record.firstRelayRequestAt === null && record.endedAt === null;
  const applyBounds = () => {
    const bounded = boundBackendEvidence(record);
    record.openSubPhases = bounded.openSubPhases;
    record.backendMissingEvidence = bounded.backendMissingEvidence;
    record.backendEvidenceOmitted = bounded.backendEvidenceOmitted;
  };
  // Milestone intervals can be observed after steps that started later.
  // Insert by their actual start, retaining observation order for equal starts.
  const addOpenStep = (step: ActivityTurnOpenSubPhase) => {
    const steps = record.openSubPhases ??= [];
    const next = steps.findIndex(other => other.startedAt > step.startedAt);
    steps.splice(next < 0 ? steps.length : next, 0, step);
    if (step.phase === "backend") applyBounds();
  };
  // `lateEnd` lets a closing step whose work confirms after the terminal end
  // then (#4520). That end is the one write it adds, and only after the terminal.
  const phaseTimer = (phase: string, metadata: { pending?: boolean } = {}, { lateEnd = false }: { lateEnd?: boolean } = {}): PhaseTimer => name => {
    if (record.endedAt !== null || phase === "backend" && !backendOpen()) return () => {};
    const startedAt = observedClock(); if (startedAt === undefined) return () => {};
    const step = { phase, name, ...metadata, startedAt, endedAt: null as number | null, elapsedMs: null };
    if (phase === "governed" || phase === "journal") {
      (record.subPhases ??= []).push(step as ActivityTurnSubPhase);
      record.subPhases.sort((a, b) => a.startedAt - b.startedAt);
    }
    else addOpenStep(step);
    const late = lateEnd && phase === "closing";
    return () => {
      if (step.endedAt !== null) return;
      if (record.endedAt === null) { if (phase !== "backend" || backendOpen()) step.endedAt = observedClock() ?? null; return; }
      if (!late) return;
      const at = observedClock(); if (at === undefined) return;
      step.endedAt = at; persist();
    };
  };
  const startupTiming: NonNullable<StartTurnRequest["startupTiming"]> = {
    start: phaseTimer("backend"),
    worker(name, durationMs) {
      if (!backendOpen() || !Number.isFinite(durationMs) || durationMs < 0) return;
      const at = observedClock(); if (at === undefined) return;
      addOpenStep({ phase: "backend", name, startedAt: at, endedAt: at, elapsedMs: null,
        timeBase: "worker", workerElapsedMs: durationMs });
    },
    // A later init frame may identify a server whose connection clock was
    // unavailable. This reports absence only, never a late timing mark.
    missing(name, omitted = 0) {
      if (record.backendInvokedAt === null || record.endedAt !== null) return;
      if (Number.isSafeInteger(omitted) && omitted > 0) {
        applyBounds();
        record.backendEvidenceOmitted = Math.min(Number.MAX_SAFE_INTEGER, (record.backendEvidenceOmitted ?? 0) + omitted);
        // Retain the missing-evidence label when it fits. The annotation is
        // not another omitted observation if the diagnostic budget is full.
        if (!record.backendMissingEvidence!.includes(name)) {
          const proposed = boundBackendEvidence({ ...record, backendMissingEvidence: [...record.backendMissingEvidence!, name] });
          if (proposed.backendMissingEvidence?.includes(name)) record.backendMissingEvidence = proposed.backendMissingEvidence;
        }
        return;
      }
      if (record.backendMissingEvidence!.includes(name)) return;
      record.backendMissingEvidence!.push(name); applyBounds();
    },
    received() {
      if (!backendOpen()) return;
      const at = observedClock(); if (at === undefined) return; record.firstRelayRequestAt = at;
      addOpenStep({ phase: "backend", name: "first_relay_request", startedAt: record.backendInvokedAt!, endedAt: at, elapsedMs: null });
      persist();
    },
  };
  return {
    startupTiming,
    recordHostEvent,
    settled: writes.settled,
    recordCancellation(principalId: string, kind: "turn" | "ask_user" = "turn") {
      recordHostEvent(kind === "turn" ? "turn_cancelled" : "ask_user_cancelled", principalId);
    },
    skip(phase: "governed" | "budget" | "journal") {
      if (record.endedAt === null && !record.skippedPhases.includes(phase)) { record.skippedPhases.push(phase); persist(); }
    },
    mark(milestone: LifecycleMilestone, at = observedClock()) {
      if ((record.endedAt !== null && milestone !== "recorderSettledAt" && milestone !== "idleEmittedAt") || record[milestone] != null) return;
      if (at === undefined) return;
      record[milestone] = at;
      persist();
    },
    hold(hold: import("@schlessera/brain-ui-sdk/protocol").ActivityTurnHold) { if (record.endedAt === null) (record.holds ??= []).push(hold); },
    runtimeVersion(version: string) { if (record.endedAt === null) record.runtimeVersion = version; },
    timer: phaseTimer,
    backendExit() {
      if (record.endedAt !== null) return;
      const at = observedClock(); if (at === undefined) return;
      addOpenStep({ phase: "closing", name: "backend_exit", startedAt: at, endedAt: at, elapsedMs: 0 });
    },
    bindSession(id: string) { if (record.endedAt === null) { record.sessionId = id; persist(); } },
    linkBackend(id: string) { if (record.endedAt === null) { record.backendRunId = id; persist(); } },
    firstFrame(id: string | null) {
      if (record.endedAt !== null || record.firstFrameAt !== null) return;
      const at = observedClock(); if (at === undefined) return;
      if (backendOpen()) addOpenStep({ phase: "backend", name: "first_backend_frame", startedAt: record.backendInvokedAt!, endedAt: at, elapsedMs: null });
      record.firstFrameAt = at; record.backendRunId = id; persist();
    },
    finish(outcome: ActivitySpanOutcome, reason: string | null = null) {
      if (record.endedAt !== null) return;
      const at = observedClock(); if (at === undefined) return;
      record.endedAt = at; record.outcome = outcome; record.reason = reason; persist();
    },
  };
}

/** Shared by every read path, including interrupted and historical data. */
export function lifecycleTiming(record: ActivityTurnLifecycle): ActivityTurnLifecycle {
  const elapsed = (start: number | null, end: number | null) => start === null || end === null ? null : Math.max(0, end - start);
  // Incomplete admissions still expose their actually observed terminal time.
  const phase = (start: number | null, end: number | null) => elapsed(start, end ?? record.failureObservedAt ?? record.endedAt);
  return boundBackendEvidence({ ...record,
    totalElapsedMs: elapsed(record.acceptedAt, record.endedAt),
    timeToFirstFrameMs: elapsed(record.acceptedAt, record.firstFrameAt),
    queueWaitMs: elapsed(record.acceptedAt, record.dequeuedAt),
    governedAdmissionMs: phase(record.governedStartedAt, record.governedAcquiredAt),
    budgetAdmissionMs: phase(record.budgetStartedAt, record.budgetAdmittedAt),
    journalBeginMs: phase(record.journalStartedAt, record.journalBeganAt),
    backendStartupMs: phase(record.backendInvokedAt, record.firstFrameAt),
    // A step follows its phase's rules: unfinished, it measures to the failure boundary.
    ...(record.subPhases ? { subPhases: record.subPhases.map(step => ({ ...step, elapsedMs: phase(step.startedAt, step.endedAt) })) } : {}),
    ...(record.openSubPhases ? { openSubPhases: record.openSubPhases.map(step => ({ ...step, elapsedMs: step.timeBase === "worker" ? step.workerElapsedMs ?? null
      : step.phase === "backend" ? phase(step.startedAt, step.endedAt ?? record.firstRelayRequestAt ?? null)
      : elapsed(step.startedAt, step.endedAt ?? (record.failureObservedAt !== null && record.failureObservedAt >= step.startedAt ? record.failureObservedAt : record.endedAt)) })) } : {}),
  });
}
