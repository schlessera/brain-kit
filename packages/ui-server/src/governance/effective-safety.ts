/** One live read for enforcement; ordinary governance remains turn-bound. */
import { sameAuthority, type AdmissionSafety } from "@schlessera/brain-ui-sdk/internal";
import { Database } from "bun:sqlite";
import type { GovernanceWrites } from "./event-writes.js";
import { safetyEvidenceSequence, safetyProjection, safetyScopeTurns } from "./safety-store.js";
import { safetyQueue, safetyReadVersion } from "./safety-queue.js";

/** Concrete input from the host's future trust publisher, not a policy loader or matcher. */
export interface LiveTrustRevision {
  revision(): string;
  subscribe(changed: () => void): () => void;
}

export function createEffectiveSafety(db: Database, options: {
  turnId: string; sessionId: () => string | null; policyHash: string | null;
  brain?: string;
  writes?: Pick<GovernanceWrites, "safety"> & Partial<Pick<GovernanceWrites, "recordingAvailable">>;
  authority(): { current: boolean; epoch: string };
  trust?: LiveTrustRevision;
  signal?: AbortSignal;
}): AdmissionSafety {
  let observed: string | undefined, evidenceRevision = "0", lastGlobalRevision = 0n;
  let cached: { key:string; value:ReturnType<AdmissionSafety["read"]> } | undefined;
  let pendingRead:{value:ReturnType<AdmissionSafety["read"]>;available:WeakMap<readonly string[],boolean>}|undefined;
  const read = (cacheAllowed = true) => {
    const sessionId = options.sessionId(), authority = options.authority(), trustRevision = options.trust?.revision() ?? "0";
    const key = JSON.stringify([safetyReadVersion(db),sessionId,authority.current,authority.epoch,trustRevision]);
    if (cacheAllowed && cached?.key === key) return cached.value;
    const projection = options.writes?.safety(options.turnId, sessionId) ?? safetyProjection(db, options.turnId, sessionId);
    const sequence = safetyEvidenceSequence(db, options.turnId, sessionId);
    const membership = safetyScopeTurns(db, options.turnId, sessionId).size;
    for (const revision of [projection.evidenceRevision, sequence, trustRevision, authority.epoch]) {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(revision) || BigInt(revision) > 18446744073709551615n) throw new Error("Invalid live safety revision");
    }
    const global = BigInt(projection.evidenceRevision);
    if (global < lastGlobalRevision) throw new Error("Safety evidence revision moved backwards");
    // The history cursor is brain-wide. Admission advances only when this
    // bounded canonical scope changes, including same-aggregate appends from
    // another FULL writer. Local pending/failure flags remain in the marker;
    // shared recorder loss therefore still withdraws unrelated approvals.
    const evidence = { ...projection, evidenceRevision: undefined };
    const marker = JSON.stringify([evidence, sequence, membership]);
    if (marker !== observed) {
      // Durable alias adoption and local pending/loss overlays can change this
      // scope without changing the history cursor. Keep a separate monotonic
      // admission revision; it is never a history/review cursor.
      const next = observed === undefined ? global : (global > BigInt(evidenceRevision) ? global : BigInt(evidenceRevision) + 1n);
      if (next > 18446744073709551615n) throw new Error("Safety admission revision exhausted");
      evidenceRevision = next.toString(); observed = marker;
    }
    lastGlobalRevision = global;
    const value = { evidenceRevision, trustRevision, authorityEpoch: authority.epoch,
      scope: JSON.stringify([options.brain ?? db.filename, options.turnId, projection.session]), policyHash: options.policyHash,
      restricted: projection.restriction === "restricted",
      // The facade also knows a turn begun restricted: its permanent gap
      // covers anything it loses, so it runs under its tainted policy (#3812).
      recordingAvailable: options.writes?.recordingAvailable ? options.writes.recordingAvailable(options.turnId, sessionId)
        : !projection.reasons.some(reason => ["recording_pending", "recording_failed", "capacity"].includes(reason)),
      // A different recorder can fail while this producer is still healthy.
      // Only a pending-only block may wait for settlement.
      recordingPending: projection.reasons.includes("recording_pending") &&
        !projection.reasons.some(reason => reason === "recording_failed" || reason === "capacity"),
      operationRecordingAvailable: !safetyQueue(db).lostTurns.has(options.turnId) &&
        !db.query("SELECT 1 FROM safety_collections WHERE turn_id=? AND failure IS NOT NULL AND ended=0").get(options.turnId),
      authorityCurrent: authority.current };
    if (cacheAllowed) cached = { key, value }; return value;
  };
  const safety: AdmissionSafety = {
    read(excludedPending=[]) {
      // Projection and immutable sequence must describe one SQLite snapshot.
      const cacheAllowed=!db.inTransaction;
      const snapshot=()=>{
        const value=read(cacheAllowed);if(!excludedPending.length)return value;
        // Keep the global counter, scope, taint and every failure. Only these
        // exact pending reservations stop blocking their own approved peers.
        if(pendingRead?.value!==value)pendingRead={value,available:new WeakMap()};
        const immutable=Object.isFrozen(excludedPending);
        let recordingAvailable=immutable?pendingRead.available.get(excludedPending):undefined;
        if(recordingAvailable===undefined){
          recordingAvailable=options.writes?.recordingAvailable?.(options.turnId,options.sessionId(),excludedPending)
            ?? !safetyProjection(db,options.turnId,options.sessionId(),excludedPending).reasons.some(reason=>["recording_pending","recording_failed","capacity"].includes(reason));
          if(immutable)pendingRead.available.set(excludedPending,recordingAvailable);
        }
        return {...value,recordingAvailable};
      };
      return db.inTransaction ? snapshot() : Database.prototype.transaction.call(db,snapshot).deferred() as ReturnType<AdmissionSafety["read"]>;
    },
    *pendingRecording(before, signal = options.signal, excludedPending) {
      if (signal?.aborted) return;
      const pending = () => {
        try {
          const now = safety.read(excludedPending?.());
          return now.recordingPending === true && !now.recordingAvailable &&
            now.operationRecordingAvailable === true && sameAuthority(now, before);
        } catch { return false; } // An unreadable snapshot goes to the caller's refusal gate.
      };
      const deadline = performance.now() + 2000;
      // A woken sibling can reserve again before this caller resumes. The
      // caller advances this iterator in the same continuation as its fence.
      while (!signal?.aborted && pending()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        const check = () => { if (!pending()) resolve(); };
        const unsubscribe = safety.subscribe(check);
        const timer = setTimeout(resolve, remaining);
        const abort = () => resolve();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) resolve();
          else check();
          yield promise;
        } finally {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    subscribe(changed) {
      const listeners = safetyQueue(db).listeners;
      listeners.add(changed);
      const release = options.trust?.subscribe(changed);
      options.signal?.addEventListener("abort", changed, { once: true });
      return () => { listeners.delete(changed); release?.(); options.signal?.removeEventListener("abort", changed); };
    },
  };
  return safety;
}
