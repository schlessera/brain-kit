/** Human-only Storage HTTP contracts. No host path or credential is a wire field. */
export type StorageCoverage = "complete" | "partial" | "unknown";
export type StorageOwner = "brain" | "app" | "operator";
export interface StorageBytes { logical: number | null; allocated: number | null; coverage: StorageCoverage }
export interface StorageRoot extends StorageBytes {
  id: string; label: string; category: "content" | "git" | "index" | "database" | "staging" | "scratch" | "workspace" | "temporary" | "transcripts" | "journal" | "native" | "backup";
  owner: StorageOwner; reason: string | null;
}
export interface StorageCapacityView {
  id: string; rootIds: string[]; total: number | null; used: number | null; free: number | null; available: number | null;
  provenance: "statfs"; kind: "tmpfs" | "filesystem" | "unknown"; identity: "resolved" | "unknown"; quota: null;
  /** Shared extents cannot be partitioned into exclusive measured/other usage. */
  measured: null; other: null; reason: string | null;
}
export interface StorageFileEntry {
  id: string; parentId: string | null; rootId: string; path: string; name: string;
  kind: "file" | "directory" | "symlink" | "special";
  objectId: string; version: string; capacityId: string | null; aliasOf: string | null;
  logical: number | null; allocated: number | null; links: number;
  references: { state: "unchecked"; count: null; observedAt: null; unchecked: string[] };
}
export interface StorageSnapshot {
  id: string; startedAt: number; observedAt: number; staleAfter: number;
  coverage: StorageCoverage; consistency: "live-observation";
  basis: "512 * st_blocks; shared extents may be charged more than once";
  roots: StorageRoot[]; capacities: StorageCapacityView[];
  totals: Record<"all" | StorageOwner, StorageBytes>;
  entries: number; errors: Array<{ rootId: string; reason: string }>; omittedErrors: number;
}
export interface StorageStatus {
  version: 1; state: "idle" | "scanning"; activeScanId: string | null;
  snapshot: StorageSnapshot | null; previous: StorageSnapshot | null;
  lastFailure: { scanId: string; at: number; reason: string } | null;
  limits: { entries: number; page: number; roots: number; milliseconds: number; cacheBytes: number };
}
export interface StoragePage {
  scanId: string; entries: StorageFileEntry[]; nextCursor: string | null; stale: boolean;
  /** Logical bytes per matching regular-file entry, counting aliases individually. */
  fileLogicalTotal: number | null;
  matched: number; totals: StorageBytes;
}
export interface StorageFilter {
  search?: string; sort?: "name" | "size"; metric?: "logical" | "allocated"; direction?: "asc" | "desc";
  rootId?: string; parentId?: string; owner?: StorageOwner | "all";
  type?: "pdf"; largerThan?: number; cursor?: string;
}

export interface StorageReferenceEvidence {
  entryId: string; observedAt: number;
  state: "observed" | "unavailable";
  sources: Array<{ path: string; indexedAt: string }>;
  truncated: boolean; newestIndexedAt: string | null;
  /** Index freshness is not verified against current source bytes. */
  freshness: "unchecked"; unchecked: string[];
}

/** A cached hierarchy projection; aliases retain names while contributing area once. */
export interface StorageTreeNode {
  id: string; rootId: string; entry: StorageFileEntry | null; path: string; name: string;
  kind: "root" | "metadata" | StorageFileEntry["kind"]; owner: StorageOwner;
  totals: StorageBytes; area: StorageBytes; reason: string | null;
}
export interface StorageTreeFilter {
  parentId?: string; owner?: StorageOwner | "all"; search?: string;
  sort?: "name" | "size"; metric?: "logical" | "allocated"; direction?: "asc" | "desc"; cursor?: string;
}
export interface StorageTreePage {
  scanId: string; parentId: string | null; name: string;
  breadcrumbs: { id: string | null; name: string }[];
  nodes: StorageTreeNode[]; totals: StorageBytes; matched: number; nextCursor: string | null; stale: boolean;
}

export type StorageMaintenanceKind = "pack-git" | "prune-scratch" | "cleanup-staging";
export interface StorageMaintenanceRequest { id: string; operation: StorageMaintenanceKind }
export interface StorageMaintenanceItem { id: string; state: "running" | "cleaned" | "failed"; reason: string | null }
export interface StorageMaintenanceObservation {
  observedAt: number; coverage: StorageCoverage; basis: StorageSnapshot["basis"];
  stores: StorageRoot[];
  capacities: StorageCapacityView[];
  /** Availability deltas include other writers and are not attributed savings. */
  attribution: "concurrent-writers-possible";
}
export interface StorageMaintenanceReceipt {
  id: string; operation: StorageMaintenanceKind; owner: "core" | "inbox";
  scope: StorageRoot["category"][];
  requestedAt: number; startedAt: number | null; completedAt: number | null;
  state: "waiting" | "running" | "complete" | "partial" | "refused" | "cancelled" | "unknown";
  reason: string | null;
  headroom: { requiredBytes: null; reservation: false; note: string };
  before: StorageMaintenanceObservation | null; after: StorageMaintenanceObservation | null;
  outcome: { items: StorageMaintenanceItem[]; truncated: boolean; removed: number | null; failed: number | null; deferred: number | null; packed: number | null; pinnedFiles: number | null; pinnedBytes: number | null; overageBytes: number | null; suspended: boolean } | null;
}
export interface StorageMaintenanceRow {
  id: StorageMaintenanceKind; label: string; owner: "core" | "inbox";
  scope: StorageRoot["category"][]; effect: string;
  available: boolean; reason: string | null;
  headroom: StorageMaintenanceReceipt["headroom"];
  latest: StorageMaintenanceReceipt | null;
}
