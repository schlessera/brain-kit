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
