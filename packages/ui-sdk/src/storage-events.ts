import type { StorageMaintenanceKind, StorageMaintenanceReceipt } from "./storage.js";
import type { StorageSeverity } from "./storage-guidance.js";
/**
 * Bounded storage events timeline (`GET /api/storage/events`), version 1.
 * Events are recorded at their source when they happen and are never
 * reconstructed from later evidence. `seq` is the recording order and the
 * `since` continuation; `at` is the event's own time, so two distinct events
 * can share an `at` but never a `seq`.
 */
export type StorageEventKind = "pressure" | "refusal" | "scope" | "maintenance";
interface StorageEventBase { seq: number; at: number }
/** One step of a warning episode on a capacity. `episode` is the `seq` of the episode's `start`. */
export interface StoragePressureEvent extends StorageEventBase {
  kind: "pressure"; identity: string;
  /** `start` leaves Observed, `step` changes severity, `end` returns to Observed. */
  phase: "start" | "step" | "recovery-started" | "end";
  /** The severity after the event; for `recovery-started`, the severity being recovered from. */
  severity: StorageSeverity;
  episode: number;
}
/** An owning operation's write refusal, or the first matching successful write after it. */
export interface StorageRefusalEvent extends StorageEventBase {
  kind: "refusal"; identity: string; phase: "refused" | "succeeded";
  target: string; resource: "bytes" | "quota" | "inodes" | "unknown";
}
/** The set of stores sharing a capacity changed. Both scopes are opaque digests. */
export interface StorageScopeEvent extends StorageEventBase {
  kind: "scope"; identity: string; phase: "changed"; rootScope: string; previousRootScope: string;
}
/**
 * A maintenance receipt of the current principal, as `GET /api/storage/maintenance/:id`
 * returns it. `receipt` is that receipt's `id`; match runs by it, never by time.
 */
export type StorageMaintenanceEvent = StorageEventBase & { kind: "maintenance"; receipt: string; operation: StorageMaintenanceKind } & (
  | { phase: "requested" }
  | { phase: "finished"; state: Exclude<StorageMaintenanceReceipt["state"], "waiting" | "running">; reason: string | null }
);
export type StorageEvent = StoragePressureEvent | StorageRefusalEvent | StorageScopeEvent | StorageMaintenanceEvent;
export interface StorageEventsResponse {
  version: 1;
  /** The request's `since`, or 0. */
  since: number;
  /** The greatest `seq` in `events`, or `since` when there are none. Pass it as the next `since`. */
  next: number;
  /** Retained events per kind. A full kind stops recording and keeps every earlier event. */
  limits: { pressure: 256; refusal: 128; scope: 64; maintenance: 512; payloadBytes: 262144 };
  /**
   * True when a kind has reached its limit, or when more owner reports reached one
   * history write than the timeline keeps (refusal and pressure): later events of
   * that kind were not recorded.
   */
  paused: Record<StorageEventKind, boolean>;
  /** In `seq` order. Maintenance events carry no identity and are returned for every `identity`. */
  events: StorageEvent[];
}
