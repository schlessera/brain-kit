import type { StorageMaintenanceObservation } from "./storage.js";
/** Exact canonical attachment selections. Roots, versions and recovery locations remain server-owned. */
export interface StorageRemovalReviewRequest { id: string; paths: string[] }
export interface StorageRemovalStartRequest { id: string; fingerprint: string }
export interface StorageRemovalUndoRequest { id: string; sourceId: string; paths: string[] }
export interface StorageRemovalFile {
  path: string; bytes: number | null; hash: string | null; eligible: boolean; reason: string | null;
  git: "tracked" | "untracked" | "ignored" | "no-repository" | "unknown";
  references: { source: string; certainty: "resolved" | "possible" }[];
  recovery: "requires-retention" | "retained" | "unavailable";
}
/** Read-only current facts; no durable operation identity or authority to confirm. */
export interface StorageRemovalInspection { observedAt: number; files: StorageRemovalFile[]; complete: boolean; unchecked: string[]; selectedFileBytes: number }
export interface StorageRemovalReview {
  id: string; action: "remove" | "undo"; sourceId: string | null; fingerprint: string;
  observedAt: number; expiresAt: number; files: StorageRemovalFile[];
  complete: boolean; unchecked: string[]; selectedFileBytes: number;
}
export interface StorageRemovalItem {
  path: string;
  state: "not-started" | "applying" | "removed" | "restored" | "changed" | "protected" | "failed" | "unknown";
  reason: string | null; undoAvailable: boolean; undoReason: string | null;
}
export interface StorageRemovalReceipt {
  review: StorageRemovalReview;
  state: "review" | "waiting" | "running" | "complete" | "partial" | "refused" | "cancelled" | "unknown";
  requestedAt: number; startedAt: number | null; completedAt: number | null; reason: string | null;
  items: StorageRemovalItem[];
  before: StorageMaintenanceObservation | null; after: StorageMaintenanceObservation | null;
  index: "not-requested" | "complete" | "unavailable";
  commit: "not-requested"; sync: "not-requested";
  retained: { journal: "subject-to-retention"; git: "unchanged-by-operation"; backups: "not-measured" };
}
export interface StorageRemovalCapability {
  latest: StorageRemovalReceipt | null;
  available: boolean; reason: string | null;
  limits: { items: number; fileBytes: number; totalBytes: number; milliseconds: number; reviewMilliseconds: number; receiptBytes: number; receipts: number };
}
