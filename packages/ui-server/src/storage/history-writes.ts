/** Storage history transactions, shared by the write worker and inline callers. */
import type { Database } from "bun:sqlite";
import { capacityEvidence } from "./history-evidence.js";
import { newPressure, observePressure, ownerWrite } from "./pressure.js";
import { HISTORY_LIMITS, bucket, retainAggregate, validateHistory } from "./history-model.js";
import { readStoredHistory, stateSchema, type OwnerEvidence, type StoredHistory, type Pending, type StorageWriteReport } from "./history-data.js";
import { pauseStorageEvents, recordOwnerEvidence, recordPressureChange, recordScopeChange } from "./events.js";

export const url = import.meta.url;
export interface HistoryFlush {
  candidate: Pending | null; writes: StorageWriteReport[]; time: number; at: number;
  interrupted: boolean; ownerOverflow: boolean;
  /** Event-only: every accepted owner report since the last write, and whether any was dropped. */
  evidence: OwnerEvidence[]; evidenceDropped: boolean;
}
export function setup(db: Database, { brain, initial }: { brain: string; initial: StoredHistory }) {
  const initialize = () => db.query("INSERT OR IGNORE INTO storage_history (brain, payload_json) VALUES (?, ?)").run(brain, JSON.stringify(initial));
  return {
    initialize,
    flush({ candidate, writes, time, at, interrupted, ownerOverflow, evidence = [], evidenceDropped = false }: HistoryFlush) {
      return db.transaction(() => {
        initialize();
        const previous = readStoredHistory(db, brain);
        if (!previous) throw Error("history-unavailable");
        const state = previous.metadata.state;
        const ownerEvidenceLost = ownerOverflow || state.paused === "history-owner-evidence-budget";
        if (time < state.lastPersistedAt || at < state.lastObservedAt || at > time) throw Error("history-clock-reversal");
        if (time - state.lastPersistedAt < HISTORY_LIMITS.writeInterval) return false;
        let next: StoredHistory;
        if (interrupted || ownerEvidenceLost) state.pressures = state.pressures.map(value => ({ ...value, recoveryAt: null, supportAt: null }));
        if (candidate?.kind === "aggregate") {
          next = retainAggregate(previous, candidate.value);
          if (interrupted || state.paused) for (const sample of next.samples) if (sample[3] === candidate.value.at) sample[2] = 1;
          // A partial refresh may preserve the complete stored endpoint. Evaluate
          // the actual new capacity observation, never give the old total a new time.
          const evaluation = retainAggregate({ ...structuredClone(next), samples: next.samples.filter(row => row[1] !== 0 || bucket(0, row[3]) !== bucket(0, at)) }, candidate.value);
          if (interrupted || state.paused) for (const sample of evaluation.samples) if (sample[3] === candidate.value.at) sample[2] = 1;
          const incoming = candidate.value.capacities.map(row => row.descriptor);
          for (const [identity, rootScope] of incoming) recordScopeChange(db, brain, identity, rootScope, candidate.value.at);
          const pressures = state.pressures.filter(value => value.severity !== "observed" || incoming.some(([identity]) => identity === value.identity))
            .map(value => value.severity === "observed" ? newPressure(value.identity, incoming.find(([identity]) => identity === value.identity)![1]) : value);
          for (const [identity, rootScope] of incoming) if (!pressures.some(value => value.identity === identity) && pressures.length < 4) pressures.push(newPressure(identity, rootScope));
          next.metadata.state.pressures = pressures.map(value => {
            const observation = capacityEvidence(evaluation, value.identity, time);
            const observed = observePressure(value, observation, time);
            // Fresh direct observations can escalate pressure, but cannot prove
            // recovery of an owner refusal whose identity was not retained.
            if (ownerEvidenceLost) observed.recoveryAt = null;
            // The transition happened at the observation, not at this flush.
            if (observation) recordPressureChange(db, brain, value, observed, observation.at);
            return observed;
          });
          next.metadata.state.scopeLimit = candidate.value.reason === 3 || incoming.some(([identity]) => !pressures.some(value => value.identity === identity));
          next.metadata.state.paused = null;
        } else if (candidate) {
          next = structuredClone(previous);
          for (const row of next.samples) if (bucket(row[1], row[3]) === bucket(row[1], at)) row[2] = 1;
          next.metadata.state.pressures = state.pressures.map(value => observePressure(value, null, time));
          next.metadata.state.paused = "collection-unavailable";
        } else next = structuredClone(previous);
        // Owner reports change pressure exactly as before #4541. The timeline
        // replays the uncoalesced evidence instead, after the state they start from.
        const beforeWrites = structuredClone(next.metadata.state.pressures);
        for (const report of writes) {
          let pressure = next.metadata.state.pressures.find(value => value.identity === report.identity);
          if (!pressure && report.outcome === "success") continue;
          if (!pressure) {
            if (next.metadata.state.pressures.length >= 4) throw Error("history-pressure-capacity-budget");
            pressure = newPressure(report.identity, report.rootScope); next.metadata.state.pressures.push(pressure);
          }
          const index = next.metadata.state.pressures.indexOf(pressure);
          // Buffered reports were checked when received. A newer capacity sample
          // from this or another process cannot erase an intervening refusal.
          if (pressure.refusals.some(value => value.target === report.target && value.resource === report.resource && value.at > report.at)) continue;
          const changed = ownerWrite({ ...pressure, at: Math.min(pressure.at, report.at) }, report, time);
          changed.at = Math.max(changed.at, pressure.at);
          next.metadata.state.pressures[index] = changed;
        }
        if (evidenceDropped) pauseStorageEvents(db, brain, ["refusal", "pressure"], time, "owner-evidence-overflow");
        else recordOwnerEvidence(db, brain, beforeWrites, next.metadata.state.pressures, evidence);
        if (ownerEvidenceLost) next.metadata.state.paused = "history-owner-evidence-budget";
        next.metadata.state.lastPersistedAt = time;
        if (candidate) {
          const observedAt = candidate.kind === "aggregate" ? candidate.value.at : candidate.at;
          next.metadata.state.lastObservedAt = observedAt;
          next.metadata.state.lastAttemptBucket = bucket(0, observedAt);
        }
        const episodes = new Set(next.metadata.state.pressures.flatMap(value => [value.episode, value.resolvedEpisode].filter((id): id is string => id !== null)));
        next.metadata.state.suppressedEpisodes = next.metadata.state.suppressedEpisodes.filter(value => episodes.has(value));
        validateHistory(next); stateSchema.parse(next.metadata.state);
        db.query("UPDATE storage_history SET payload_json = ?, revision = revision + 1 WHERE brain = ?").run(JSON.stringify(next), brain);
        return true;
      }).immediate();
    },
  };
}
