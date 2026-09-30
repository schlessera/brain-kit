import { historySeries, isIsoDate, readHistory, type StatsHistory } from "./stats-history.js";
import type { StatsThresholds } from "./stats.js";

export type TrendMetric = "embeddingCoverage" | "brokenLinks" | "orphans";
export type TrendState = "warning" | "measured-no-warning" | "insufficient" | "stale" | "incomparable";
export interface TrendWindow {
  start: string;
  end: string;
  dates: string[];
  samples: number;
  median: number | null;
  countMedian: number | null;
  versions: string[];
}
export interface StatsTrend {
  metric: TrendMetric;
  state: TrendState;
  baseline: TrendWindow;
  recent: TrendWindow;
  latestAt: string | null;
  change: number | null;
  countChange: number | null;
  relativeChange: number | null;
  rule: { minimumSamples: number; maximumAgeHours: number; minimumChange: number; minimumCountChange: number | null; minimumRelativeChange: number | null; currentThreshold: number | null };
  /** Core-owned explanation, reused verbatim by downstream surfaces. */
  message: string;
}
export interface StatsTrends {
  evaluatedAt: string;
  verdicts: StatsTrend[];
}

const DAY = 86_400_000;
const METRICS: TrendMetric[] = ["embeddingCoverage", "brokenLinks", "orphans"];

/** Explicitly reviewed definitions, not an open-ended semver promise. */
function semantics(metric: TrendMetric, version: string | null): string | null {
  if (version === "0.40.0") return metric === "embeddingCoverage" ? "eligible-coverage" : "health-v1";
  if (version === "0.37.0" || version === "0.38.0") return metric === "embeddingCoverage" ? "total-coverage" : "health-v1";
  // Development snapshots on both sides of #429 record the same 0.39.0.
  // Its coverage definition cannot be recovered from the version alone.
  if (version === "0.39.0" && metric !== "embeddingCoverage") return "health-v1";
  return null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ratio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface Observation { date: string; at: string; time: number; version: string | null; value: number; count: number | null }

/** Dates/recordings and metric fields are validated independently of provenance. */
function observations(h: StatsHistory, metric: TrendMetric, clock: number): Observation[] {
  const rows: Observation[] = [];
  for (let i = 0; i < h.dates.length; i++) {
    const date = h.dates[i];
    const at = h.recordedAt[i];
    if (!isIsoDate(date) || typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(at)) continue;
    const time = Date.parse(at);
    if (!Number.isFinite(time) || time > clock || Date.parse(`${date}T00:00:00Z`) > clock) continue;
    if (new Date(time).toISOString().slice(0, 10) !== date) continue;
    let value: number;
    let paired: number | null = null;
    if (metric === "embeddingCoverage") {
      const v = h.health.embeddingCoverage[i];
      if (!ratio(v)) continue;
      value = v;
    } else if (metric === "orphans") {
      const v = h.health.orphans[i];
      if (!count(v)) continue;
      value = v;
    } else {
      const v = h.health.brokenLinkRate[i];
      const n = h.brokenLinks[i];
      const links = h.links[i];
      if (!ratio(v) || !count(n) || !count(links) || links === 0 || n > links || v !== n / links) continue;
      value = v;
      paired = n;
    }
    rows.push({ date, at, time, version: h.versions[i] ?? null, value, count: paired });
  }
  return rows;
}

function window(rows: Observation[], start: string, end: string): TrendWindow {
  return {
    start, end, dates: rows.map(r => r.date), samples: rows.length,
    median: median(rows.map(r => r.value)),
    countMedian: median(rows.flatMap(r => r.count === null ? [] : [r.count])),
    versions: [...new Set(rows.flatMap(r => r.version === null ? [] : [r.version]))].sort(),
  };
}

const NAMES: Record<TrendMetric, string> = { embeddingCoverage: "Embedding coverage (ratio)", brokenLinks: "Broken-link rate (ratio)", orphans: "Orphan count" };

export function evaluateStatsTrends(history: StatsHistory, thresholds: StatsThresholds, now = new Date()): StatsTrends {
  const clock = now.getTime();
  const midnight = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const day = (offset: number) => new Date(midnight + offset * DAY).toISOString().slice(0, 10);
  const verdicts = METRICS.map((metric): StatsTrend => {
    const valid = observations(history, metric, clock);
    const baselineRows = valid.filter(r => r.date >= day(-13) && r.date <= day(-7));
    const recentRows = valid.filter(r => r.date >= day(-6) && r.date <= day(0));
    const used = [...baselineRows, ...recentRows];
    const latest = used.reduce<Observation | null>((a, r) => a === null || r.time > a.time ? r : a, null);
    const v: StatsTrend = {
      metric, state: "insufficient", baseline: window(baselineRows, day(-13), day(-7)), recent: window(recentRows, day(-6), day(0)),
      latestAt: latest?.at ?? null, change: null, countChange: null, relativeChange: null,
      rule: { minimumSamples: 3, maximumAgeHours: 48, minimumChange: metric === "embeddingCoverage" ? 0.05 : metric === "brokenLinks" ? 0.01 : 5,
        minimumCountChange: metric === "brokenLinks" ? 3 : null, minimumRelativeChange: metric === "orphans" ? 0.2 : null,
        currentThreshold: metric === "embeddingCoverage" ? thresholds.coverageFloor : metric === "brokenLinks" ? thresholds.brokenLinkCeiling : null },
      message: "",
    };
    const span = `${v.baseline.start}–${v.baseline.end} (${v.baseline.samples} days) versus ${v.recent.start}–${v.recent.end} (${v.recent.samples} days)`;
    const prefix = `${NAMES[metric]}: ${span}`;
    if (baselineRows.length < 3 || recentRows.length < 3) {
      v.message = `${prefix}; insufficient observations (need 3 valid days per window).`;
      return v;
    }
    const definitions = used.map(r => semantics(metric, r.version));
    if (definitions.some(d => d === null) || new Set(definitions).size !== 1) {
      v.state = "incomparable";
      v.message = `${prefix}; incomparable metric definitions or unknown version provenance.`;
      return v;
    }
    if (latest === null || clock - latest.time > 48 * 60 * 60 * 1000) {
      v.state = "stale";
      v.message = `${prefix}; stale observations (latest ${v.latestAt}, more than 48 hours old).`;
      return v;
    }
    const b = v.baseline.median!;
    const r = v.recent.median!;
    v.change = r - b;
    let warning: boolean;
    let detail: string;
    if (metric === "embeddingCoverage") {
      warning = b - r >= 0.05 && r < thresholds.coverageFloor;
      detail = `median ${b} to ${r}, change ${v.change}; warn for a fall >= 0.05 and recent < ${thresholds.coverageFloor}`;
    } else if (metric === "brokenLinks") {
      v.countChange = v.recent.countMedian! - v.baseline.countMedian!;
      warning = v.change >= 0.01 && v.countChange >= 3 && r > thresholds.brokenLinkCeiling;
      detail = `rate median ${b} to ${r}, change ${v.change}; count median ${v.baseline.countMedian} to ${v.recent.countMedian}, change ${v.countChange}; warn for rate rise >= 0.01, count rise >= 3 and recent rate > ${thresholds.brokenLinkCeiling}`;
    } else {
      v.relativeChange = b === 0 ? null : v.change / b;
      warning = v.change >= 5 && (b === 0 || v.relativeChange! >= 0.2);
      detail = `median ${b} to ${r}, change ${v.change}; relative change ${v.relativeChange === null ? "not applicable (zero baseline)" : v.relativeChange}; warn for rise >= 5 and >= 0.2 relative (absolute gate alone from zero)`;
    }
    v.state = warning ? "warning" : "measured-no-warning";
    v.message = `${prefix}; ${detail}. ${warning ? "Warning" : "Measured; warning rule not met"}. Initial policy thresholds are uncalibrated.`;
    return v;
  });
  return { evaluatedAt: now.toISOString(), verdicts };
}

/** Shared read-only entry point; recording and retention remain independent. */
export function readStatsTrends(root: string, thresholds: StatsThresholds, now = new Date()): StatsTrends {
  return evaluateStatsTrends(historySeries(readHistory(root)), thresholds, now);
}
