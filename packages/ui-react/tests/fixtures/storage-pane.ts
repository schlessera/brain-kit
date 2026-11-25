import type {
  StorageCapacityView,
  StorageEvent,
  StorageEventsResponse,
  StorageGuidanceResponse,
  StorageHistoryObservation,
  StorageHistoryResponse,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StoragePressureEvent,
  StoragePressureView,
  StorageScenario,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  STORAGE_PRESSURE_CRITICAL_PERCENT,
  STORAGE_PRESSURE_CRITICAL_RECOVERY_PERCENT,
  STORAGE_PRESSURE_LOW_PERCENT,
  STORAGE_PRESSURE_LOW_RECOVERY_PERCENT,
  STORAGE_PRESSURE_RECOVERY_OBSERVATIONS,
} from "@schlessera/brain-ui-sdk/protocol";
import { storageViewFixture, type StorageScene } from "./storage-view.js";

/** The pinned Odysseus clock, as the inventory fixture's. */
export const paneTime = Date.UTC(2026, 6, 12, 9, 41);
const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  GB = 1_000_000_000;

/** `recovered` (#4548): the Brain disk went Low, then Very low, and is back to OK a day ago. */
export type PaneState = "healthy" | "low" | "very-low" | "recovered";
export type ChartState = "full" | "gap" | "no-projection" | "one-window" | "two-windows" | "scope-change";
/** The events timeline (#4548): an older host's 404, recorded events, the same with warnings paused, or a failure. */
export type TimelineState = "missing" | "events" | "paused" | "error";

const AVAILABLE: Record<PaneState, number> = { healthy: 48.2 * GB, low: 16.4 * GB, "very-low": 7.2 * GB, recovered: 24.6 * GB };
const SEVERITY: Record<PaneState, StoragePressureView["severity"]> = { healthy: "observed", low: "low", "very-low": "critical", recovered: "observed" };
/**
 * The recovered Brain disk's available space, as [days ago, GB] corners joined
 * by straight lines: a slow fall, a drop through Low and Very low, then a
 * climb back past Low's recovery threshold to today's figure.
 */
const RECOVERED: [number, number][] = [
  [16, 31.4],
  [5.4, 17.2],
  [4.9, 15.4],
  [3.4, 9.6],
  [2.9, 7.2],
  [2.7, 7.1],
  [2.5, 12.2],
  [2, 14.6],
  [1.4, 18.4],
  [1.2, 20.6],
  [0, AVAILABLE.recovered / GB],
];
function recovered(ago: number) {
  const days = ago / DAY;
  for (const [i, [from, high]] of RECOVERED.entries()) {
    const next = RECOVERED[i + 1];
    if (next && days <= from && days >= next[0]) return (next[1] + ((days - next[0]) / (from - next[0])) * (high - next[1])) * GB;
  }
  return RECOVERED[0]![1] * GB;
}

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
  timeline = "missing",
}: {
  state?: PaneState;
  chart?: ChartState;
  scene?: StorageScene;
  alerts?: "on" | "quiet" | "unknown-zone" | "none";
  timeline?: TimelineState;
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
  const flat = (window: "short" | "long"): StorageScenario => ({ ...finite(window, 1), state: "non-depleting", days: null, depletionPerDay: null });
  // The recovered disk climbed over the last week and still fell over thirty days.
  const trend = (days: number) => (recovered(0) - recovered(days * DAY)) / days;
  const short =
    chart === "no-projection"
      ? unavailable("gap")
      : state === "recovered"
        ? flat("short")
        : finite("short", state === "healthy" ? 60 : state === "low" ? 14 : 5);
  const long =
    chart === "two-windows" || chart === "full" || chart === "gap"
      ? finite("long", state === "recovered" ? Math.round(available / -trend(30)) : state === "healthy" ? 90 : state === "low" ? 41 : 12)
      : unavailable(chart === "no-projection" ? "gap" : "insufficient-span");
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
    availableChange: { start: at - 7 * DAY, end: at, samples: 28, bytesPerDay: identity !== data.id ? -0.1 * GB : state === "recovered" ? trend(7) : -1.2 * GB },
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
  const value = (ago: number) =>
    state === "recovered" ? recovered(ago) : available + (ago / (16 * DAY)) * 22 * GB + Math.sin(ago / DAY) * 0.6 * GB;
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
  // The Brain disk's warning, read off its six-hour series by the capacity
  // policy (#4539): Low at or below 10 % of total, Very low at or below 5 %, and
  // each step back only after consecutive observations above its recovery
  // threshold. Then the Pack run its latest receipt also reports, matched by
  // receipt id and phase.
  const share = (percent: number) => (161 * GB * percent) / 100;
  const warnings: Omit<StoragePressureEvent, "seq">[] = [];
  let severity: StoragePressureView["severity"] = "observed",
    streak = 0;
  for (const point of observations.filter((row) => row.tier === "six-hour")) {
    const space = point.capacities.find((row) => row.identity === data.id)?.available ?? null;
    if (space === null) {
      streak = 0;
      continue;
    }
    const recovery = share(severity === "critical" ? STORAGE_PRESSURE_CRITICAL_RECOVERY_PERCENT : STORAGE_PRESSURE_LOW_RECOVERY_PERCENT);
    streak = severity !== "observed" && space > recovery ? streak + 1 : 0;
    const next =
      severity === "observed" && space <= share(STORAGE_PRESSURE_LOW_PERCENT)
        ? "low"
        : severity === "low" && space <= share(STORAGE_PRESSURE_CRITICAL_PERCENT)
          ? "critical"
          : streak === STORAGE_PRESSURE_RECOVERY_OBSERVATIONS
            ? severity === "critical"
              ? "low"
              : "observed"
            : severity;
    if (next === severity) continue;
    warnings.push({ at: point.at, kind: "pressure", identity: data.id, phase: severity === "observed" ? "start" : next === "observed" ? "end" : "step", severity: next, episode: 1 });
    severity = next;
    streak = 0;
  }
  const pack = operations[0]!.latest!;
  const events: StorageEvent[] = [
    ...warnings,
    { at: pack.requestedAt, kind: "maintenance", receipt: pack.id, operation: pack.operation, phase: "requested" },
    ...(pack.completedAt === null || pack.state === "waiting" || pack.state === "running"
      ? []
      : [{ at: pack.completedAt, kind: "maintenance" as const, receipt: pack.id, operation: pack.operation, phase: "finished" as const, state: pack.state, reason: pack.reason }]),
  ].map((event, i) => ({ ...event, seq: i + 1 }) as StorageEvent);
  const eventReads: number[] = [];
  const reads: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, "http://fixture.invalid"),
      path = parsed.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/storage/events" && method === "GET" && timeline !== "missing") {
      const since = Number(parsed.searchParams.get("since") ?? 0);
      eventReads.push(since);
      if (timeline === "error") return Response.json({ error: "Synthetic failure" }, { status: 500 });
      const page = events.filter((event) => event.seq > since);
      const body: StorageEventsResponse = {
        version: 1,
        since,
        next: page.at(-1)?.seq ?? since,
        limits: { pressure: 256, refusal: 128, scope: 64, maintenance: 512, payloadBytes: 262144 },
        paused: { pressure: timeline === "paused", refusal: false, scope: false, maintenance: false },
        events: structuredClone(page),
      };
      return Response.json(body);
    }
    if (path.endsWith("/guidance") || path.endsWith("/history")) {
      reads.push(path);
      return Response.json(structuredClone(path.endsWith("/guidance") ? guidance : history));
    }
    if (path === "/api/storage/maintenance" && method === "GET") return Response.json({ operations: structuredClone(operations) });
    return inventory.request(url, init);
  };
  return { inventory, guidance, history, operations, events, eventReads, request, reads };
}
