/**
 * The storage history chart's geometry, as pure functions (#4543, #4537 D12).
 *
 * Everything `HistoryChart` and `Sparkline` draw is computed here from plain
 * numbers, so the rules that carry meaning are unit-tested rather than read
 * off a screenshot:
 *
 * - **A gap is never interpolated.** A `null` value ends one segment and the
 *   next measured value starts another; the line and its area both break, and
 *   the span between the neighbouring measurements is returned as a gap to
 *   hatch. A measured `0` is a value like any other and stays on the line.
 * - **A scope change breaks the series too.** Points measured on another
 *   volume are their own segment kind and are never joined to the current one.
 * - **Scenarios are lines, never a cone (#4537 D9).** One straight line per
 *   qualified window, from the latest measurement to the endpoint the caller
 *   supplies, clipped at the zero baseline, the top and the right edge. This
 *   module does no forecasting: it only clips a segment it was given.
 *
 * Pixel constants follow the approved design brief on #4543: a 150px plot on
 * a phone and 200px from 600px up, where the scenario labels move into a
 * 150px right gutter (maintainer ruling, 2026-11-25).
 */

/** One measurement. `value` is `null` when nothing was observed: a gap, never a zero. */
export interface HistoryPoint {
  /** Epoch milliseconds. */
  at: number;
  /** In the caller's unit (bytes for storage). `null` is a gap. */
  value: number | null;
  /** The current bucket, still filling: drawn hollow, with a dotted last edge. */
  provisional?: boolean;
  /** Measured on another volume, before a scope change. Never joined to the current series. */
  otherScope?: boolean;
}

/** Which dash a scenario line takes. Short is `7 4`, long is `2 3`. */
export type HistoryScenarioWindow = "short" | "long";

/**
 * One qualified-window scenario. Present `to` means the window qualified and a
 * line is drawn; absent `to` means it did not, and `reason` says why.
 */
export interface HistoryScenario {
  window: HistoryScenarioWindow;
  /** The window's real span, rounded to whole days: "7-day", "30-day". The kit never computes it. */
  name: string;
  /** Pre-formatted outcome: "empty ~20 Jul", "not running out". */
  detail?: string;
  /** Where the scenario line heads, in data units. It is clipped, never extended. */
  to?: { at: number; value: number };
  /** Pre-formatted reason when `to` is absent: "under 30 days of history". */
  reason?: string;
}

/** Threshold levels in the series' unit. Bands are drawn from zero up to each. */
export interface HistoryThresholds {
  low?: number;
  veryLow?: number;
}

/** A numbered event marker. Generic, so the server timeline (#4548) only adds data. */
export interface HistoryMarker {
  at: number;
  /** The number shared with the event list. */
  n: number;
  tone?: "amber" | "gold" | "teal" | "purple" | "blue" | "red" | "neutral";
  /** What happened, pre-formatted. */
  label: string;
  /** When it happened, pre-formatted; the list leads with it. */
  time?: string;
}

/* ── Sizes ────────────────────────────────────────────────────────────────── */

/** From this chart width up, scenario labels sit in a right gutter beside their lines. */
export const GUTTER_MIN_WIDTH = 600;
/** Mono glyph advance as a fraction of the font size (JetBrains Mono is 0.6em). */
const MONO_ADVANCE = 0.6;
/** Axis and in-plot label size. */
export const LABEL_SIZE = 9.5;
/** Two tick labels never sit closer than this, centre to centre. */
export const TICK_MIN_GAP = 48;
/** Two scenario labels in the gutter never sit closer than this. */
export const SCENARIO_LABEL_GAP = 28;
/** Markers closer than this along x share one numbered box. */
export const MARKER_CLUSTER_GAP = 20;
/** The future zone's share of the plot width. */
export const FUTURE_SHARE = 0.2;
/** A gutter label's text starts this far right of the plot: a 6px gap and its 16px dash sample. */
const GUTTER_TEXT_OFFSET = 22;
/**
 * A gutter label's two 10px lines, relative to its centre `y`: baselines at
 * y+3 and y+15, and the box they paint (0.8em ascent above the first, 0.25em
 * descent below the second).
 */
export const SCENARIO_LABEL_BOX = { line1: 3, line2: 15, above: 5, below: 17.5 } as const;
/** Height of the event lane under the x axis. */
const EVENT_LANE = 28;

interface ChartFrame {
  wide: boolean;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The chart's outer box and plot rectangle at a given width. */
export function chartFrame(width: number, withEvents: boolean): ChartFrame {
  const w = Math.max(0, width);
  const wide = w >= GUTTER_MIN_WIDTH;
  const top = 8;
  const plotHeight = wide ? 200 : 150;
  const left = wide ? 56 : 44;
  const right = Math.max(left, w - (wide ? 150 : 12));
  const bottom = top + plotHeight;
  const height = bottom + 20 + (withEvents ? EVENT_LANE : 0);
  return { wide, width: w, height, left, right, top, bottom };
}

/** Approximate rendered width of a mono label. */
export function textWidth(text: string, size = LABEL_SIZE): number {
  return [...text].length * size * MONO_ADVANCE;
}

/* ── Scales ───────────────────────────────────────────────────────────────── */

interface LinearScale {
  (value: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
}

/** A linear map from `domain` onto `range`. A zero-width domain maps to the range's start. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0))) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** Mantissas whose quarters and halves are all short numbers: 0.3, 0.4, 0.5 … 2. */
const NICE_MAX = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10];

/** The smallest of 1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8 × 10^k at or above `raw`. */
export function niceCeil(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of NICE_MAX) {
    const v = m * power;
    // Tolerate float noise: 0.30000000000000004 is a 0.3.
    if (v >= raw * (1 - 1e-9)) return v;
  }
  return 10 * power;
}

/**
 * The y maximum: the next round number above 1.15 × the largest level the
 * chart has to show (series values and threshold levels), chosen so its
 * quarters (desktop) and halves (phone) are short numbers too.
 */
export function valueMax(levels: readonly number[]): number {
  const finite = levels.filter((v) => Number.isFinite(v) && v > 0);
  const top = finite.length ? Math.max(...finite) : 0;
  if (top === 0) return 4;
  return niceCeil(top * 1.15);
}

/** Y tick values: 0, ½ and max on a phone; 0, ¼ … max from 600px up. */
export function valueTicks(max: number, wide: boolean): number[] {
  const parts = wide ? 4 : 2;
  return Array.from({ length: parts + 1 }, (_, i) => (max * i) / parts);
}

interface TimeDomain {
  start: number;
  now: number;
  end: number;
}

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * The x domain. It runs from the first point to `now`, then on into a future
 * zone that is {@link FUTURE_SHARE} of the plot, so now always sits at 80%.
 *
 * - Sparse series, drawn as dots, start half an interval early so the first
 *   dot does not sit on the y axis.
 * - A single point gets sixteen intervals of empty plot before it (four days
 *   at six hours), for the same reason.
 */
export function timeDomain(points: readonly HistoryPoint[], now: number | undefined, intervalMs: number | undefined, sparse: boolean): TimeDomain {
  const times = points.map((p) => p.at).filter(Number.isFinite);
  const last = times.length ? Math.max(...times) : 0;
  const n = now ?? last;
  const interval = intervalMs && intervalMs > 0 ? intervalMs : 6 * HOUR;
  let start = times.length ? Math.min(...times) : n - 16 * interval;
  if (start >= n) start = n - 16 * interval;
  else if (sparse) start -= interval / 2;
  const end = n + ((n - start) * FUTURE_SHARE) / (1 - FUTURE_SHARE);
  return { start, now: n, end };
}

/* ── Segmentation ─────────────────────────────────────────────────────────── */

/**
 * Whether a value was measured. `null`, `NaN` and the infinities are all
 * unobserved: one rule, used by the geometry and by the table, so the chart
 * and its table never disagree about what is a gap.
 */
export function isMeasured(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Points the chart can place in time, in order; one with no valid instant is dropped everywhere. */
export function placeable<T extends { at: number }>(points: readonly T[]): T[] {
  return points.filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
}

type SegmentKind = "current" | "other";

interface Segment {
  kind: SegmentKind;
  points: Array<HistoryPoint & { value: number }>;
}

/**
 * Split a series into runs that may be joined by a line. A `null` value ends a
 * run (it is never bridged), and so does a change of scope. A measured `0`
 * is a value and stays in its run.
 */
export function segmentSeries(points: readonly HistoryPoint[]): Segment[] {
  const out: Segment[] = [];
  let run: Segment | null = null;
  for (const p of placeable(points)) {
    if (!isMeasured(p.value)) {
      run = null;
      continue;
    }
    const kind: SegmentKind = p.otherScope ? "other" : "current";
    if (!run || run.kind !== kind) {
      run = { kind, points: [] };
      out.push(run);
    }
    run.points.push(p as HistoryPoint & { value: number });
  }
  return out;
}

interface GapSpan {
  /** The last measurement before the gap, or the first unobserved bucket when the series starts with one. */
  from: number;
  /** The first measurement after the gap, or the last unobserved bucket when the series ends with one. */
  to: number;
  /** The first and last unobserved buckets, for the caption. */
  first: number;
  last: number;
  count: number;
}

/** Every run of unobserved buckets, with the span to hatch between its measured neighbours. */
export function gapSpans(points: readonly HistoryPoint[]): GapSpan[] {
  const sorted = placeable(points);
  const out: GapSpan[] = [];
  let i = 0;
  while (i < sorted.length) {
    if (isMeasured(sorted[i]!.value)) {
      i += 1;
      continue;
    }
    const startIndex = i;
    while (i < sorted.length && !isMeasured(sorted[i]!.value)) i += 1;
    const first = sorted[startIndex]!.at;
    const last = sorted[i - 1]!.at;
    const before = startIndex > 0 ? sorted[startIndex - 1]!.at : first;
    const after = i < sorted.length ? sorted[i]!.at : last;
    out.push({ from: before, to: after, first, last, count: i - startIndex });
  }
  return out;
}

/** Where the scope changes: halfway between the last other-volume point and the next current one. */
export function scopeBreaks(points: readonly HistoryPoint[]): number[] {
  const measured = placeable(points).filter((p) => isMeasured(p.value));
  const out: number[] = [];
  for (let i = 1; i < measured.length; i += 1) {
    const a = measured[i - 1]!;
    const b = measured[i]!;
    if (Boolean(a.otherScope) !== Boolean(b.otherScope)) out.push((a.at + b.at) / 2);
  }
  return out;
}

const r = (n: number) => Math.round(n * 100) / 100;

/** An SVG path through the points. One point is a bare move, which draws nothing. */
function linePath(xy: ReadonlyArray<readonly [number, number]>): string {
  return xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${r(x)} ${r(y)}`).join(" ");
}

/** The closed area under a run, down to `baseline`. Empty for fewer than two points. */
function areaPath(xy: ReadonlyArray<readonly [number, number]>, baseline: number): string {
  if (xy.length < 2) return "";
  const first = xy[0]!;
  const last = xy[xy.length - 1]!;
  return `${linePath(xy)} L${r(last[0])} ${r(baseline)} L${r(first[0])} ${r(baseline)} Z`;
}

/** How many subpaths (`M` commands) a path has. A gap must make two. */
export function subpathCount(path: string): number {
  return (path.match(/M/g) ?? []).length;
}

/* ── Bands ────────────────────────────────────────────────────────────────── */

interface Band {
  kind: "low" | "veryLow";
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The dashed or dotted edge, at the level itself. */
  edgeY: number;
}

/**
 * The threshold bands: Very low from zero to its level, Low from Very low (or
 * zero) up to its level. A level outside the plot is clamped to it; a missing
 * or non-positive level draws no band.
 */
export function thresholdBands(t: HistoryThresholds | undefined, y: LinearScale, left: number, right: number): Band[] {
  const out: Band[] = [];
  const base = y(0);
  const clampY = (v: number) => Math.max(Math.min(y(v), base), y.range[1]);
  const veryLow = t?.veryLow && t.veryLow > 0 ? t.veryLow : undefined;
  const low = t?.low && t.low > 0 ? t.low : undefined;
  if (veryLow !== undefined) {
    const top = clampY(veryLow);
    out.push({ kind: "veryLow", level: veryLow, x: left, y: top, width: right - left, height: base - top, edgeY: top });
  }
  if (low !== undefined) {
    const top = clampY(low);
    const floor = veryLow !== undefined && veryLow < low ? clampY(veryLow) : base;
    out.push({ kind: "low", level: low, x: left, y: top, width: right - left, height: Math.max(0, floor - top), edgeY: top });
  }
  return out;
}

/* ── Scenario lines ───────────────────────────────────────────────────────── */

interface ScenarioLine {
  scenario: HistoryScenario;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Clip the segment from `(x1, y1)` towards `(x2, y2)` to the plot rectangle:
 * it stops at the right edge, the zero baseline or the top, whichever comes
 * first, and never runs past its own endpoint.
 */
export function clipSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  box: { left: number; right: number; top: number; bottom: number },
): { x: number; y: number } {
  let t = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx > 0 && x1 + dx * t > box.right) t = Math.min(t, (box.right - x1) / dx);
  if (dy > 0 && y1 + dy * t > box.bottom) t = Math.min(t, (box.bottom - y1) / dy);
  if (dy < 0 && y1 + dy * t < box.top) t = Math.min(t, (box.top - y1) / dy);
  t = Math.max(0, t);
  return { x: x1 + dx * t, y: y1 + dy * t };
}

/**
 * One line per qualified window and none for the rest (#4537 D9). Each starts
 * at the latest measurement. There is deliberately no shape that joins two of
 * them: a range between two scenarios is not a confidence interval.
 */
export function scenarioLines(
  scenarios: readonly HistoryScenario[],
  from: { x: number; y: number } | null,
  x: LinearScale,
  y: LinearScale,
  box: { left: number; right: number; top: number; bottom: number },
): ScenarioLine[] {
  if (!from) return [];
  const out: ScenarioLine[] = [];
  for (const scenario of scenarios) {
    if (!scenario.to || !Number.isFinite(scenario.to.at) || !Number.isFinite(scenario.to.value)) continue;
    // The endpoint as given, even below zero: clamping it first would bend the
    // line and change the rate it stands for. Clipping stops it at zero.
    const end = clipSegment(from.x, from.y, x(scenario.to.at), y(scenario.to.value), box);
    out.push({ scenario, x1: from.x, y1: from.y, x2: end.x, y2: end.y });
  }
  return out;
}

/* ── Label collision ──────────────────────────────────────────────────────── */

/**
 * Spread positions along one axis so neighbours sit at least `gap` apart,
 * keeping their order and staying inside `[lo, hi]`. Returns the new
 * positions in the input's order. Positions are pushed apart, not dropped:
 * use this where every label must stay.
 */
export function spreadLabels(positions: readonly number[], gap: number, lo: number, hi: number): number[] {
  const order = positions.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const placed = order.map((o) => Math.min(Math.max(o.p, lo), hi));
  for (let k = 1; k < placed.length; k += 1) placed[k] = Math.max(placed[k]!, placed[k - 1]! + gap);
  const overflow = placed.length ? placed[placed.length - 1]! - hi : 0;
  if (overflow > 0) {
    placed[placed.length - 1] = hi;
    for (let k = placed.length - 2; k >= 0; k -= 1) placed[k] = Math.min(placed[k]!, placed[k + 1]! - gap);
  }
  // Re-centre a pushed group on the positions it came from, where the bounds allow,
  // so two labels that collide move apart symmetrically rather than one jumping.
  const out = new Array<number>(positions.length);
  let k = 0;
  while (k < placed.length) {
    let j = k;
    while (j + 1 < placed.length && placed[j + 1]! - placed[j]! <= gap + 1e-9) j += 1;
    const want = order.slice(k, j + 1).reduce((s, o) => s + o.p, 0) / (j - k + 1);
    const have = placed.slice(k, j + 1).reduce((s, p) => s + p, 0) / (j - k + 1);
    const prev = k > 0 ? placed[k - 1]! + gap : lo;
    const next = j + 1 < placed.length ? placed[j + 1]! - gap : hi;
    const shift = Math.min(Math.max(want - have, prev - placed[k]!), next - placed[j]!);
    for (let m = k; m <= j; m += 1) placed[m] = placed[m]! + (Number.isFinite(shift) ? shift : 0);
    k = j + 1;
  }
  order.forEach((o, n) => {
    out[o.i] = placed[n]!;
  });
  return out;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;
}

/* ── Ticks ────────────────────────────────────────────────────────────────── */

interface XTick {
  at: number;
  x: number;
  now?: boolean;
}

const STEP_DAYS = [1, 2, 4, 7, 14, 30, 61, 91, 182];

/**
 * X ticks. Always the range's start and `now`.
 *
 * - Phone: one midpoint between them, on a whole day.
 * - From 600px: whole days every 1, 2, 4, 7, 14, 30, 61 … days, the first
 *   step that leaves at least 80px between ticks (about four days for the
 *   six-hour tier, two weeks for daily, two months for weekly).
 * - Sparse series tick their own points instead, so each dot is dated.
 *
 * Then any tick within {@link TICK_MIN_GAP} of `now` or of a kept neighbour is
 * dropped. Days are UTC days; a tick label formats its own instant, so the
 * label always names the day the tick sits in.
 */
export function timeTicks(
  domain: TimeDomain,
  x: LinearScale,
  wide: boolean,
  sparsePoints?: readonly number[],
): XTick[] {
  const { start, now } = domain;
  const candidates: number[] = [];
  if (sparsePoints) {
    candidates.push(...sparsePoints.filter((at) => at < now));
  } else if (now > start) {
    candidates.push(start);
    if (!wide) {
      const mid = Math.round((start + now) / 2 / DAY) * DAY;
      candidates.push(mid > start && mid < now ? mid : (start + now) / 2);
    } else {
      const pxPerDay = (x(start + DAY) - x(start)) || 1;
      const step = (STEP_DAYS.find((d) => d * pxPerDay >= 80) ?? STEP_DAYS[STEP_DAYS.length - 1]!) * DAY;
      for (let t = Math.ceil(start / DAY) * DAY; t < now; t += step) if (t > start) candidates.push(t);
    }
  }
  const nowX = x(now);
  const kept: XTick[] = [];
  for (const at of candidates.sort((a, b) => a - b)) {
    const px = x(at);
    if (nowX - px < TICK_MIN_GAP) continue;
    const prev = kept[kept.length - 1];
    if (prev && px - prev.x < TICK_MIN_GAP) continue;
    kept.push({ at, x: px });
  }
  kept.push({ at: now, x: nowX, now: true });
  return kept;
}

/* ── Event markers ────────────────────────────────────────────────────────── */

interface MarkerCluster {
  markers: HistoryMarker[];
  /** "1", "2–3", "2–4", or "2, 5" when the numbers are not consecutive. */
  label: string;
  /** Centre of the markers it stands for. */
  x: number;
  /** Where its box is drawn, after spreading boxes apart. */
  boxX: number;
  boxWidth: number;
}

export function clusterLabel(ns: readonly number[]): string {
  const sorted = [...ns].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const consecutive = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return consecutive ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

/**
 * Group markers that would collide. Walk left to right; a marker less than
 * {@link MARKER_CLUSTER_GAP} from the current cluster's LAST marker joins it.
 * Each cluster gets one box centred on its markers, and boxes that would still
 * touch are spread apart inside the plot. Every marker keeps its own rule.
 */
export function clusterMarkers(markers: readonly HistoryMarker[], x: LinearScale, left: number, right: number): MarkerCluster[] {
  const sorted = [...markers].filter((m) => Number.isFinite(m.at)).sort((a, b) => a.at - b.at || a.n - b.n);
  const groups: HistoryMarker[][] = [];
  let lastX = -Infinity;
  for (const m of sorted) {
    const px = x(m.at);
    const group = groups[groups.length - 1];
    if (group && px - lastX < MARKER_CLUSTER_GAP) group.push(m);
    else groups.push([m]);
    lastX = px;
  }
  const clusters = groups.map((markers) => {
    const label = clusterLabel(markers.map((m) => m.n));
    const centre = markers.reduce((s, m) => s + x(m.at), 0) / markers.length;
    return { markers, label, x: centre, boxX: centre, boxWidth: Math.max(16, textWidth(label, 10) + 8) };
  });
  // Spread box centres apart: the widest neighbouring pair sets the gap.
  const gap = Math.max(0, ...clusters.map((c) => c.boxWidth)) + 4;
  const half = (clusters[0]?.boxWidth ?? 16) / 2;
  const spread = spreadLabels(clusters.map((c) => c.x), gap, left + half, Math.max(left + half, right - half));
  return clusters.map((c, i) => ({ ...c, boxX: spread[i]! }));
}

/* ── The whole chart ──────────────────────────────────────────────────────── */

/** Fixed in-plot copy. Its width decides what fits, so it lives with the geometry. */
export const HISTORY_COPY = {
  gap: "? no observation · not zero",
  gapShort: "?",
  future: "future",
  scopeChanged: "↺ scope changed",
  otherVolume: "other volume",
  now: "now",
} as const;

/**
 * Why a window has no projection. The same names as the history evidence
 * reasons the server reports; the kit keeps its own union so its props never
 * carry a wire type.
 */
export type HistoryEvidenceReason =
  | "no-observation"
  | "stale"
  | "future"
  | "incomplete"
  | "changed-scope"
  | "changed-capacity"
  | "gap"
  | "ordering"
  | "insufficient-count"
  | "insufficient-span"
  | "mixed-direction"
  | "single-burst"
  | "arithmetic";

/**
 * The approved copy after "no projection ·" for each reason (#4543 design
 * brief, Q2). `n` is the window's days, or the measurements a window needs for
 * `insufficient-count`; it comes from the caller, never from the kit.
 */
export function projectionReasonText(reason: HistoryEvidenceReason, n?: number): string {
  switch (reason) {
    case "no-observation":
      return "no measurements yet";
    case "stale":
      return "latest measurement is out of date";
    case "future":
      return "measurement time is ahead of the clock";
    case "incomplete":
      return "latest measurement is incomplete";
    case "changed-scope":
      return "volume changed in the window";
    case "changed-capacity":
      return "volume size changed in the window";
    case "gap":
      return n === undefined ? "gap inside the window" : `gap inside the ${n}-day window`;
    case "ordering":
      return "measurements out of order";
    case "insufficient-count":
      return n === undefined ? "too few measurements" : `too few measurements (needs ${n})`;
    case "insufficient-span":
      return n === undefined ? "too little history" : `under ${n} days of history`;
    case "mixed-direction":
      return "space went up and down; no steady rate";
    case "single-burst":
      return "one burst, not a steady rate";
    case "arithmetic":
      return "couldn't compute a rate";
  }
}

interface HistoryLayoutInput {
  width: number;
  points: readonly HistoryPoint[];
  now?: number;
  intervalMs?: number;
  thresholds?: HistoryThresholds;
  scenarios?: readonly HistoryScenario[];
  markers?: readonly HistoryMarker[];
}

interface PlottedPoint {
  at: number;
  value: number;
  x: number;
  y: number;
  provisional: boolean;
  kind: SegmentKind;
}

interface DrawnSegment {
  kind: SegmentKind;
  points: PlottedPoint[];
  /** The line, without a provisional last edge. */
  line: string;
  /** The provisional last edge, dotted; empty when there is none. */
  tail: string;
  area: string;
}

interface DrawnGap extends GapSpan {
  x0: number;
  x1: number;
  /** The label drawn at the top of the hatch: the full copy, "?" or nothing. */
  label: string;
  labelX: number;
  /** True when the caption must carry this gap's full copy. */
  captioned: boolean;
}

interface TopLabel {
  text: string;
  x: number;
  anchor: "start" | "middle" | "end";
  role: "future" | "gap" | "scope" | "other";
}

interface ScenarioLabel {
  line: ScenarioLine;
  /** The label's centre line in the gutter, after spreading. */
  y: number;
}

export interface HistoryLayout {
  frame: ChartFrame;
  domain: TimeDomain;
  x: LinearScale;
  y: LinearScale;
  yMax: number;
  yTicks: Array<{ value: number; y: number }>;
  xTicks: XTick[];
  sparse: boolean;
  allUnknown: boolean;
  measuredCount: number;
  segments: DrawnSegment[];
  /** Points drawn as dots: all of them when sparse, plus any point that stands alone. */
  dots: PlottedPoint[];
  /** The last MEASURED point. It is not "now" unless `nowMeasured` says so. */
  latest: PlottedPoint | null;
  /**
   * Whether the current observation was measured: the last bucket at or
   * before now holds a value, on the current volume, and (given an interval)
   * is no more than one interval old. When false, nothing may present the
   * last measured value as now's.
   */
  nowMeasured: boolean;
  gaps: DrawnGap[];
  /** `captioned` when neither side of the rule had room for its label. */
  scopeBreaks: Array<{ at: number; x: number; captioned: boolean }>;
  bands: Band[];
  future: { x: number; width: number };
  nowX: number;
  scenarioLines: ScenarioLine[];
  /** Gutter labels; empty below {@link GUTTER_MIN_WIDTH}, where the caption carries them. */
  scenarioLabels: ScenarioLabel[];
  markers: MarkerCluster[];
  topLabels: TopLabel[];
}

/** A series is drawn as countable dots when its measurements sit at least this far apart. */
const SPARSE_SPACING = 24;

/** Lay out the whole chart. Pure: the same input always yields the same geometry. */
export function historyLayout(input: HistoryLayoutInput): HistoryLayout {
  const markersIn = input.markers ?? [];
  const frame = chartFrame(input.width, markersIn.length > 0);
  const sorted = placeable(input.points);
  const measured = sorted.filter((p): p is HistoryPoint & { value: number } => isMeasured(p.value));
  const plotWidth = frame.right - frame.left;

  // Sparse when the measurements would sit far enough apart to count (a few
  // weekly points): then each is a dot, and the domain is padded for them.
  const pastWidth = plotWidth * (1 - FUTURE_SHARE);
  const sparse = measured.length >= 2 && pastWidth / (measured.length - 1) >= SPARSE_SPACING;
  const domain = timeDomain(sorted, input.now, input.intervalMs, sparse);

  const x = linearScale([domain.start, domain.end], [frame.left, frame.right]);
  const levels = [
    ...measured.map((p) => p.value),
    ...(input.thresholds?.low ? [input.thresholds.low] : []),
    ...(input.thresholds?.veryLow ? [input.thresholds.veryLow] : []),
  ];
  const yMax = valueMax(levels);
  const y = linearScale([0, yMax], [frame.bottom, frame.top]);
  const yTicks = valueTicks(yMax, frame.wide).map((value) => ({ value, y: y(value) }));

  const plot = (p: HistoryPoint & { value: number }, kind: SegmentKind): PlottedPoint => ({
    at: p.at,
    value: p.value,
    x: x(p.at),
    y: y(Math.min(Math.max(p.value, 0), yMax)),
    provisional: Boolean(p.provisional),
    kind,
  });

  const segments: DrawnSegment[] = segmentSeries(sorted).map((s) => {
    const pts = s.points.map((p) => plot(p, s.kind));
    const xy = pts.map((p) => [p.x, p.y] as const);
    const last = pts[pts.length - 1]!;
    const hasTail = pts.length >= 2 && last.provisional;
    return {
      kind: s.kind,
      points: pts,
      line: hasTail ? (pts.length > 2 ? linePath(xy.slice(0, -1)) : "") : pts.length > 1 ? linePath(xy) : "",
      tail: hasTail ? linePath(xy.slice(-2)) : "",
      area: areaPath(xy, frame.bottom),
    };
  });

  const allPlotted = segments.flatMap((s) => s.points);
  const latest = allPlotted.length ? allPlotted[allPlotted.length - 1]! : null;
  const dots = sparse ? allPlotted : segments.filter((s) => s.points.length === 1).flatMap((s) => s.points);

  const nowX = x(domain.now);
  const future = { x: nowX, width: frame.right - nowX };
  const box = { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom };

  const past = sorted.filter((p) => p.at <= domain.now);
  const lastBucket = past[past.length - 1] ?? null;
  const nowMeasured = Boolean(
    latest &&
      lastBucket &&
      latest.at === lastBucket.at &&
      latest.kind === "current" &&
      (input.intervalMs === undefined || domain.now - lastBucket.at <= input.intervalMs),
  );

  // Scenario lines start at the current measurement only: a projection never
  // starts from another volume's number, nor from an older value standing in
  // for an unmeasured now.
  const origin = latest && nowMeasured ? { x: latest.x, y: latest.y } : null;
  const lines = scenarioLines(input.scenarios ?? [], origin, x, y, box);

  // Gutter labels: centred where each line exits, pushed 28px apart, in the
  // order of their end values.
  // A label that does not fit the gutter whole goes to the caption instead.
  let scenarioLabels: ScenarioLabel[] = [];
  const room = frame.width - frame.right;
  const inGutter = lines.filter((l) => [`${l.scenario.name} rate`, l.scenario.detail ?? ""].every((t) => GUTTER_TEXT_OFFSET + textWidth(t, 10) <= room));
  if (frame.wide && inGutter.length) {
    // Bounded by the label's whole box, both lines: its top is the first
    // line's ascent above its baseline, its bottom the second line's descent.
    const spread = spreadLabels(
      inGutter.map((l) => l.y2),
      SCENARIO_LABEL_GAP,
      Math.max(frame.top + 6, SCENARIO_LABEL_BOX.above),
      frame.height - SCENARIO_LABEL_BOX.below - (markersIn.length ? EVENT_LANE : 0),
    );
    scenarioLabels = inGutter.map((line, i) => ({ line, y: spread[i]! }));
  }

  const breakTimes = scopeBreaks(sorted).map((at) => ({ at, x: x(at) }));

  // Top-row labels, by priority, every one inside the plot and clear of the
  // others: scope labels first (falling back to the caption only when neither
  // side of the rule has room); a gap's full copy falls back to "?" and then
  // to nothing (the caption keeps its copy); the future label goes first of all.
  // The occupied boxes, kept apart from the labels: a label's `x` is its
  // anchor, which is not its box's left edge for a middle or end anchor.
  const placed: Array<{ box: Rect; label: TopLabel }> = [];
  const rectFor = (text: string, at: number, anchor: TopLabel["anchor"]): Rect => {
    const w = textWidth(text);
    const left = anchor === "start" ? at : anchor === "end" ? at - w : at - w / 2;
    return { x: left, y: 0, width: w, height: 10 };
  };
  const fits = (rect: Rect) => rect.x >= frame.left - 0.5 && rect.x + rect.width <= frame.right + 0.5 && placed.every((p) => !overlaps(p.box, rect, 4));
  /** Place a label, sliding a centred one along x to stay inside the plot. Returns its x, or null. */
  const place = (text: string, at: number, anchor: TopLabel["anchor"], role: TopLabel["role"]) => {
    const rect = rectFor(text, at, anchor);
    let x = at;
    if (anchor === "middle") {
      const slid = Math.min(Math.max(rect.x, frame.left), frame.right - rect.width);
      x += slid - rect.x;
      rect.x = slid;
    }
    if (!fits(rect)) return null;
    placed.push({ box: rect, label: { text, x, anchor, role } });
    return x;
  };
  // Scope labels go first, through the same bounds and overlap check as every
  // other label: right of the rule, else left of it, else the caption says it.
  // "other volume" sits left of the rule only when that side is free.
  const breaks = breakTimes.map((b) => {
    if (place(HISTORY_COPY.scopeChanged, b.x + 4, "start", "scope") !== null) {
      place(HISTORY_COPY.otherVolume, b.x - 4, "end", "other");
      return { ...b, captioned: false };
    }
    return { ...b, captioned: place(HISTORY_COPY.scopeChanged, b.x - 4, "end", "scope") === null };
  });
  // An all-unknown range is one statement ("not measured"), not one long gap:
  // it draws the bands alone, with no hatch to read as a span between values.
  const gaps: DrawnGap[] = (measured.length ? gapSpans(sorted) : []).map((g) => {
    const x0 = Math.max(frame.left, x(g.from));
    const x1 = Math.min(frame.right, x(g.to));
    const mid = (x0 + x1) / 2;
    let label = "";
    let labelX = frame.wide ? place(HISTORY_COPY.gap, mid, "middle", "gap") : null;
    if (labelX !== null) label = HISTORY_COPY.gap;
    else {
      labelX = place(HISTORY_COPY.gapShort, mid, "middle", "gap");
      if (labelX !== null) label = HISTORY_COPY.gapShort;
    }
    return { ...g, x0, x1, label, labelX: labelX ?? mid, captioned: label !== HISTORY_COPY.gap };
  });
  if (future.width > textWidth(HISTORY_COPY.future) + 6) place(HISTORY_COPY.future, future.x + 4, "start", "future");

  return {
    frame,
    domain,
    x,
    y,
    yMax,
    yTicks,
    // A lone point ticks only now: there is no range yet to mark.
    xTicks: timeTicks(domain, x, frame.wide, sorted.length <= 1 ? [] : sparse ? measured.map((p) => p.at) : undefined),
    sparse,
    allUnknown: measured.length === 0,
    measuredCount: measured.length,
    segments,
    dots,
    latest,
    nowMeasured,
    gaps,
    scopeBreaks: breaks,
    bands: thresholdBands(input.thresholds, y, frame.left, frame.right),
    future,
    nowX,
    scenarioLines: lines,
    scenarioLabels,
    markers: clusterMarkers(markersIn, x, frame.left, frame.right),
    topLabels: placed.map((p) => p.label),
  };
}

/* ── Sparkline ────────────────────────────────────────────────────────────── */

interface SparklineGeometry {
  /** One path per measured run; a gap starts a new one. */
  paths: string[];
  /** Runs of a single point, drawn as dots so they do not vanish. */
  dots: Array<{ x: number; y: number }>;
  gaps: number;
  measured: number;
}

/**
 * A small line over its own range, inset by `pad`. Gaps break it exactly as
 * they break the history chart; a flat series sits on the middle line.
 */
export function sparklineGeometry(points: readonly HistoryPoint[], width: number, height: number, pad = 2): SparklineGeometry {
  const sorted = placeable(points);
  const segments = segmentSeries(sorted.map((p) => ({ ...p, otherScope: false })));
  const values = segments.flatMap((s) => s.points.map((p) => p.value));
  const times = sorted.map((p) => p.at);
  const x = linearScale([Math.min(...times), Math.max(...times)], [pad, width - pad]);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const y = lo === hi ? () => height / 2 : linearScale([lo, hi], [height - pad, pad]);
  const xy = segments.map((s) => s.points.map((p) => [times.length > 1 ? x(p.at) : width / 2, y(p.value)] as const));
  return {
    paths: xy.filter((run) => run.length > 1).map(linePath),
    dots: xy.filter((run) => run.length === 1).map((run) => ({ x: run[0]![0], y: run[0]![1] })),
    gaps: gapSpans(sorted).length,
    measured: values.length,
  };
}
