/** One live read for enforcement; ordinary governance remains turn-bound. */
import type { AdmissionSafety } from "@schlessera/brain-ui-sdk/internal";
import type { Database } from "bun:sqlite";
import type { GovernanceWrites } from "./event-writes.js";
import { safetyProjection } from "./safety-store.js";
import { safetyQueue } from "./safety-queue.js";

/** Concrete input from the host's future trust publisher, not a policy loader or matcher. */
export interface LiveTrustRevision {
  revision(): string;
  subscribe(changed: () => void): () => void;
}

export function createEffectiveSafety(db: Database, options: {
  turnId: string; sessionId: () => string | null; policyHash: string | null;
  brain?: string;
  writes?: Pick<GovernanceWrites, "safety">;
  authority(): { current: boolean; epoch: string };
  trust?: LiveTrustRevision;
  signal?: AbortSignal;
}): AdmissionSafety {
  return {
    read() {
      const projection = options.writes?.safety(options.turnId, options.sessionId()) ?? safetyProjection(db, options.turnId, options.sessionId());
      const authority = options.authority(), trustRevision = options.trust?.revision() ?? "0";
      for (const revision of [trustRevision, authority.epoch]) {
        if (!/^(0|[1-9][0-9]{0,19})$/.test(revision) || BigInt(revision) > 18446744073709551615n) throw new Error("Invalid live safety revision");
      }
      return { evidenceRevision: projection.evidenceRevision, trustRevision, authorityEpoch: authority.epoch,
        scope: JSON.stringify([options.brain ?? db.filename, options.turnId, projection.session]), policyHash: options.policyHash,
        restricted: projection.restriction === "restricted",
        recordingAvailable: !projection.reasons.some(reason => ["recording_pending", "recording_failed", "capacity"].includes(reason)),
        authorityCurrent: authority.current };
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
