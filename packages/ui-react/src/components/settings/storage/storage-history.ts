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
  StorageEvent,
  StorageEventKind,
  StorageEvidenceReason,
  StorageHistoryResponse,
  StorageHistoryTier,
  StorageMaintenanceReceipt,
  StorageMaintenanceRow,
  StoragePressureView,
  StorageScenario,
  StorageSeverity,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  projectionReasonText,
  type HistoryMarker,
  type HistoryPoint,
  type HistoryScenario,
  type HistoryThresholds,
} from "@schlessera/brain-ui-kit";
import type { StorageTimeline } from "./storage-timeline.js";
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
  const latestScope =
    held.filter((value) => value.capacity && !value.row.gap).at(-1)?.capacity?.rootScope ?? null;
  return held.map(({ row, capacity }, index) => {
    const measured = !row.gap && capacity ? capacity : null;
    return {
      at: row.at,
      available: measured ? measured.available : null,
      appAllocated: measured ? measured.owners.app.allocated : null,
      gap: !measured,
      provisional: index === held.length - 1 && bucketOf(tier, row.at) === bucketOf(tier, now),
      otherScope: !!measured && latestScope !== null && measured.rootScope !== latestScope,
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

const SEVERITY_WORD: Record<StorageSeverity, string> = { observed: "OK", low: "Low", critical: "Very low" };
const SEVERITY_TONE: Record<StorageSeverity, NonNullable<HistoryMarker["tone"]>> = {
  observed: "teal",
  low: "gold",
  critical: "red",
};
/**
 * The server's operation labels (`descriptors`,
 * `packages/ui-server/src/storage/maintenance.ts:16-20`), for a run whose
 * row is not loaded.
 */
const OPERATION_LABEL: Record<StorageMaintenanceRow["id"], string> = {
  "pack-git": "Pack Git objects",
  "prune-scratch": "Prune eligible scratch",
  "cleanup-staging": "Settled share staging cleanup",
};
const PAUSED_WORD: Record<StorageEventKind, string> = {
  pressure: "warnings",
  refusal: "refusals",
  scope: "scope changes",
  maintenance: "maintenance runs",
};

/** What one timeline event says, and its tone. Maintenance labels name the operation. */
export function storageEventText(
  event: StorageEvent,
  operations: readonly StorageMaintenanceRow[] = []
): { label: string; tone: NonNullable<HistoryMarker["tone"]> } {
  switch (event.kind) {
    case "pressure": {
      const word = SEVERITY_WORD[event.severity];
      if (event.phase === "start") return { label: `${word} warning started`, tone: SEVERITY_TONE[event.severity] };
      if (event.phase === "step") return { label: `Warning changed to ${word}`, tone: SEVERITY_TONE[event.severity] };
      if (event.phase === "recovery-started") return { label: `Recovery from ${word} began`, tone: "blue" };
      return { label: "Warning ended · back to OK", tone: "teal" };
    }
    case "refusal":
      return event.phase === "refused"
        ? { label: `Owner refused a write: ${RESOURCE[event.resource]}`, tone: "red" }
        : { label: `Owner write succeeded after a refusal: ${RESOURCE[event.resource]}`, tone: "teal" };
    case "scope":
      return { label: "Scope changed", tone: "purple" };
    case "maintenance": {
      const name = operations.find((row) => row.id === event.operation)?.label ?? OPERATION_LABEL[event.operation];
      return event.phase === "requested"
        ? { label: `${name} · requested`, tone: "neutral" }
        : { label: `${name} · ${RUN_WORD[event.state]}`, tone: RUN_TONE[event.state] };
    }
  }
}

/** The evidence note for kinds the timeline stopped recording; `null` when none is paused. */
export function storageTimelineNote(timeline: StorageTimeline | null | undefined): string | null {
  const kinds = (Object.keys(PAUSED_WORD) as StorageEventKind[]).filter((kind) => timeline?.paused[kind]);
  if (!kinds.length) return null;
  return `Event timeline paused for ${kinds.map((kind) => PAUSED_WORD[kind]).join(", ")} · earlier events kept; later ones are not marked`;
}

const isRun = (state: StorageMaintenanceReceipt["state"]) => state === "waiting" || state === "running";

/**
 * The chart's markers for one volume and tier, numbered in time order.
 *
 * From the data the pane already has: one per gap run and scope change in
 * the series, each owner refusal on the record, and each operation's latest
 * run on this volume. With the server's timeline (#4541), its warning
 * starts, steps, recoveries and ends, refusals and their resolutions, scope
 * changes and maintenance runs join them at the server's times, and an event
 * both report appears once:
 *
 * - a run is one marker, matched by receipt id and phase, never by time: the
 *   timeline's event wins over the latest receipt for the same phase, and a
 *   finished run hides its request. A run whose loaded receipt did not
 *   observe this volume is not drawn on it; a run the pane has no receipt
 *   for is drawn on every volume, as the timeline returns it for every one;
 * - a client refusal is dropped when the timeline's latest event for its
 *   target and resource opened it or resolved it later;
 * - a series scope change is dropped when a timeline scope change falls in
 *   the bucket it is drawn at.
 *
 * Without a timeline (an older host's 404, or any failure) the markers are
 * the client's alone. Only markers inside the series' span (to `now`) are
 * kept.
 */
export function storageMarkers(input: {
  series: readonly StorageSeriesPoint[];
  identity: string;
  pressure?: StoragePressureView | null;
  maintenance?: readonly StorageMaintenanceRow[];
  timeline?: StorageTimeline | null;
  now: number;
  format?: StorageFormat;
}): HistoryMarker[] {
  const format = input.format ?? storageFormat();
  const { series, identity } = input;
  if (!series.length) return [];
  const from = series[0]!.at,
    to = Math.max(series.at(-1)!.at, input.now);
  const timeline = (input.timeline?.events ?? []).filter((event) => event.kind === "maintenance" || event.identity === identity);
  // `seq` orders timeline events that share an `at`, as they were recorded.
  type Found = Omit<HistoryMarker, "n"> & { seq?: number };
  const found: Found[] = [];
  const add = (at: number, tone: NonNullable<HistoryMarker["tone"]>, label: string, seq?: number) =>
    found.push({ at, tone, time: format.time(at), label, ...(seq === undefined ? {} : { seq }) });

  const scopes = timeline.filter((event) => event.kind === "scope");
  series.forEach((value, index) => {
    const previous = series[index - 1];
    if (value.gap && !previous?.gap) add(value.at, "neutral", "Collection gap");
    if (
      previous &&
      !value.gap &&
      previous.otherScope &&
      !value.otherScope &&
      !scopes.some((event) => event.at > previous.at && event.at <= value.at)
    )
      add(value.at, "purple", "Scope changed");
  });

  for (const refusal of input.pressure?.causes.refusals ?? []) {
    const latest = timeline
      .filter((event) => event.kind === "refusal" && event.target === refusal.target && event.resource === refusal.resource)
      .at(-1);
    if (latest && !(latest.phase === "succeeded" && refusal.at > latest.at)) continue;
    add(refusal.at, "red", `Owner refused a write: ${RESOURCE[refusal.resource]}`);
  }

  // One run per receipt; each phase from the timeline when it has it.
  const runs = new Map<string, { requested?: Found; finished?: Found }>();
  const elsewhere = new Set<string>();
  const run = (receipt: string) => runs.get(receipt) ?? (runs.set(receipt, {}), runs.get(receipt)!);
  for (const row of input.maintenance ?? []) {
    const receipt = row.latest;
    if (!receipt) continue;
    if (!touches(receipt, identity)) {
      elsewhere.add(receipt.id);
      continue;
    }
    const at = receipt.completedAt ?? receipt.startedAt ?? receipt.requestedAt;
    run(receipt.id)[isRun(receipt.state) ? "requested" : "finished"] = {
      at,
      tone: RUN_TONE[receipt.state],
      time: format.time(at),
      label: `${row.label} · ${RUN_WORD[receipt.state]}`,
    };
  }

  for (const event of timeline) {
    if (event.kind === "maintenance") {
      if (elsewhere.has(event.receipt)) continue;
      const { label, tone } = storageEventText(event, input.maintenance);
      run(event.receipt)[event.phase] = { at: event.at, tone, time: format.time(event.at), label, seq: event.seq };
      continue;
    }
    const { label, tone } = storageEventText(event, input.maintenance);
    add(event.at, tone, label, event.seq);
  }
  for (const value of runs.values()) found.push((value.finished ?? value.requested)!);

  return found
    .filter((marker) => marker.at >= from && marker.at <= to)
    .sort((a, b) => a.at - b.at || (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.label.localeCompare(b.label))
    .map(({ seq: _seq, ...marker }, index) => ({ ...marker, n: index + 1 }));
}
