// Storage history for the chart stories (#4543): the data volume of the
// Odysseus world, measured every six hours up to the pinned instant.
//
// Every time is derived from `REFERENCE_INSTANT` with arithmetic and every
// string is formatted in UTC, so the stories render identically everywhere.
// Values are decimal bytes; the volume holds 161 GB, so the Low and Very low
// levels are 10% and 5% of it (16.1 GB and 8.05 GB). Now reads 16.4 GB and the
// state is still Low: the recovery level is 12%, and 16.4 GB is under it.

import type { HistoryChartProps, HistoryMarker, HistoryPoint, HistoryScenario, HistoryThresholds } from "../src/index.js";
import { projectionReasonText } from "../src/storage/history-geometry.js";
import { REFERENCE_INSTANT } from "./time.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1e9;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The pinned now: 12 Jul 04:40 UTC, the current six-hour bucket still filling. */
export const HISTORY_NOW = REFERENCE_INSTANT.getTime();
const BUCKET_END = Date.UTC(2026, 6, 12, 0, 0);
const utc = (month: number, day: number, hour = 0) => Date.UTC(2026, month - 1, day, hour);

export const VOLUME_TOTAL = 161 * GB;
export const THRESHOLDS: HistoryThresholds = { low: 16.1 * GB, veryLow: 8.05 * GB };

const pad = (n: number) => String(n).padStart(2, "0");

/** Decimal gigabytes, three significant figures: 16.4 GB, 8.05 GB, 40 GB. */
export function formatGB(bytes: number): string {
  const gb = bytes / GB;
  if (gb === 0) return "0 GB";
  return `${Number(gb.toPrecision(3))} GB`;
}

export function formatDay(at: number): string {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function formatTime(at: number): string {
  const d = new Date(at);
  return `${formatDay(at)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2 Jul 06:00–12:00" within a day, two full times across days. */
export function formatSpan(from: number, to: number): string {
  if (from === to) return formatTime(from);
  const a = new Date(from);
  const b = new Date(to);
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return sameDay ? `${formatTime(from)}–${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}` : `${formatTime(from)}–${formatTime(to)}`;
}

export const FORMATTERS = { formatValue: formatGB, formatTick: formatDay, formatTime, formatSpan } satisfies Pick<
  HistoryChartProps,
  "formatValue" | "formatTick" | "formatTime" | "formatSpan"
>;

/**
 * 64 six-hour points, 26 Jun 12:00 to now. A steady decline of about 1.24 GB a
 * day, with the backups store growing 3.1 GB on 1 Jul and a cleanup returning
 * 5.0 GB on 7 Jul. The last point is the provisional current bucket.
 */
function sixHourValue(at: number): number {
  const start = utc(6, 26, 12);
  const days = (at - start) / DAY;
  const steps = (at >= utc(7, 1) ? -3.1 : 0) + (at >= utc(7, 7) ? 5.0 : 0);
  const totalDays = (HISTORY_NOW - start) / DAY;
  const rate = (34.0 - 3.1 + 5.0 - 16.4) / totalDays;
  const wiggle = at === HISTORY_NOW ? 0 : 0.18 * Math.sin(days * 5.3) * Math.min(1, (HISTORY_NOW - at) / DAY);
  return Math.round((34.0 - rate * days + steps + wiggle) * 100) * (GB / 100);
}

export const sixHourFull: HistoryPoint[] = [
  ...Array.from({ length: 63 }, (_, i) => {
    const at = utc(6, 26, 12) + i * 6 * HOUR;
    return { at, value: sixHourValue(at) };
  }),
  { at: HISTORY_NOW, value: 16.4 * GB, provisional: true },
];
if (sixHourFull[62]!.at !== BUCKET_END) throw new Error("six-hour fixture must end at the 12 Jul 00:00 bucket");

/** The same series with nothing observed on 2 Jul at 06:00 and 12:00. */
export const GAP_FIRST = utc(7, 2, 6);
export const GAP_LAST = utc(7, 2, 12);
export const sixHourGap: HistoryPoint[] = sixHourFull.map((p) => (p.at === GAP_FIRST || p.at === GAP_LAST ? { at: p.at, value: null } : p));

export const SHORT_FINITE: HistoryScenario = { window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: utc(7, 20), value: 0 } };
export const LONG_FINITE: HistoryScenario = { window: "long", name: "30-day", detail: "empty ~28 Jul", to: { at: utc(7, 28), value: 0 } };
export const LONG_SHORT_HISTORY: HistoryScenario = { window: "long", name: "30-day", reason: projectionReasonText("insufficient-span", 30) };
export const SHORT_GAP: HistoryScenario = { window: "short", name: "7-day", reason: projectionReasonText("gap", 7) };
export const LONG_GAP: HistoryScenario = { window: "long", name: "30-day", reason: projectionReasonText("gap", 30) };
export const SHORT_FLAT: HistoryScenario = {
  window: "short",
  name: "7-day",
  detail: "not running out",
  to: { at: HISTORY_NOW + 30 * DAY, value: 17.1 * GB },
};

export const EVENTS: HistoryMarker[] = [
  { at: utc(7, 1), n: 1, tone: "amber", time: "1 Jul", label: "Backups store grew 3.1 GB" },
  { at: utc(7, 7), n: 2, tone: "teal", time: "7 Jul", label: "Clean up retained history · +5.0 GB" },
  { at: utc(7, 7, 12), n: 3, tone: "neutral", time: "7 Jul", label: "Search index rebuilt" },
];

/** Three events six hours apart: one box at every width. */
export const CLUSTERED_EVENTS: HistoryMarker[] = [
  { at: utc(7, 1), n: 1, tone: "amber", time: "1 Jul", label: "Backups store grew 3.1 GB" },
  { at: utc(7, 7), n: 2, tone: "teal", time: "7 Jul 00:00", label: "Clean up retained history · +5.0 GB" },
  { at: utc(7, 7, 6), n: 3, tone: "neutral", time: "7 Jul 06:00", label: "Search index rebuilt" },
  { at: utc(7, 7, 12), n: 4, tone: "red", time: "7 Jul 12:00", label: "Owner refused a write: no space" },
];

/** Weekly: two closed weeks and the current one. */
export const weeklyThree: HistoryPoint[] = [
  { at: utc(6, 28), value: 30.1 * GB },
  { at: utc(7, 5), value: 22.4 * GB },
  { at: HISTORY_NOW, value: 16.4 * GB, provisional: true },
];

export const singlePoint: HistoryPoint[] = [{ at: HISTORY_NOW, value: 16.4 * GB, provisional: true }];

/** The volume was replaced on 4 Jul: earlier points measured another volume. */
export const SCOPE_CHANGE_AT = utc(7, 4, 12);
export const scopeChanged: HistoryPoint[] = sixHourFull.map((p) =>
  p.at < SCOPE_CHANGE_AT ? { at: p.at, value: p.value === null ? null : p.value + 3.4 * GB, otherScope: true } : p,
);
export const LONG_SCOPE: HistoryScenario = { window: "long", name: "30-day", reason: projectionReasonText("changed-scope") };

export const allUnknown: HistoryPoint[] = sixHourFull.map((p) => ({ at: p.at, value: null }));
export const SHORT_NONE: HistoryScenario = { window: "short", name: "7-day", reason: projectionReasonText("no-observation") };
export const LONG_NONE: HistoryScenario = { window: "long", name: "30-day", reason: projectionReasonText("no-observation") };

/** Very low now: the same decline, steeper, ending at 7.2 GB. */
export const veryLowNow: HistoryPoint[] = sixHourFull.map((p) => {
  if (p.value === null) return p;
  const share = (p.at - sixHourFull[0]!.at) / (HISTORY_NOW - sixHourFull[0]!.at);
  return { ...p, value: Math.round((p.value - share * 9.2 * GB) / 1e7) * 1e7 };
});
export const SHORT_VERY_LOW: HistoryScenario = { window: "short", name: "7-day", detail: "empty ~15 Jul", to: { at: utc(7, 15, 12), value: 0 } };

/** The shared props of a six-hour chart, for a story to extend. */
export const HISTORY_BASE: HistoryChartProps = {
  label: "Available space, Data volume, last 16 days",
  points: sixHourFull,
  now: HISTORY_NOW,
  intervalMs: 6 * HOUR,
  intervalLabel: "6 h",
  thresholds: THRESHOLDS,
  nowState: "Low",
  scenarios: [SHORT_FINITE, LONG_FINITE],
  markers: EVENTS,
  ...FORMATTERS,
};

/* ── Sparkline: what this app added on the data volume ─────────────────────── */

/** App-owned bytes on the volume, every six hours for the last seven days. */
export const appAddedRising: HistoryPoint[] = Array.from({ length: 29 }, (_, i) => {
  const at = BUCKET_END - (28 - i) * 6 * HOUR;
  return { at, value: Math.round((12.0 + (3.4 * i) / 28 + 0.05 * Math.sin(i * 1.7)) * 100) * (GB / 100) };
});
export const appAddedGap: HistoryPoint[] = appAddedRising.map((p, i) => (i === 9 || i === 10 ? { at: p.at, value: null } : p));
export const appAddedUnknown: HistoryPoint[] = appAddedRising.map((p) => ({ at: p.at, value: null }));

/** The volume changed between the last closed bucket and now: only the provisional point is on the current volume. */
export const scopeChangedAtNow: HistoryPoint[] = sixHourFull.map((p) =>
  p.at < HISTORY_NOW ? { at: p.at, value: p.value === null ? null : p.value + 3.4 * GB, otherScope: true } : p,
);

/** A collector that reported a non-number for 2 Jul 06:00: it is a gap, never a value. */
export const sixHourNotANumber: HistoryPoint[] = sixHourFull.map((p) => (p.at === GAP_FIRST ? { at: p.at, value: Number.NaN } : p));
