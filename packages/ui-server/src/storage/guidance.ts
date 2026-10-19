import type { Database } from "bun:sqlite";
import type { StorageCoverage, StorageGuidanceResponse, StorageHistoryResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { StorageHistory } from "./history-store.js";
import { capacityEvidence } from "./history-evidence.js";
import { StorageUnavailable, type StorageCoordinator } from "./coordinator.js";
import { localHour, noticeTimeZone } from "../inbox/notify.js";
import type { StorageNotifier } from "./notify.js";
const coverages: StorageCoverage[] = ["complete", "partial", "unknown"];
/** Read-only, owner-scoped views. Opening either endpoint never starts a scan. */
export function createStorageGuidance(db: Database, history: StorageHistory, storage: StorageCoordinator, notices: StorageNotifier) {
  function state(principal: string) {
    const inventory = storage.status(principal), status = history.status();
    return { inventory, ...status };
  }
  return {
    history(principal: string): StorageHistoryResponse {
      const status = state(principal), payload = status.history;
      return { version: 1, state: payload ? "available" : "unavailable", paused: status.paused, pending: status.pending,
        lastObservedAt: payload?.metadata.state.lastObservedAt || null, payloadBytes: status.payloadBytes,
        limits: { sixHour: 64, daily: 90, weekly: 32, capacities: 4, payloadBytes: 262144 },
        observations: payload?.samples.map(row => ({ tier: (["six-hour", "daily", "weekly"] as const)[row[1]], gap: !!row[2], at: row[3], startedAt: row[4],
          source: (["scheduled", "refresh", "operation"] as const)[row[5]], collector: payload.metadata.samples[row[6]]![0], scope: payload.metadata.samples[row[6]]![1], basis: "storage-v1", coverage: coverages[row[7]]!,
          reason: (["none", "partial", "capacity", "scope-limit", "budget", "changed"] as const)[row[8]],
          capacities: row[9].map(value => ({ identity: payload.metadata.capacities[value[0]]![0], rootScope: payload.metadata.capacities[value[0]]![1], total: value[1], used: value[2], free: value[3], available: value[4], coverage: coverages[value[5]]!,
            owners: { brain: { logical: value[6], allocated: value[7] }, app: { logical: value[8], allocated: value[9] }, operator: { logical: value[10], allocated: value[11] } }, union: { logical: value[12], allocated: value[13] } })) })) ?? [] };
    },
    guidance(principal: string, now = Date.now()): StorageGuidanceResponse {
      const status = state(principal), payload = status.history, warning = payload?.metadata.state;
      const snapshot = [status.inventory.snapshot, status.inventory.previous].filter(value => value !== null).sort((a, b) => b.observedAt - a.observedAt)[0];
      const capacities = warning?.pressures.map(pressure => {
        const evidence = capacityEvidence(payload!, pressure.identity, now);
        const current = !status.paused && !status.pending && !pressure.scopeChanged && !!evidence?.fresh && evidence.at >= pressure.at;
        const roots = snapshot?.capacities.find(value => value.id === pressure.identity)?.rootIds ?? [];
        return { identity: pressure.identity, rootScope: pressure.rootScope, severity: pressure.severity, at: pressure.at,
          state: current ? "current" as const : "unknown" as const, scopeChanged: pressure.scopeChanged, recoveryAt: pressure.recoveryAt, episode: pressure.episode,
          causes: { capacity: pressure.capacity, forecast: pressure.forecast, refusals: pressure.refusals },
          stores: snapshot?.roots.filter(root => roots.includes(root.id)).map(root => ({ label: root.label, owner: root.owner })) ?? [], evidence };
      }) ?? [];
      const subscriptions = db.query("SELECT time_zone FROM push_subscriptions WHERE principal_id = ? ORDER BY endpoint LIMIT 101").all(principal) as Array<{ time_zone: string | null }>;
      const severity = capacities.some(value => value.severity === "critical") ? "critical" : capacities.some(value => value.severity === "low") ? "low" : capacities.length ? "observed" : null;
      const receipts = notices.receipts(principal, now);
      const result: StorageGuidanceResponse = { version: 1, state: !payload ? "unavailable" : capacities.length && capacities.every(value => value.state === "current") ? "current" : "unknown",
        severity, paused: status.paused, pending: status.pending, observedAt: warning?.lastObservedAt || null, scopeLimit: warning?.scopeLimit ?? false, capacities,
        untracked: snapshot?.capacities.filter(value => !capacities.some(row => row.identity === value.id)).map(value => value.id) ?? [],
        notifications: { permission: "browser-managed", quietHours: { start: 22, end: 8, unknownZone: "defer" }, subscriptionsTruncated: subscriptions.length > 100, receiptsTruncated: receipts.length > 200, subscriptions: subscriptions.slice(0, 100).map(value => { const zone = noticeTimeZone(value.time_zone); const hour = zone ? localHour(zone, now) : null; return { zoneKnown: !!zone, quiet: hour === null ? null : hour >= 22 || hour < 8 }; }), receipts: receipts.slice(0, 200) } };
      // Recheck the same authority immediately before publishing operational data.
      try { storage.status(principal); } catch { throw new StorageUnavailable(403, "Storage requires current human-owner access."); }
      return result;
    },
  };
}
export type StorageGuidance = ReturnType<typeof createStorageGuidance>;
