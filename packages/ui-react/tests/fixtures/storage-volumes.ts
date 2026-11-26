import type {
  StorageCapacityEvidence,
  StorageCapacityView,
  StorageGuidanceResponse,
  StorageHistoryObservation,
  StorageHistoryResponse,
  StorageMaintenanceObservation,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StoragePressureView,
  StorageRoot,
  StorageScenario,
  StorageSeverity,
  StorageSnapshot,
  StorageTreeNode,
  StorageTreePage,
} from "@schlessera/brain-ui-sdk/protocol";

/** The pinned Odysseus day: 12 July 2026, 09:41 UTC. */
export const worldTime = Date.UTC(2026, 6, 12, 9, 41);
export const DAY = 86_400_000,
  HOUR = 3_600_000,
  GB = 1_000_000_000;
export const hex = (n: number) => n.toString(16).padStart(32, "0");

/** Volume ids: Ithaca's brain disk, the Phaeacian app disk, Circe's memory, an unknown. */
export const ITHACA = hex(0xa1),
  SCHERIA = hex(0xa2),
  AEAEA = hex(0xa3),
  OGYGIA = hex(0xa4);

export function root(
  id: number,
  label: string,
  category: StorageRoot["category"],
  owner: StorageRoot["owner"],
  allocated: number | null,
  extra: Partial<StorageRoot> = {}
): StorageRoot {
  return {
    id: hex(id),
    label,
    category,
    owner,
    logical: allocated,
    allocated,
    coverage: allocated === null ? "unknown" : "complete",
    reason: null,
    ...extra,
  };
}

export function capacity(
  id: string,
  rootIds: string[],
  total: number | null,
  available: number | null,
  extra: Partial<StorageCapacityView> = {}
): StorageCapacityView {
  const free = available === null ? null : available + total! / 20;
  return {
    id,
    rootIds,
    total,
    used: total === null || free === null ? null : total - free,
    free,
    available,
    provenance: "statfs",
    kind: "filesystem",
    identity: "resolved",
    quota: null,
    measured: null,
    other: null,
    reason: "shared-extent-partition-unknown",
    ...extra,
  };
}

/** Ithaca's brain files, Git store and index share a disk with the (larger) voyage transcripts. */
export const brainRoots = [
  root(1, "Brain files", "content", "brain", 4 * GB),
  root(2, "Git store", "git", "brain", 2 * GB),
  root(3, "Content index", "index", "brain", 1 * GB),
  root(4, "Voyage transcripts", "transcripts", "app", 30 * GB),
];
/** Scheria's operational database, its sidecars and the app journal. */
export const appRoots = [
  root(5, "App journal", "journal", "app", 3 * GB),
  root(6, "Operational database", "database", "app", 5 * GB),
  root(7, "Operational database-wal", "database", "app", 400_000_000),
  root(8, "Operational database-shm", "database", "app", null, { reason: "metadata-unavailable" }),
];
export const memoryRoots = [root(9, "Temporary files", "temporary", "app", 200_000_000)];
export const unknownRoots = [root(10, "Native retained store", "native", "app", null, { reason: "unsupported-platform" })];

export function inventory(
  capacities: StorageCapacityView[],
  roots: StorageRoot[],
  errors: StorageSnapshot["errors"] = []
): StorageSnapshot {
  return {
    id: "odysseus-scan",
    startedAt: worldTime - 1000,
    observedAt: worldTime,
    staleAfter: worldTime + 60_000,
    coverage: "partial",
    consistency: "live-observation",
    basis: "512 * st_blocks; shared extents may be charged more than once",
    roots,
    capacities,
    totals: {
      all: { logical: null, allocated: null, coverage: "partial" },
      brain: { logical: null, allocated: null, coverage: "partial" },
      app: { logical: null, allocated: null, coverage: "partial" },
      operator: { logical: null, allocated: null, coverage: "partial" },
    },
    entries: 0,
    errors,
    omittedErrors: 0,
  };
}

export const finite = (days: number, spanDays: number, at = worldTime): StorageScenario => ({
  state: "finite",
  reason: null,
  start: at - spanDays * DAY,
  end: at,
  samples: 12,
  depletionPerDay: 1_000_000,
  days,
});
export const flat = (spanDays: number, at = worldTime): StorageScenario => ({
  state: "non-depleting",
  reason: null,
  start: at - spanDays * DAY,
  end: at,
  samples: 12,
  depletionPerDay: null,
  days: null,
});
export const unavailable = (reason: StorageScenario["reason"]): StorageScenario => ({
  state: "unavailable",
  reason,
  start: null,
  end: null,
  samples: 0,
  depletionPerDay: null,
  days: null,
});

export function evidence(
  identity: string,
  total: number | null,
  available: number | null,
  extra: Partial<StorageCapacityEvidence> = {}
): StorageCapacityEvidence {
  return {
    identity,
    rootScope: `${identity.slice(0, 8)}${"e".repeat(24)}`,
    at: worldTime,
    total,
    available,
    fresh: true,
    short: finite(20, 7),
    long: unavailable("insufficient-span"),
    appLogical: null,
    appAllocated: null,
    availableChange: { start: worldTime - 2 * DAY, end: worldTime, samples: 9, bytesPerDay: -1_200_000_000 },
    ...extra,
  };
}

export function pressure(
  identity: string,
  severity: StorageSeverity,
  value: StorageCapacityEvidence | null,
  extra: Partial<StoragePressureView> = {}
): StoragePressureView {
  return {
    identity,
    rootScope: value?.rootScope ?? "f".repeat(32),
    severity,
    at: worldTime,
    state: "current",
    scopeChanged: false,
    recoveryAt: null,
    episode: severity === "observed" ? null : `${identity.slice(-4)}-episode`,
    causes: { capacity: severity !== "observed", forecast: false, refusals: [] },
    stores: [],
    evidence: value,
    ...extra,
  };
}

export function guidance(capacities: StoragePressureView[], extra: Partial<StorageGuidanceResponse> = {}): StorageGuidanceResponse {
  const severity = capacities.some((value) => value.severity === "critical")
    ? "critical"
    : capacities.some((value) => value.severity === "low")
    ? "low"
    : capacities.length
    ? "observed"
    : null;
  return {
    version: 1,
    state: capacities.every((value) => value.state === "current") ? "current" : "unknown",
    severity,
    paused: null,
    pending: false,
    observedAt: worldTime,
    scopeLimit: false,
    capacities,
    untracked: [],
    notifications: {
      permission: "browser-managed",
      quietHours: { start: 22, end: 8, unknownZone: "defer" },
      subscriptionsTruncated: false,
      receiptsTruncated: false,
      subscriptions: [],
      receipts: [],
    },
    ...extra,
  };
}

/**
 * Two volumes: Ithaca's brain disk (161 GB, Low) and Scheria's app data disk
 * (250 GB, Very low). Every figure differs, so a sum of any two is unique.
 */
export function twoVolumes() {
  const brain = capacity(ITHACA, brainRoots.map((value) => value.id), 161 * GB, 16_400_000_000);
  const app = capacity(SCHERIA, appRoots.map((value) => value.id), 250 * GB, 11_700_000_000);
  const snapshot = inventory([brain, app], [...brainRoots, ...appRoots]);
  const response = guidance([
    pressure(ITHACA, "low", evidence(ITHACA, brain.total, brain.available)),
    pressure(SCHERIA, "critical", evidence(SCHERIA, app.total, app.available, { short: finite(6, 7), long: finite(9, 30) })),
  ]);
  return { brain, app, inventory: snapshot, guidance: response };
}

export function observation(
  tier: StorageHistoryObservation["tier"],
  at: number,
  capacities: Array<{ identity: string; rootScope?: string; available: number | null; app: number | null; total?: number }>,
  gap = false
): StorageHistoryObservation {
  return {
    tier,
    gap,
    at,
    startedAt: at - 1000,
    source: "scheduled",
    collector: "0.44.0",
    scope: "d".repeat(32),
    basis: "storage-v1",
    coverage: "complete",
    reason: "none",
    capacities: capacities.map((value) => ({
      identity: value.identity,
      rootScope: value.rootScope ?? `${value.identity.slice(0, 8)}${"e".repeat(24)}`,
      total: value.total ?? 161 * GB,
      used: value.available === null ? null : (value.total ?? 161 * GB) - value.available - 1 * GB,
      free: value.available === null ? null : value.available + 1 * GB,
      available: value.available,
      coverage: "complete",
      owners: {
        brain: { logical: 7 * GB, allocated: 7 * GB },
        app: { logical: value.app, allocated: value.app },
        operator: { logical: null, allocated: null },
      },
      union: { logical: null, allocated: null },
    })),
  };
}

export function historyOf(observations: StorageHistoryObservation[]): StorageHistoryResponse {
  return {
    version: 1,
    state: "available",
    paused: null,
    pending: false,
    lastObservedAt: worldTime,
    payloadBytes: 4096,
    limits: { sixHour: 64, daily: 90, weekly: 32, capacities: 4, payloadBytes: 262144 },
    observations,
  };
}

export function observe(capacities: StorageCapacityView[], stores: StorageRoot[], at = worldTime): StorageMaintenanceObservation {
  return {
    observedAt: at,
    coverage: "complete",
    basis: "512 * st_blocks; shared extents may be charged more than once",
    stores,
    capacities,
    attribution: "concurrent-writers-possible",
  };
}

export function receipt(extra: Partial<StorageMaintenanceReceipt> = {}): StorageMaintenanceReceipt {
  return {
    id: "pack-ithaca",
    operation: "pack-git",
    owner: "core",
    scope: ["git"],
    requestedAt: worldTime - 3 * HOUR,
    startedAt: worldTime - 3 * HOUR,
    completedAt: worldTime - 2 * HOUR,
    state: "complete",
    reason: null,
    headroom: { requiredBytes: null, packingRequiredBytes: 2_100_000_000, reservation: false, note: "Not reserved." },
    before: null,
    after: null,
    outcome: null,
    ...extra,
  };
}

export function packRow(latest: StorageMaintenanceReceipt | null, extra: Partial<StorageMaintenanceRow> = {}): StorageMaintenanceRow {
  return {
    id: "pack-git",
    label: "Pack Git objects",
    owner: "core",
    scope: ["git"],
    effect: "Pack local objects and refs; history and reflogs remain.",
    available: true,
    reason: null,
    headroom: { requiredBytes: null, packingRequiredBytes: null, reservation: false, note: "Not reserved." },
    latest,
    ...extra,
  };
}

export function node(
  value: StorageRoot | { id: number; rootId: number; name: string; kind: StorageTreeNode["kind"]; owner: StorageRoot["owner"]; bytes: number | null; coverage?: StorageRoot["coverage"]; reason?: string | null }
): StorageTreeNode {
  if ("label" in value) {
    const area = { logical: value.logical, allocated: value.allocated, coverage: value.coverage };
    return { id: value.id, rootId: value.id, entry: null, path: "", name: value.label, kind: "root", owner: value.owner, totals: area, area, reason: value.reason };
  }
  const area = { logical: value.bytes, allocated: value.bytes, coverage: value.coverage ?? (value.bytes === null ? "unknown" : "complete") };
  return {
    id: hex(value.id),
    rootId: hex(value.rootId),
    entry: null,
    path: value.name,
    name: value.name,
    kind: value.kind,
    owner: value.owner,
    totals: area,
    area,
    reason: value.reason ?? null,
  };
}

export function page(nodes: StorageTreeNode[], parentId: string | null = null): StorageTreePage {
  return {
    scanId: "odysseus-scan",
    parentId,
    name: parentId ? "Folder" : "All stores",
    breadcrumbs: [{ id: null, name: "All stores" }],
    nodes,
    totals: { logical: null, allocated: null, coverage: "partial" },
    matched: nodes.length,
    nextCursor: null,
    stale: false,
  };
}
