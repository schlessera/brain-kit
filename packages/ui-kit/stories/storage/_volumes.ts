/**
 * Storage volume fixtures for the CapacityGauge and VolumeCard stories (#4542).
 *
 * Odysseus's brain on the pinned 2026-07-12: one data volume running low,
 * the system disk, an app-data scope whose capacity was never reported, and
 * a write the host refused before it could tell which volume it hit. Times
 * are literal strings, so nothing renders a clock. Sizes are decimal (S3=A),
 * three significant figures, as the Storage pane prints them.
 */
import type { CapacityFigures, CapacityThresholds } from "../../src/storage/capacity-geometry.js";
import type { VolumeCardProps } from "../../src/storage/VolumeCard.js";

const GB = 1e9;

/** Decimal GB to three significant figures: 16.4 GB, 161 GB, 8.05 GB. */
export function formatBytes(bytes: number): string {
  return `${Number((bytes / GB).toPrecision(3))} GB`;
}

/** The ui-sdk pressure-policy entry thresholds (storage-guidance.md): Low 10%, Very low 5%. */
export const THRESHOLDS: CapacityThresholds = { low: 0.1, veryLow: 0.05 };

/** `used + free = total`; reserved is `free − available`. */
function capacity(totalGb: number, availableGb: number, reservedGb: number): CapacityFigures {
  const bytes = (gb: number) => Math.round(gb * GB);
  const total = bytes(totalGb);
  const available = bytes(availableGb);
  const free = available + bytes(reservedGb);
  return { total, used: total - free, free, available };
}

export const DATA_LOW = capacity(161, 16.4, 1.2);
export const DATA_VERY_LOW = capacity(161, 6.1, 1.2);
export const SYSTEM_OK = capacity(250, 48.2, 1.7);

type Card = Omit<VolumeCardProps, "thresholds" | "format">;

export const ok: Card = {
  name: "System disk",
  status: "ok",
  capacity: SYSTEM_OK,
  trend: "−0.1 GB/day",
  runway: "not projected · growth flat",
  stores: ["Models", "Backups"],
};

export const low: Card = {
  name: "Data volume",
  status: "low",
  capacity: DATA_LOW,
  trend: "−1.2 GB/day",
  runway: "~14 days",
  stores: ["Notes", "Library", "Index"],
};

export const veryLow: Card = {
  ...low,
  status: "very-low",
  capacity: DATA_VERY_LOW,
  trend: "−0.9 GB/day",
  runway: "~7 days",
};

export const unknown: Card = {
  name: "App data",
  status: "not-measured",
  unknownReason: "statfs unavailable",
  trend: "unknown",
  runway: "unknown",
  stores: ["Voyage transcripts", "Sessions"],
};

export const stale: Card = { ...low, stale: true, measured: "Measured 3 h ago" };

export const scopeChanged: Card = {
  ...low,
  scopeChanged: "12 Jul 09:10",
  runway: "not projected · scope changed",
};

export const writeRefused: Card = {
  name: "Unidentified volume",
  status: "not-measured",
  unidentified: "Write refused 12 Jul 14:02",
};

export const longName: Card = {
  ...ok,
  name: "Shared volume for the Ithaca harbour survey, the crew ledger and the raft drawings from Ogygia",
  stores: ["Harbour survey", "Crew ledger", "Raft drawings", "Library", "Index", "Voyage transcripts"],
};

/** The three cards the pane draws for this brain, in the group. */
export const group = [
  { id: "data", ...low },
  { id: "system", ...ok },
  { id: "app", ...unknown },
];
