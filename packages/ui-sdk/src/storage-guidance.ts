import type { StorageCoverage, StorageOwner } from "./storage.js";
/** Versioned named projection of bounded operational evidence; never raw persistence tuples. */
export type StorageHistoryTier = "six-hour" | "daily" | "weekly";
export type StorageSeverity = "observed" | "low" | "critical";
export type StorageEvidenceReason = "no-observation" | "stale" | "future" | "incomplete" | "changed-scope" | "changed-capacity" | "gap" | "ordering" | "insufficient-count" | "insufficient-span" | "mixed-direction" | "single-burst" | "arithmetic";
export interface StorageObservedRate { start: number; end: number; samples: number; bytesPerDay: number }
export interface StorageScenario {
  state: "unavailable" | "finite" | "non-depleting"; reason: StorageEvidenceReason | null;
  start: number | null; end: number | null; samples: number; depletionPerDay: number | null; days: number | null;
}
export interface StorageCapacityEvidence {
  identity: string; rootScope: string; at: number; total: number | null; available: number | null; fresh: boolean;
  short: StorageScenario; long: StorageScenario;
  appLogical: StorageObservedRate | null; appAllocated: StorageObservedRate | null; availableChange: StorageObservedRate | null;
}
export interface StorageHistoryCapacity {
  identity: string; rootScope: string; total: number | null; used: number | null; free: number | null; available: number | null;
  coverage: StorageCoverage;
  owners: Record<StorageOwner, { logical: number | null; allocated: number | null }>;
  union: { logical: number | null; allocated: number | null };
}
export interface StorageHistoryObservation {
  tier: StorageHistoryTier; gap: boolean; at: number; startedAt: number; source: "scheduled" | "refresh" | "operation";
  collector: string; scope: string; basis: "storage-v1"; coverage: StorageCoverage;
  reason: "none" | "partial" | "capacity" | "scope-limit" | "budget" | "changed";
  capacities: StorageHistoryCapacity[];
}
export interface StorageHistoryResponse {
  version: 1; state: "available" | "unavailable"; paused: string | null; pending: boolean;
  lastObservedAt: number | null; payloadBytes: number | null;
  limits: { sixHour: 64; daily: 90; weekly: 32; capacities: 4; payloadBytes: 262144 };
  observations: StorageHistoryObservation[];
}
export interface StoragePressureView {
  identity: string; rootScope: string; severity: StorageSeverity; at: number;
  state: "current" | "unknown"; scopeChanged: boolean; recoveryAt: number | null;
  episode: string | null;
  causes: { capacity: boolean; forecast: boolean; refusals: Array<{ target: string; resource: "bytes" | "quota" | "inodes" | "unknown"; at: number; successAt: number | null }> };
  /** Only current authorized inventory supplies display labels. Empty means refresh is needed. */
  stores: Array<{ label: string; owner: StorageOwner }>;
  evidence: StorageCapacityEvidence | null;
}
export interface StorageGuidanceResponse {
  version: 1; state: "current" | "unknown" | "unavailable"; severity: StorageSeverity | null;
  paused: string | null; pending: boolean; observedAt: number | null; scopeLimit: boolean;
  capacities: StoragePressureView[]; untracked: string[];
  notifications: {
    permission: "browser-managed"; quietHours: { start: 22; end: 8; unknownZone: "defer" };
    subscriptionsTruncated: boolean; receiptsTruncated: boolean;
    subscriptions: Array<{ zoneKnown: boolean; quiet: boolean | null }>;
    receipts: Array<{ episode: string; state: "pending" | "sending" | "accepted" | "failed" | "unknown" | "suppressed"; attempts: number; nextAt: number | null }>;
  };
}
