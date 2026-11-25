/**
 * Storage volume view models (#4546, #4537 D7): one entry per capacity scope,
 * named from its contents, with the gauge figures, the threshold ticks and the
 * facts a `VolumeCard` takes. Pure functions over the existing wire types.
 *
 * Two rules run through every function here and in its siblings:
 * - capacities are never added together; each volume carries its own figures;
 * - an unknown stays `null` (or the prop is left out), never `0`.
 */
import {
  STORAGE_PRESSURE_CRITICAL_PERCENT,
  STORAGE_PRESSURE_LOW_PERCENT,
  type StorageCapacityView,
  type StorageGuidanceResponse,
  type StorageHistoryResponse,
  type StoragePressureView,
  type StorageRoot,
  type StorageScenario,
  type StorageSeverity,
  type StorageSnapshot,
  type StorageStatus,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  capacityDrawable,
  projectionReasonText,
  type CapacityFigures,
  type CapacityThresholds,
  type VolumeGroupItem,
} from "@schlessera/brain-ui-kit";
import { bytes, humanReason } from "./storage-model.js";
import { foldSidecarLabels } from "./storage-consumers.js";

export const DAY_MS = 86_400_000;

/** Byte and time text. Injected so tests and the pane format alike. */
export interface StorageFormat {
  bytes: (value: number) => string;
  /** A point in time: "12 Jul 14:02". */
  time: (at: number) => string;
  /** A day: "20 Jul". */
  day: (at: number) => string;
}
const parts = (at: number, timeZone?: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
/** The pane's formats; `timeZone` exists for deterministic tests. */
export function storageFormat(timeZone?: string): StorageFormat {
  return {
    bytes: (value) => bytes(value),
    time: (at) => {
      const p = parts(at, timeZone);
      return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
    },
    day: (at) => {
      const p = parts(at, timeZone);
      return `${p.day} ${p.month}`;
    },
  };
}

/** A signed byte change: "+1.8 GB", "−0.2 GB", "0 bytes". */
export function signedBytes(value: number, format: StorageFormat): string {
  if (value === 0) return format.bytes(0);
  return `${value > 0 ? "+" : "−"}${format.bytes(Math.abs(value))}`;
}

/**
 * Low and Very low as fractions of total, for the gauge's ticks. Drawn from
 * the #4539 policy constants, so the ticks sit where the server's severity
 * changes.
 */
export const STORAGE_GAUGE_THRESHOLDS: CapacityThresholds = Object.freeze({
  low: STORAGE_PRESSURE_LOW_PERCENT / 100,
  veryLow: STORAGE_PRESSURE_CRITICAL_PERCENT / 100,
});

/** The same thresholds in bytes of one volume's total; `null` when the total is unknown. */
export function thresholdBytes(
  total: number | null
): { low: number; veryLow: number } | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return {
    low: (total * STORAGE_PRESSURE_LOW_PERCENT) / 100,
    veryLow: (total * STORAGE_PRESSURE_CRITICAL_PERCENT) / 100,
  };
}

/** The newest inventory, chosen as the server's guidance chooses it. */
export function latestInventory(
  status: Pick<StorageStatus, "snapshot" | "previous"> | null
): StorageSnapshot | null {
  if (!status) return null;
  return (
    [status.snapshot, status.previous]
      .filter((value): value is StorageSnapshot => value !== null)
      .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null
  );
}

const BRAIN_CATEGORIES = new Set<StorageRoot["category"]>(["content", "git", "index"]);
const rank = (severity: StorageSeverity | null) =>
  severity === "critical" ? 2 : severity === "low" ? 1 : 0;

/** What D7 names a volume from. */
interface VolumeContents {
  /** The volume's identity resolved to a capacity in current inventory. */
  identified: boolean;
  kind: StorageCapacityView["kind"];
  roots: ReadonlyArray<Pick<StorageRoot, "owner" | "category">>;
}

type ContentName = "Brain disk" | "App data disk" | "Memory (tmpfs)" | "Unidentified volume" | "Disk";
function contentName(contents: VolumeContents): ContentName {
  if (!contents.identified) return "Unidentified volume";
  if (contents.kind === "tmpfs") return "Memory (tmpfs)";
  // Never after its loudest store: one brain, Git or index root names the disk.
  if (contents.roots.some((root) => root.owner === "brain" || BRAIN_CATEGORIES.has(root.category)))
    return "Brain disk";
  if (contents.roots.length && contents.roots.every((root) => root.owner === "app")) return "App data disk";
  return "Disk";
}

/**
 * D7 names, in measurement order. A sole volume is "Disk", unless it is
 * memory or could not be identified: neither is ever given a disk's name. A
 * clash appends " 2", " 3" in measurement order, so a name does not change
 * when severity reorders the cards.
 */
export function volumeNames(volumes: readonly VolumeContents[]): string[] {
  const base = volumes.map(contentName);
  const named =
    base.length === 1 && base[0] !== "Unidentified volume" && base[0] !== "Memory (tmpfs)" ? ["Disk"] : base;
  const seen = new Map<string, number>();
  return named.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });
}

/** One volume: the `VolumeGroupItem` props plus what the pane and indicator decide from. */
export interface StorageVolume extends VolumeGroupItem {
  /** The server's pressure severity; `null` when the volume has no pressure record. */
  severity: StorageSeverity | null;
  /** The identity joined a capacity in current inventory. */
  identified: boolean;
  /** The evidence is not current: guidance unknown, pending, or this record unknown. */
  uncertain: boolean;
  /** Low and Very low in this volume's bytes; `null` when its total is unknown. */
  thresholdBytes: { low: number; veryLow: number } | null;
  /** The latest measurement time behind the figures; `null` when none. */
  measuredAt: number | null;
}

interface StorageVolumeInput {
  guidance: StorageGuidanceResponse | null;
  /** The newest inventory snapshot (see `latestInventory`). */
  inventory: StorageSnapshot | null;
  /** History supplies figures only when inventory has none for a volume. */
  history?: StorageHistoryResponse | null;
  format?: StorageFormat;
}

/** Stale is the scenario evidence's own verdict (the server's 6h rule), passed through. */
export function evidenceStale(pressure: StoragePressureView | null | undefined): boolean {
  const evidence = pressure?.evidence;
  return !!evidence && (evidence.short.reason === "stale" || evidence.long.reason === "stale");
}

function figures(value: {
  total: number | null;
  used: number | null;
  free: number | null;
  available: number | null;
}): CapacityFigures | undefined {
  const { total, used, free, available } = value;
  if (total === null || used === null || free === null || available === null) return undefined;
  const result = { total, used, free, available };
  return capacityDrawable(result) ? result : undefined;
}

function latestHistoryFigures(history: StorageHistoryResponse | null | undefined, identity: string) {
  const rows = (history?.observations ?? [])
    .filter((row) => !row.gap)
    .flatMap((row) => row.capacities.filter((value) => value.identity === identity).map((value) => ({ at: row.at, value })))
    .sort((a, b) => b.at - a.at);
  return rows[0] ?? null;
}

function trendText(pressure: StoragePressureView | null, format: StorageFormat): string {
  const change = pressure && !pressure.scopeChanged ? pressure.evidence?.availableChange : null;
  return change ? `${signedBytes(change.bytesPerDay, format)}/day` : "unknown";
}

function runwayText(pressure: StoragePressureView | null): string {
  if (!pressure?.evidence) return "unknown";
  if (pressure.scopeChanged) return "not projected · scope changed";
  const { short, long } = pressure.evidence;
  const finite = [short, long].find(
    (scenario): scenario is StorageScenario & { days: number } => scenario.state === "finite" && scenario.days !== null
  );
  if (finite) return `~${new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(finite.days)} days`;
  if (short.state === "non-depleting" || long.state === "non-depleting") return "not projected · not running out";
  const reason = short.reason ?? long.reason;
  return `not projected · ${reason ? projectionReasonText(reason) : "no projection"}`;
}

/**
 * Every volume, worst severity first, then in measurement order: inventory's
 * capacities as measured, then pressure records inventory does not hold.
 */
export function storageVolumes(input: StorageVolumeInput): StorageVolume[] {
  const format = input.format ?? storageFormat();
  const inventory = input.inventory;
  const pressures = input.guidance?.capacities ?? [];
  const capacities = inventory?.capacities ?? [];
  const guidanceCurrent =
    !!input.guidance && input.guidance.state === "current" && !input.guidance.pending;
  const entries: Array<{ id: string; capacity: StorageCapacityView | null; pressure: StoragePressureView | null }> = [
    ...capacities.map((capacity) => ({
      id: capacity.id,
      capacity,
      pressure: pressures.find((value) => value.identity === capacity.id) ?? null,
    })),
    ...pressures
      .filter((pressure) => !capacities.some((capacity) => capacity.id === pressure.identity))
      .map((pressure) => ({ id: pressure.identity, capacity: null, pressure })),
  ];
  const rootsOf = (capacity: StorageCapacityView | null) =>
    capacity ? (inventory?.roots ?? []).filter((root) => capacity.rootIds.includes(root.id)) : [];
  const contents = entries.map(({ capacity }) => ({
    identified: !!capacity && capacity.identity === "resolved",
    kind: capacity?.kind ?? ("unknown" as const),
    roots: rootsOf(capacity),
  }));
  const names = volumeNames(contents);
  const volumes = entries.map(({ id, capacity, pressure }, index): StorageVolume => {
    const identified = contents[index]!.identified;
    const severity = pressure?.severity ?? null;
    const stale = evidenceStale(pressure);
    const fromHistory = capacity ? null : latestHistoryFigures(input.history, id);
    const figuresFrom = capacity ?? fromHistory?.value ?? null;
    const capacityFigures = identified && figuresFrom ? figures(figuresFrom) : undefined;
    const total = figuresFrom?.total ?? null;
    const measuredAt = pressure?.evidence?.at ?? (capacity ? inventory?.observedAt ?? null : fromHistory?.at ?? null);
    const refusal = pressure?.causes.refusals.slice().sort((a, b) => b.at - a.at)[0];
    const status: StorageVolume["status"] =
      !identified || !pressure
        ? "not-measured"
        : severity === "critical"
        ? "very-low"
        : severity === "low"
        ? "low"
        : capacityFigures
        ? "ok"
        : "not-measured";
    const labels = rootsOf(capacity).map((root) => root.label);
    const volume: StorageVolume = {
      id,
      name: names[index]!,
      status,
      severity,
      identified,
      uncertain: !guidanceCurrent || !pressure || pressure.state !== "current",
      stale,
      thresholdBytes: identified ? thresholdBytes(total) : null,
      measuredAt,
      stores: foldSidecarLabels(labels.length ? labels : pressure?.stores.map((store) => store.label) ?? []),
    };
    if (capacityFigures) volume.capacity = capacityFigures;
    else if (identified)
      volume.unknownReason =
        capacity?.kind === "unknown" && capacity.reason ? humanReason(capacity.reason) : "capacity not reported";
    if (!identified)
      volume.unidentified = refusal ? `Write refused ${format.time(refusal.at)}` : "Volume not identified";
    else {
      volume.trend = trendText(pressure, format);
      volume.runway = runwayText(pressure);
    }
    if (stale && measuredAt !== null) volume.measured = `Measured ${format.time(measuredAt)}`;
    if (pressure?.scopeChanged) volume.scopeChanged = format.time(pressure.at);
    return volume;
  });
  return volumes
    .map((volume, order) => ({ volume, order }))
    .sort((a, b) => rank(b.volume.severity) - rank(a.volume.severity) || a.order - b.order)
    .map(({ volume }) => volume);
}
