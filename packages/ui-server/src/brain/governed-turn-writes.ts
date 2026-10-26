/**
 * A governed turn's admission records off the event loop (#2850): the policy
 * it was admitted under, what its provider was shown, its masked lineage and
 * its protected-path manifest commit on the `ui.db` write worker at
 * `synchronous=FULL`. Admission awaits each before the turn goes on, so every
 * record is durable before anything it describes can happen. The writers are
 * the ones that ran inline, run on the write connection.
 */
import type { Database } from "bun:sqlite";

import type { WriteProcedures } from "../db/write-worker.js";
import { exposureWriters } from "./provider-exposure.js";
import type { ProviderExposure } from "./governance-policy.js";

export const url = import.meta.url;

export function setup(db: Database): WriteProcedures {
  const exposures = exposureWriters(db);
  return {
    recordPolicy(turnId: string, origin: string, profile: string, hash: string | null, source: string, policy: string, errors: string, at: number) {
      db.query(`INSERT INTO turn_governance_policy
        (turn_id, origin, profile, policy_hash, source, policy, errors, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turnId, origin, profile, hash, source, policy, errors, at);
    },
    exposureRecord: (turnId: string, sessionId: string | null, exposure: ProviderExposure, at: number) => exposures.record(turnId, sessionId, exposure, at),
    exposureBind: (turnId: string, sessionId: string) => exposures.bind(turnId, sessionId),
    exposureStartMasked: (turnId: string, masked: string[], at: number) => exposures.startMasked(turnId, masked, at),
    exposureNarrowMasked: (turnId: string, sessionId: string, masked: string[], at: number) => exposures.narrowMasked(turnId, sessionId, masked, at),
    manifestBegin(turnId: string, brain: string, pid: number, pidStart: string, manifest: string, at: number) {
      db.query("INSERT INTO governed_turn_manifests (turn_id, brain, pid, pid_start, manifest, started_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(turnId, brain, pid, pidStart, manifest, at);
    },
    manifestClose(turnId: string, endedAt: number | null, reconciliation: string) {
      db.query("UPDATE governed_turn_manifests SET ended_at = ?, reconciliation = ? WHERE turn_id = ?").run(endedAt, reconciliation, turnId);
    },
  };
}
