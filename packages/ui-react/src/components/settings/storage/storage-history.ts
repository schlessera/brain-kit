/**
 * History chart view models (#4546, #4537 D3/D9): one series per volume
 * identity and tier, its scenario lines and its client-side markers, as the
 * `HistoryChart`, `Sparkline` and `EventList` props take them.
 *
 * Gaps stay gaps (`null`), never zeros. A point measured under another root
 * scope is marked `otherScope`, so the chart breaks the line there. Scenario
 * lines come only from qualified windows; an unavailable window draws no
 * line and passes its reason through.
 */
import type {
  StorageEvidenceReason,
  StorageHistoryResponse,
  StorageHistoryTier,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StoragePressureView,
  StorageScenario,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  projectionReasonText,
  type HistoryMarker,
  type HistoryPoint,
  type HistoryScenario,
  type HistoryThresholds,
} from "@schlessera/brain-ui-kit";
import { DAY_MS, storageFormat, thresholdBytes, type StorageFormat } from "./storage-volumes.js";

const HOUR_MS = 3_600_000;
/**
 * Each tier's bucket, as the server buckets observations
 * (`bucket`, `packages/ui-server/src/storage/history-model.ts:30-31`):
 * six hours, a day, and a week that starts four days after the epoch.
 */
export const STORAGE_TIER_BUCKET: Readonly<
  Record<StorageHistoryTier, { interval: number; offset: number; label: string }>
> = Object.freeze({
  "six-hour": { interval: 6 * HOUR_MS, offset: 0, label: "6 h" },
  daily: { interval: DAY_MS, offset: 0, label: "1 day" },
  weekly: { interval: 7 * DAY_MS, offset: 4 * DAY_MS, label: "1 week" },
});
const bucketOf = (tier: StorageHistoryTier, at: number) =>
  Math.floor((at - STORAGE_TIER_BUCKET[tier].offset) / STORAGE_TIER_BUCKET[tier].interval);

interface StorageSeriesPoint {
  at: number;
  /** Caller-available bytes; `null` for a gap or an unmeasured value. */
  available: number | null;
  /** App stores' on-disk bytes; `null` when not measured. */
  appAllocated: number | null;
  /** The tier recorded no comparable observation of this volume for the bucket. */
  gap: boolean;
  /** The current bucket, still filling. */
  provisional: boolean;
  /** Measured under another root scope than the latest point. */
  otherScope: boolean;
  /**
   * The root scope the observation records for this volume, also on a gap:
   * the server records the observation that sees a new scope as a gap.
   * `null` when the observation holds no capacity for the volume.
   */
  rootScope: string | null;
}

/**
 * One volume's series for one tier, oldest first. An observation that does
 * not hold this identity is a gap for it: the volume was not measured then.
 */
export function storageSeries(
  history: StorageHistoryResponse | null | undefined,
  identity: string,
  tier: StorageHistoryTier,
  now: number
): StorageSeriesPoint[] {
  const rows = (history?.observations ?? []).filter((row) => row.tier === tier).sort((a, b) => a.at - b.at);
  const held = rows.map((row) => ({
    row,
    capacity: row.capacities.find((value) => value.identity === identity) ?? null,
  }));
  // A scope is known from any observation holding the volume, measured or not.
  const latestScope = held.filter((value) => value.capacity).at(-1)?.capacity?.rootScope ?? null;
  return held.map(({ row, capacity }, index) => {
    const measured = !row.gap && capacity ? capacity : null;
    return {
      at: row.at,
      available: measured ? measured.available : null,
      appAllocated: measured ? measured.owners.app.allocated : null,
      gap: !measured,
      provisional: index === held.length - 1 && bucketOf(tier, row.at) === bucketOf(tier, now),
      otherScope: !!measured && latestScope !== null && measured.rootScope !== latestScope,
      rootScope: capacity?.rootScope ?? null,
    };
  });
}

const point = (value: StorageSeriesPoint, of: number | null): HistoryPoint => {
  const result: HistoryPoint = { at: value.at, value: of };
  if (value.provisional) result.provisional = true;
  if (value.otherScope) result.otherScope = true;
  return result;
};
/** The chart's available-space points. */
export function availablePoints(series: readonly StorageSeriesPoint[]): HistoryPoint[] {
  return series.map((value) => point(value, value.available));
}
/** The "What this app added" sparkline's points. */
export function appPoints(series: readonly StorageSeriesPoint[]): HistoryPoint[] {
  return series.map((value) => point(value, value.appAllocated));
}

/** The chart's Low and Very-low bands, in this volume's bytes; empty when its total is unknown. */
export function historyThresholds(total: number | null): HistoryThresholds {
  return thresholdBytes(total) ?? {};
}

/**
 * The windows' nominal spans, as the server qualifies them
 * (`capacityEvidence`, `packages/ui-server/src/storage/history-evidence.ts:79-91`).
 * Only an unavailable window, which has no real span, is named by these.
 */
const NOMINAL_DAYS = { short: 7, long: 30 } as const;
function reasonText(reason: StorageEvidenceReason | null, window: "short" | "long"): string {
  if (!reason) return "no projection";
  return projectionReasonText(
    reason,
    reason === "gap" || reason === "insufficient-span" ? NOMINAL_DAYS[window] : undefined
  );
}

/**
 * One line per qualified window (D9), short then long. A finite window heads
 * to empty at its days to exhaustion; a non-depleting one runs flat across
 * its own span. An unavailable window, or one whose latest figure is
 * unknown, has no `to` and carries its reason.
 */
export function storageScenarios(
  pressure: StoragePressureView | null | undefined,
  format: StorageFormat = storageFormat()
): HistoryScenario[] {
  const evidence = pressure?.scopeChanged ? null : pressure?.evidence ?? null;
  return (["short", "long"] as const).map((window): HistoryScenario => {
    const nominal = `${NOMINAL_DAYS[window]}-day`;
    if (!evidence) {
      const reason: StorageEvidenceReason = pressure?.scopeChanged ? "changed-scope" : "no-observation";
      return { window, name: nominal, reason: reasonText(reason, window) };
    }
    const scenario: StorageScenario = evidence[window];
    if (scenario.state === "unavailable" || scenario.start === null || scenario.end === null)
      return { window, name: nominal, reason: reasonText(scenario.reason, window) };
    if (evidence.available === null)
      return { window, name: nominal, reason: reasonText("incomplete", window) };
    const span = Math.max(1, Math.round((scenario.end - scenario.start) / DAY_MS));
    const name = `${span}-day`;
    if (scenario.state === "finite") {
      if (scenario.days === null) return { window, name, reason: reasonText("arithmetic", window) };
      const at = evidence.at + scenario.days * DAY_MS;
      return { window, name, detail: `empty ~${format.day(at)}`, to: { at, value: 0 } };
    }
    return {
      window,
      name,
      detail: "not running out",
      to: { at: evidence.at + (scenario.end - scenario.start), value: evidence.available },
    };
  });
}

const RUN_WORD: Record<StorageMaintenanceReceipt["state"], string> = {
  waiting: "waiting",
  running: "running",
  complete: "done",
  partial: "partly done",
  refused: "refused",
  cancelled: "cancelled",
  unknown: "outcome unknown",
};
const RUN_TONE: Record<StorageMaintenanceReceipt["state"], NonNullable<HistoryMarker["tone"]>> = {
  waiting: "neutral",
  running: "amber",
  complete: "teal",
  partial: "gold",
  refused: "red",
  cancelled: "neutral",
  unknown: "gold",
};
const RESOURCE: Record<StoragePressureView["causes"]["refusals"][number]["resource"], string> = {
  bytes: "no space",
  quota: "quota reached",
  inodes: "no file slots",
  unknown: "resource unknown",
};

/** Whether a maintenance run observed this volume. */
const touches = (receipt: StorageMaintenanceReceipt, identity: string) =>
  [receipt.before, receipt.after].some((observation) =>
    observation?.capacities.some((capacity) => capacity.id === identity)
  );

/**
 * Markers from data the pane already has: one per gap run and scope change
 * in the series, each owner refusal on the record, and each operation's
 * latest run on this volume. Only markers inside the series' span (to `now`)
 * are kept, numbered in time order.
 */
export function storageMarkers(input: {
  series: readonly StorageSeriesPoint[];
  identity: string;
  pressure?: StoragePressureView | null;
  maintenance?: readonly StorageMaintenanceRow[];
  now: number;
  format?: StorageFormat;
}): HistoryMarker[] {
  const format = input.format ?? storageFormat();
  const { series } = input;
  if (!series.length) return [];
  const from = series[0]!.at,
    to = Math.max(series.at(-1)!.at, input.now);
  const found: Array<Omit<HistoryMarker, "n">> = [];
  // Scope transitions are tracked apart from measured points: the observation
  // that sees a new scope is itself a gap.
  let scope: string | null = null;
  series.forEach((value, index) => {
    const previous = series[index - 1];
    if (value.gap && !previous?.gap)
      found.push({ at: value.at, tone: "neutral", time: format.time(value.at), label: "Collection gap" });
    if (value.rootScope === null) return;
    if (scope !== null && value.rootScope !== scope)
      found.push({ at: value.at, tone: "purple", time: format.time(value.at), label: "Scope changed" });
    scope = value.rootScope;
  });
  for (const refusal of input.pressure?.causes.refusals ?? [])
    found.push({
      at: refusal.at,
      tone: "red",
      time: format.time(refusal.at),
      label: `Owner refused a write: ${RESOURCE[refusal.resource]}`,
    });
  for (const row of input.maintenance ?? []) {
    const receipt = row.latest;
    if (!receipt || !touches(receipt, input.identity)) continue;
    const at = receipt.completedAt ?? receipt.startedAt ?? receipt.requestedAt;
    found.push({ at, tone: RUN_TONE[receipt.state], time: format.time(at), label: `${row.label} · ${RUN_WORD[receipt.state]}` });
  }
  return found
    .filter((marker) => marker.at >= from && marker.at <= to)
    .sort((a, b) => a.at - b.at || a.label.localeCompare(b.label))
    .map((marker, index) => ({ ...marker, n: index + 1 }));
}
