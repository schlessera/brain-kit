/** One live read for enforcement; ordinary governance remains turn-bound. */
import type { AdmissionSafety } from "@schlessera/brain-ui-sdk/internal";
import { Database } from "bun:sqlite";
import type { GovernanceWrites } from "./event-writes.js";
import { safetyEvidenceSequence, safetyProjection, safetyScopeTurns } from "./safety-store.js";
import { safetyQueue } from "./safety-queue.js";

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
  const read = () => {
    const sessionId = options.sessionId();
    const projection = options.writes?.safety(options.turnId, sessionId) ?? safetyProjection(db, options.turnId, sessionId);
    const sequence = safetyEvidenceSequence(db, options.turnId, sessionId);
    const membership = safetyScopeTurns(db, options.turnId, sessionId).size;
    const authority = options.authority(), trustRevision = options.trust?.revision() ?? "0";
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
    return { evidenceRevision, trustRevision, authorityEpoch: authority.epoch,
      scope: JSON.stringify([options.brain ?? db.filename, options.turnId, projection.session]), policyHash: options.policyHash,
      restricted: projection.restriction === "restricted",
      // The facade also knows a turn begun restricted: its permanent gap
      // covers anything it loses, so it runs under its tainted policy (#3812).
      recordingAvailable: options.writes?.recordingAvailable ? options.writes.recordingAvailable(options.turnId, sessionId)
        : !projection.reasons.some(reason => ["recording_pending", "recording_failed", "capacity"].includes(reason)),
      authorityCurrent: authority.current };
  };
  return {
    read() {
      // Projection and immutable sequence must describe one SQLite snapshot.
      return db.inTransaction ? read() : Database.prototype.transaction.call(db, read).deferred() as ReturnType<AdmissionSafety["read"]>;
    },
    subscribe(changed) {
      const listeners = safetyQueue(db).listeners;
      listeners.add(changed);
      const release = options.trust?.subscribe(changed);
      options.signal?.addEventListener("abort", changed, { once: true });
      return () => { listeners.delete(changed); release?.(); options.signal?.removeEventListener("abort", changed); };
    },
  };
}
