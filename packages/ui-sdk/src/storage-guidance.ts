import type { StorageCoverage, StorageOwner } from "./storage.js";
/*
 * Storage pressure policy, as set in docs/decisions/storage-guidance.md. The
 * server's severity computation reads these values, so a client drawing
 * threshold ticks, bands or recovery copy from them stays in step with the
 * severity it is shown. They are policy constants, not wire fields.
 *
 * Capacity percentages compare caller-available bytes with the capacity total.
 * Entry is inclusive (available at or below the percentage); recovery is strict
 * (available above it). Forecast days compare a qualified scenario's days to
 * exhaustion: entry is inclusive (at or within), recovery strict (beyond, or a
 * non-depleting scenario).
 */
/** Low is entered when available space is at or below this percentage of total. */
export const STORAGE_PRESSURE_LOW_PERCENT = 10;
/** Critical is entered when available space is at or below this percentage of total. */
export const STORAGE_PRESSURE_CRITICAL_PERCENT = 5;
/** A Low capacity cause recovers only when available space is above this percentage of total. */
export const STORAGE_PRESSURE_LOW_RECOVERY_PERCENT = 12;
/** A Critical capacity cause recovers (to Low) only when available space is above this percentage of total. */
export const STORAGE_PRESSURE_CRITICAL_RECOVERY_PERCENT = 7;
/** Low is entered when either qualified scenario (7-day or 30-day window) reaches exhaustion within this many days. */
export const STORAGE_PRESSURE_LOW_FORECAST_DAYS = 30;
/** Critical is entered when both qualified scenarios reach exhaustion within this many days. */
export const STORAGE_PRESSURE_CRITICAL_FORECAST_DAYS = 7;
/** A Low forecast cause recovers only when both scenarios are beyond this many days. */
export const STORAGE_PRESSURE_LOW_FORECAST_RECOVERY_DAYS = 45;
/** A Critical forecast cause recovers (to Low) when either scenario is beyond this many days. */
export const STORAGE_PRESSURE_CRITICAL_FORECAST_RECOVERY_DAYS = 10;
/**
 * Recovery needs this many consecutive qualifying fresh observations, with every
 * active cause recovered in each. The first starts `recoveryAt`; the last downgrades.
 */
export const STORAGE_PRESSURE_RECOVERY_OBSERVATIONS = 2;
/** Minimum time between the first and last qualifying recovery observations, in milliseconds. */
export const STORAGE_PRESSURE_RECOVERY_SPACING_MS = 60_000;
/**
 * Capacity evidence and owner refusals older than this many milliseconds are not
 * current: stale evidence cannot raise, support or recover pressure, and resets a
 * recovery in progress.
 */
export const STORAGE_PRESSURE_EVIDENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

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
