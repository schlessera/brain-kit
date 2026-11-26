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
  StorageHistoryCapacity,
  StorageHistoryObservation,
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
import {
  DAY_MS,
  NOMINAL_WINDOW_DAYS as NOMINAL_DAYS,
  REFUSAL_RESOURCE,
  scenarioWindowName,
  storageFormat,
  thresholdBytes,
  type StorageFormat,
} from "./storage-volumes.js";

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
  /** App stores' file-size bytes; `null` when not measured. */
  appLogical: number | null;
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
  /**
   * The collection scope and the root scope together: either changing is a
   * different volume history. `null` when the observation holds no capacity.
   */
  scopeKey: string | null;
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
  const keyOf = (row: StorageHistoryObservation, capacity: StorageHistoryCapacity | null) =>
    capacity ? JSON.stringify([row.scope, capacity.rootScope]) : null;
  const latest = held.filter((value) => value.capacity).at(-1);
  const latestScope = latest ? keyOf(latest.row, latest.capacity) : null;
  return held.map(({ row, capacity }, index) => {
    const measured = !row.gap && capacity ? capacity : null;
    return {
      at: row.at,
      available: measured ? measured.available : null,
      appAllocated: measured ? measured.owners.app.allocated : null,
      appLogical: measured ? measured.owners.app.logical : null,
      gap: !measured,
      provisional: index === held.length - 1 && bucketOf(tier, row.at) === bucketOf(tier, now),
      otherScope: !!measured && latestScope !== null && keyOf(row, measured) !== latestScope,
      rootScope: capacity?.rootScope ?? null,
      scopeKey: keyOf(row, capacity),
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
/** The "What this app added" sparkline's points, in the pane's size basis. */
export function appPoints(series: readonly StorageSeriesPoint[], metric: "allocated" | "logical" = "allocated"): HistoryPoint[] {
  return series.map((value) => point(value, metric === "allocated" ? value.appAllocated : value.appLogical));
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
/** A forecast beyond this many days is named, not dated (100 years). */
const FAR_DAYS = 36_500;
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
    const name = scenarioWindowName(window, scenario);
    if (scenario.state === "finite") {
      if (scenario.days === null) return { window, name, reason: reasonText("arithmetic", window) };
      // A finite but far rate can project past the Date range; past a
      // century, draw the line across the window's own span at its rate.
      if (scenario.days > FAR_DAYS) {
        const spanMs = scenario.end - scenario.start;
        const value = evidence.available * (1 - spanMs / DAY_MS / scenario.days);
        return { window, name, detail: "empty in over 100 years", to: { at: evidence.at + spanMs, value } };
      }
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

/** Whether a maintenance run observed this volume. */
const touches = (receipt: StorageMaintenanceReceipt, identity: string) =>
  [receipt.before, receipt.after].some((observation) =>
    observation?.capacities.some((capacity) => capacity.id === identity)
  );

/**
 * Whether a receipt observed any volume at all. A run refused before it
 * measured has no observation, which says nothing about where it ran.
 */
const measured = (receipt: StorageMaintenanceReceipt) =>
  [receipt.before, receipt.after].some((observation) => !!observation?.capacities.length);

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
        ? { label: `Owner refused a write: ${REFUSAL_RESOURCE[event.resource]}`, tone: "red" }
        : { label: `Owner write succeeded after a refusal: ${REFUSAL_RESOURCE[event.resource]}`, tone: "teal" };
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
 *   finished run hides its request. A run whose loaded receipt observed
 *   only other volumes is not drawn on this one; a run the pane has no
 *   receipt for, or whose receipt measured no volume, is drawn from the
 *   timeline on every volume, as the timeline returns it for every one;
 * - a client refusal is dropped when the timeline's latest event for its
 *   target and resource opened it or resolved it later;
 * - a series scope change is dropped when a timeline scope change falls
 *   after the last observation that held the old scope, up to the one that
 *   holds the new scope.
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
  // Scope transitions are tracked apart from measured points: the observation
  // that sees a new scope is itself a gap. A change happened after the last
  // observation that held the old scope, so a timeline scope change since
  // then is the same one.
  let scope: string | null = null,
    scopeAt = -Infinity;
  series.forEach((value, index) => {
    const previous = series[index - 1];
    if (value.gap && !previous?.gap) add(value.at, "neutral", "Collection gap");
    if (value.scopeKey === null) return;
    if (
      scope !== null &&
      value.scopeKey !== scope &&
      !scopes.some((event) => event.at > scopeAt && event.at <= value.at)
    )
      add(value.at, "purple", "Scope changed");
    scope = value.scopeKey;
    scopeAt = value.at;
  });

  for (const refusal of input.pressure?.causes.refusals ?? []) {
    const latest = timeline
      .filter((event) => event.kind === "refusal" && event.target === refusal.target && event.resource === refusal.resource)
      .at(-1);
    if (latest && !(latest.phase === "succeeded" && refusal.at > latest.at)) continue;
    add(refusal.at, "red", `Owner refused a write: ${REFUSAL_RESOURCE[refusal.resource]}`);
  }

  // One run per receipt; each phase from the timeline when it has it.
  const runs = new Map<string, { requested?: Found; finished?: Found }>();
  const elsewhere = new Set<string>();
  const run = (receipt: string) => runs.get(receipt) ?? (runs.set(receipt, {}), runs.get(receipt)!);
  for (const row of input.maintenance ?? []) {
    const receipt = row.latest;
    if (!receipt) continue;
    if (!touches(receipt, identity)) {
      // Only an observation of other volumes puts a run elsewhere; an
      // unmeasured one keeps the timeline's marker on every volume.
      if (measured(receipt)) elsewhere.add(receipt.id);
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
