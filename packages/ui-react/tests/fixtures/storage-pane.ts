import type {
  StorageCapacityView,
  StorageGuidanceResponse,
  StorageHistoryObservation,
  StorageHistoryResponse,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StoragePressureView,
  StorageScenario,
} from "@schlessera/brain-ui-sdk/protocol";
import { storageViewFixture, type StorageScene } from "./storage-view.js";

/** The pinned Odysseus clock, as the inventory fixture's. */
export const paneTime = Date.UTC(2026, 6, 12, 9, 41);
const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  GB = 1_000_000_000;

export type PaneState = "healthy" | "low" | "very-low";
export type ChartState = "full" | "gap" | "no-projection" | "one-window" | "two-windows" | "scope-change";

const AVAILABLE: Record<PaneState, number> = { healthy: 48.2 * GB, low: 16.4 * GB, "very-low": 7.2 * GB };
const SEVERITY: Record<PaneState, StoragePressureView["severity"]> = { healthy: "observed", low: "low", "very-low": "critical" };

/**
 * The composed pane's synthetic walkthrough (#4549): the inventory fixture's
 * stores on two volumes — a 161 GB data volume holding the brain and App
 * stores, and a 250 GB disk holding Operator backups — with guidance,
 * history and maintenance that agree with it. Capacities are separate; the
 * fixture never sums them.
 */
export function storagePaneFixture({
  state = "low",
  chart = "two-windows",
  scene = "dense",
  alerts = "on",
}: {
  state?: PaneState;
  chart?: ChartState;
  scene?: StorageScene;
  alerts?: "on" | "quiet" | "unknown-zone" | "none";
} = {}) {
  const inventory = storageViewFixture(scene);
  const at = paneTime;
  const snapshot = inventory.snapshot;
  const data = snapshot.capacities[0]!;
  const backups = snapshot.roots.find((root) => root.category === "backup")!;
  const available = AVAILABLE[state];
  Object.assign(data, {
    rootIds: snapshot.roots.filter((root) => root.id !== backups.id).map((root) => root.id),
    total: 161 * GB,
    free: available + 1.6 * GB,
    used: 161 * GB - (available + 1.6 * GB),
    available,
  } satisfies Partial<StorageCapacityView>);
  const disk: StorageCapacityView = {
    ...data,
    id: "e".repeat(32),
    rootIds: [backups.id],
    total: 250 * GB,
    used: 200 * GB,
    free: 50 * GB,
    available: 48.2 * GB,
  };
  if (scene !== "separate") snapshot.capacities.splice(1, snapshot.capacities.length, disk);
  const scope = "b".repeat(32),
    earlier = "d".repeat(32);
  const finite = (window: "short" | "long", days: number): StorageScenario => ({
    state: "finite",
    reason: null,
    start: at - (window === "short" ? 7 : 30) * DAY,
    end: at,
    samples: window === "short" ? 28 : 120,
    depletionPerDay: available / days,
    days,
  });
  const unavailable = (reason: StorageScenario["reason"]): StorageScenario => ({
    state: "unavailable",
    reason,
    start: null,
    end: null,
    samples: 0,
    depletionPerDay: null,
    days: null,
  });
  const short = chart === "no-projection" ? unavailable("gap") : finite("short", state === "healthy" ? 60 : state === "low" ? 14 : 5);
  const long =
    chart === "two-windows" || chart === "full" || chart === "gap"
      ? finite("long", state === "healthy" ? 90 : state === "low" ? 41 : 12)
      : unavailable(chart === "no-projection" ? "gap" : "insufficient-span");
  const flat = (window: "short" | "long"): StorageScenario => ({ ...finite(window, 1), state: "non-depleting", days: null, depletionPerDay: null });
  const evidence = (identity: string, total: number, value: number) => ({
    identity,
    rootScope: scope,
    at,
    total,
    available: value,
    fresh: true,
    short: identity === data.id ? short : flat("short"),
    long: identity === data.id ? long : flat("long"),
    appAllocated: { start: at - 7 * DAY, end: at, samples: 28, bytesPerDay: 0.49 * GB },
    appLogical: { start: at - 7 * DAY, end: at, samples: 28, bytesPerDay: 0.47 * GB },
    availableChange: { start: at - 7 * DAY, end: at, samples: 28, bytesPerDay: identity === data.id ? -1.2 * GB : -0.1 * GB },
  });
  const pressure = (identity: string, severity: StoragePressureView["severity"], total: number, value: number, labels: string[], refused: boolean): StoragePressureView => ({
    identity,
    rootScope: scope,
    severity,
    at,
    state: "current",
    scopeChanged: chart === "scope-change" && identity === data.id,
    recoveryAt: null,
    episode: severity === "observed" ? null : "ithaca-episode",
    causes: {
      capacity: severity !== "observed",
      forecast: false,
      refusals: refused ? [{ target: "c".repeat(32), resource: "bytes", at: at - 9 * HOUR, successAt: null }] : [],
    },
    stores: labels.map((label) => ({ label, owner: "app" as const })),
    evidence: evidence(identity, total, value),
  });
  const guidance: StorageGuidanceResponse = {
    version: 1,
    state: "current",
    severity: SEVERITY[state],
    paused: null,
    pending: false,
    observedAt: at,
    scopeLimit: false,
    untracked: [],
    capacities: [
      pressure(data.id, SEVERITY[state], 161 * GB, available, ["Brain files", "App journal"], state === "very-low"),
      pressure(disk.id, "observed", 250 * GB, 48.2 * GB, ["Backups"], false),
    ],
    notifications: {
      permission: "browser-managed",
      quietHours: { start: 22, end: 8, unknownZone: "defer" },
      subscriptionsTruncated: false,
      receiptsTruncated: false,
      subscriptions:
        alerts === "none"
          ? []
          : [{ zoneKnown: alerts !== "unknown-zone", quiet: alerts === "unknown-zone" ? null : alerts === "quiet" }],
      receipts: state === "very-low" ? [{ episode: "ithaca-episode", state: "accepted", attempts: 1, nextAt: null }] : [],
    },
  };
  // Sixteen days of six-hour endpoints, falling to today's figure.
  const capacity = (identity: string, total: number, value: number | null, rootScope: string, ago = 0) => ({
    identity,
    rootScope,
    coverage: "complete" as const,
    total,
    used: value === null ? null : total - value - 1.6 * GB,
    free: value === null ? null : value + 1.6 * GB,
    available: value,
    owners: {
      brain: { logical: 2.0 * GB, allocated: 2.1 * GB },
      app: { logical: 23.0 * GB - (ago / DAY) * 0.47 * GB, allocated: 24.0 * GB - (ago / DAY) * 0.49 * GB },
      operator: { logical: 3.0 * GB, allocated: 3.0 * GB },
    },
    union: { logical: 28.0 * GB, allocated: 29.1 * GB },
  });
  const value = (ago: number) => available + (ago / (16 * DAY)) * 22 * GB + Math.sin(ago / DAY) * 0.6 * GB;
  const observation = (tier: StorageHistoryObservation["tier"], ago: number, gap = false): StorageHistoryObservation => ({
    tier,
    at: at - ago,
    startedAt: at - ago - 1000,
    gap,
    source: "scheduled",
    collector: "0.46.0",
    scope,
    basis: "storage-v1",
    coverage: "complete",
    reason: "none",
    capacities: gap
      ? []
      : [
          capacity(data.id, 161 * GB, value(ago), chart === "scope-change" && ago > 6 * DAY ? earlier : scope, ago),
          capacity(disk.id, 250 * GB, 48.2 * GB + ago / DAY * 0.1 * GB, scope),
        ],
  });
  const gapAt = (ago: number) => chart !== "full" && ago >= 9 * DAY && ago < 10 * DAY;
  const observations: StorageHistoryObservation[] = [
    ...Array.from({ length: 64 }, (_, i) => observation("six-hour", (63 - i) * 6 * HOUR + 7 * 60_000, gapAt((63 - i) * 6 * HOUR))),
    ...Array.from({ length: 16 }, (_, i) => observation("daily", (15 - i) * DAY + 7 * 60_000, gapAt((15 - i) * DAY))),
    ...Array.from({ length: 3 }, (_, i) => observation("weekly", (2 - i) * 7 * DAY + 7 * 60_000)),
  ];
  const history: StorageHistoryResponse = {
    version: 1,
    state: "available",
    paused: null,
    pending: false,
    lastObservedAt: at,
    payloadBytes: 48_213,
    limits: { sixHour: 64, daily: 90, weekly: 32, capacities: 4, payloadBytes: 262144 },
    observations,
  };
  const headroom = { requiredBytes: null, packingRequiredBytes: null, reservation: false, note: "Can grow before it shrinks; needs headroom." };
  const observe = (value: number) => ({
    observedAt: at - 30 * HOUR,
    coverage: "complete" as const,
    basis: snapshot.basis,
    stores: [snapshot.roots[1]!],
    capacities: [{ ...data, available: value }],
    attribution: "concurrent-writers-possible" as const,
  });
  const receipt = (operation: StorageMaintenanceReceipt["operation"], state: StorageMaintenanceReceipt["state"], ago: number, extra: Partial<StorageMaintenanceReceipt> = {}): StorageMaintenanceReceipt => ({
    id: `${operation}-receipt`,
    operation,
    owner: operation === "pack-git" ? "core" : "inbox",
    scope: operation === "pack-git" ? ["git"] : ["scratch"],
    requestedAt: at - ago,
    startedAt: at - ago,
    completedAt: at - ago + 60_000,
    state,
    reason: null,
    headroom: { ...headroom, packingRequiredBytes: operation === "pack-git" ? 6.8 * GB : null },
    before: observe(available - (operation === "pack-git" ? 1.8 : 0.6) * GB),
    after: observe(available),
    outcome: null,
    ...extra,
  } as StorageMaintenanceReceipt);
  const operations: StorageMaintenanceRow[] = [
    {
      id: "pack-git",
      label: "Pack Git history",
      owner: "core",
      scope: ["git"],
      effect: "Packs loose Git objects into one file per store.",
      available: true,
      reason: null,
      headroom,
      latest:
        state === "very-low"
          ? receipt("pack-git", "refused", 9 * HOUR, { reason: "not enough free space to pack", before: null, after: null, completedAt: at - 9 * HOUR })
          : receipt("pack-git", "complete", 6 * HOUR + 31 * 60_000),
    },
    {
      id: "prune-scratch",
      label: "Prune scratch answers",
      owner: "inbox",
      scope: ["scratch"],
      effect: "Prunes scratch answers.",
      available: true,
      reason: null,
      headroom,
      latest: receipt("prune-scratch", "complete", 11 * HOUR + 41 * 60_000),
    },
    {
      id: "cleanup-staging",
      label: "Clean up staging",
      owner: "inbox",
      scope: ["staging"],
      effect: "Deletes abandoned upload staging files.",
      available: true,
      reason: null,
      headroom,
      latest: null,
    },
  ] as StorageMaintenanceRow[];
  const reads: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://fixture.invalid").pathname;
    const method = init?.method ?? "GET";
    if (path.endsWith("/guidance") || path.endsWith("/history")) {
      reads.push(path);
      return Response.json(structuredClone(path.endsWith("/guidance") ? guidance : history));
    }
    if (path === "/api/storage/maintenance" && method === "GET") return Response.json({ operations: structuredClone(operations) });
    return inventory.request(url, init);
  };
  return { inventory, guidance, history, operations, request, reads };
}
