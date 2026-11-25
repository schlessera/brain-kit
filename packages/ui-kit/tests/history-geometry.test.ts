// The storage history chart's geometry (#4543). Every rule that carries
// meaning on the chart is asserted here on numbers, not read off a picture:
// gaps break and are never bridged, a measured zero stays plotted, a scope
// change breaks the series, scenarios are lines and never a cone (#4537 D9),
// and labels keep their distance.

import { describe, expect, test } from "bun:test";

import {
  DAY,
  FUTURE_SHARE,
  GUTTER_MIN_WIDTH,
  HISTORY_COPY,
  MARKER_CLUSTER_GAP,
  SCENARIO_LABEL_GAP,
  TICK_MIN_GAP,
  chartFrame,
  clipSegment,
  clusterLabel,
  clusterMarkers,
  gapSpans,
  historyLayout,
  linearScale,
  niceCeil,
  projectionReasonText,
  scenarioLines,
  scopeBreaks,
  segmentSeries,
  sparklineGeometry,
  spreadLabels,
  subpathCount,
  thresholdBands,
  timeDomain,
  timeTicks,
  valueMax,
  valueTicks,
  type HistoryEvidenceReason,
  type HistoryPoint,
  type HistoryScenario,
} from "../src/storage/history-geometry.ts";

const H = 3_600_000;
const GB = 1e9;
const T0 = Date.UTC(2026, 5, 26, 12);

/** Six-hourly points from T0; `null` entries are gaps. */
function series(values: Array<number | null>, opts: { provisionalLast?: boolean; otherBefore?: number } = {}): HistoryPoint[] {
  return values.map((value, i) => ({
    at: T0 + i * 6 * H,
    value,
    provisional: opts.provisionalLast && i === values.length - 1 ? true : undefined,
    otherScope: opts.otherBefore !== undefined && i < opts.otherBefore ? true : undefined,
  }));
}

/** Every x a path visits, from its M/L commands. */
function pathXs(d: string): number[] {
  return [...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => Number(m[1]));
}

describe("scales", () => {
  test("a linear scale maps its domain onto its range, inverted ranges included", () => {
    const y = linearScale([0, 40], [208, 8]);
    expect(y(0)).toBe(208);
    expect(y(40)).toBe(8);
    expect(y(10)).toBe(158);
  });

  test("a zero-width domain maps to the range start rather than NaN", () => {
    expect(linearScale([5, 5], [10, 90])(5)).toBe(10);
  });

  test("a nice maximum has short quarters and halves", () => {
    expect(niceCeil(39.1)).toBe(40);
    expect(niceCeil(46)).toBe(50);
    expect(niceCeil(1.1)).toBe(1.2);
    expect(niceCeil(2.1)).toBe(2.4);
    expect(niceCeil(0.29)).toBeCloseTo(0.3);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
    for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8]) {
      for (const tick of valueTicks(m, true)) expect(String(Number(tick.toPrecision(3))).replace(/^0\.|\./, "").length).toBeLessThanOrEqual(3);
    }
  });

  test("the y max is the next round step above 1.15 x the largest level, in four equal steps", () => {
    // The brief's fixture: a 34 GB series reads 0-40 GB.
    expect(valueMax([34 * GB, 16.4 * GB])).toBe(40 * GB);
    // A series at a round number still clears the 15% headroom.
    expect(valueMax([40 * GB])).toBe(50 * GB);
    // Thresholds count, so the bands stay on the chart when the series is low.
    expect(valueMax([2 * GB, 16.1 * GB])).toBe(20 * GB);
    expect(valueMax([])).toBe(4);
    expect(valueMax([0, 0])).toBe(4);
  });

  test("y ticks: 0, half and max on a phone; quarters from 600px", () => {
    expect(valueTicks(40, false)).toEqual([0, 20, 40]);
    expect(valueTicks(40, true)).toEqual([0, 10, 20, 30, 40]);
  });

  test("the future zone is a fifth of the plot, so now sits at 80%", () => {
    const pts = series([1, 2, 3]);
    const d = timeDomain(pts, pts[2]!.at, 6 * H, false);
    expect((d.now - d.start) / (d.end - d.start)).toBeCloseTo(1 - FUTURE_SHARE, 9);
  });

  test("a single point gets sixteen intervals of plot before it, four days at six hours", () => {
    const now = T0;
    const d = timeDomain([{ at: now, value: 1 }], now, 6 * H, false);
    expect(d.now - d.start).toBe(4 * DAY);
  });

  test("a sparse series starts half an interval early so its first dot clears the axis", () => {
    const pts = [
      { at: T0, value: 3 },
      { at: T0 + 7 * DAY, value: 2 },
      { at: T0 + 14 * DAY, value: 1 },
    ];
    expect(timeDomain(pts, T0 + 14 * DAY, 7 * DAY, true).start).toBe(T0 - 3.5 * DAY);
    expect(timeDomain(pts, T0 + 14 * DAY, 7 * DAY, false).start).toBe(T0);
  });
});

describe("gaps are never interpolated", () => {
  test("a null point splits the series into two runs", () => {
    const runs = segmentSeries(series([30, 29, null, 27, 26]));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.points.map((p) => p.value))).toEqual([
      [30, 29],
      [27, 26],
    ]);
  });

  test("the drawn line has two subpaths around a null point, and neither crosses the gap", () => {
    const pts = series([30, 29, null, 27, 26]);
    const layout = historyLayout({ width: 880, points: pts, now: pts[4]!.at });
    const lines = layout.segments.map((s) => s.line).filter(Boolean);
    expect(lines.map(subpathCount)).toEqual([1, 1]);
    expect(subpathCount(lines.join(" "))).toBe(2);
    // The hatch runs between the gap's measured neighbours; no line enters it.
    const [gap] = layout.gaps;
    expect(gap).toBeDefined();
    for (const d of [...lines, ...layout.segments.map((s) => s.area)]) {
      for (const x of pathXs(d)) expect(x <= gap!.x0 + 0.01 || x >= gap!.x1 - 0.01).toBe(true);
    }
    expect(gap!.x0).toBeCloseTo(layout.x(pts[1]!.at), 6);
    expect(gap!.x1).toBeCloseTo(layout.x(pts[3]!.at), 6);
  });

  test("a measured zero is a value: one run, plotted on the baseline", () => {
    const pts = series([12, 0, 9]);
    const runs = segmentSeries(pts);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.points.map((p) => p.value)).toEqual([12, 0, 9]);
    const layout = historyLayout({ width: 320, points: pts, now: pts[2]!.at });
    expect(layout.gaps).toEqual([]);
    expect(subpathCount(layout.segments[0]!.line)).toBe(1);
    const zero = layout.segments[0]!.points[1]!;
    expect(zero.value).toBe(0);
    expect(zero.y).toBe(layout.frame.bottom);
  });

  test("a non-finite value is a gap too, never a number", () => {
    expect(segmentSeries(series([3, Number.NaN, 1]))).toHaveLength(2);
  });

  test("gap spans run between measured neighbours and keep the unobserved buckets for the caption", () => {
    const pts = series([30, null, null, 27]);
    expect(gapSpans(pts)).toEqual([{ from: pts[0]!.at, to: pts[3]!.at, first: pts[1]!.at, last: pts[2]!.at, count: 2 }]);
  });

  test("a gap at either end is bounded by its own buckets", () => {
    const pts = series([null, 5, 4, null]);
    expect(gapSpans(pts)).toEqual([
      { from: pts[0]!.at, to: pts[1]!.at, first: pts[0]!.at, last: pts[0]!.at, count: 1 },
      { from: pts[2]!.at, to: pts[3]!.at, first: pts[3]!.at, last: pts[3]!.at, count: 1 },
    ]);
  });

  test("an all-unknown series draws no line and no point", () => {
    const layout = historyLayout({ width: 320, points: series([null, null, null]) });
    expect(layout.allUnknown).toBe(true);
    expect(layout.segments).toEqual([]);
    expect(layout.latest).toBeNull();
    expect(layout.dots).toEqual([]);
    // One statement, not one long gap: no hatch.
    expect(layout.gaps).toEqual([]);
  });

  test("a point standing alone between gaps is drawn as a dot, so it does not vanish", () => {
    const layout = historyLayout({ width: 320, points: series([...Array(30).fill(5), null, 4, null, ...Array(30).fill(3)]) });
    expect(layout.sparse).toBe(false);
    expect(layout.dots.map((d) => d.value)).toEqual([4]);
  });
});

describe("scope change", () => {
  test("points from another volume are their own run, never joined to the current one", () => {
    const runs = segmentSeries(series([36, 35, 34, 22, 21], { otherBefore: 3 }));
    expect(runs.map((r) => [r.kind, r.points.length])).toEqual([
      ["other", 3],
      ["current", 2],
    ]);
  });

  test("the break sits halfway between the last other-volume point and the first current one", () => {
    const pts = series([36, 35, 22], { otherBefore: 2 });
    expect(scopeBreaks(pts)).toEqual([(pts[1]!.at + pts[2]!.at) / 2]);
  });

  test("no scenario line starts from another volume's number", () => {
    const pts = series([36, 35, 34], { otherBefore: 3 });
    const layout = historyLayout({
      width: 880,
      points: pts,
      scenarios: [{ window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: pts[2]!.at + 8 * DAY, value: 0 } }],
    });
    expect(layout.scenarioLines).toEqual([]);
  });
});

describe("bands", () => {
  const y = linearScale([0, 40], [208, 8]);
  test("Very low runs from zero to its level; Low from Very low to its own", () => {
    const bands = thresholdBands({ low: 16, veryLow: 8 }, y, 56, 730);
    expect(bands).toEqual([
      { kind: "veryLow", level: 8, x: 56, y: y(8), width: 674, height: 208 - y(8), edgeY: y(8) },
      { kind: "low", level: 16, x: 56, y: y(16), width: 674, height: y(8) - y(16), edgeY: y(16) },
    ]);
  });

  test("a missing or non-positive level draws no band, and Low alone reaches zero", () => {
    expect(thresholdBands(undefined, y, 0, 10)).toEqual([]);
    expect(thresholdBands({ low: 0, veryLow: -1 }, y, 0, 10)).toEqual([]);
    const [low] = thresholdBands({ low: 16 }, y, 0, 10);
    expect(low!.y + low!.height).toBe(208);
  });

  test("a level above the plot is clamped to its top", () => {
    const [low] = thresholdBands({ low: 400 }, y, 0, 10);
    expect(low!.y).toBe(8);
  });
});

describe("scenarios: one line per qualified window, never a cone", () => {
  const box = { left: 56, right: 730, top: 8, bottom: 208 };

  test("clipping stops at the right edge, the baseline or the top, whichever comes first", () => {
    expect(clipSegment(500, 100, 900, 150, box)).toEqual({ x: 730, y: 128.75 });
    expect(clipSegment(500, 100, 600, 300, box)).toEqual({ x: 554, y: 208 });
    expect(clipSegment(500, 100, 600, -100, box)).toEqual({ x: 546, y: 8 });
    // An endpoint inside the plot is kept: the line is never extended.
    expect(clipSegment(500, 100, 600, 150, box)).toEqual({ x: 600, y: 150 });
  });

  test("an unavailable window draws nothing; each qualified one draws exactly one two-point line", () => {
    const x = linearScale([0, 100], [56, 730]);
    const y = linearScale([0, 40], [208, 8]);
    const scenarios: HistoryScenario[] = [
      { window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: 120, value: 0 } },
      { window: "long", name: "30-day", reason: "under 30 days of history" },
    ];
    const lines = scenarioLines(scenarios, { x: x(80), y: y(16) }, x, y, box);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.scenario.window).toBe("short");
    expect(scenarioLines([scenarios[1]!], { x: 0, y: 0 }, x, y, box)).toEqual([]);
    expect(scenarioLines(scenarios, null, x, y, box)).toEqual([]);
  });

  test("two windows give two separate lines and no filled shape reaches into the future", () => {
    const pts = series([34, 30, 26, 22, 18, 16.4].map((v) => v * GB), { provisionalLast: true });
    const now = pts[5]!.at;
    const layout = historyLayout({
      width: 880,
      points: pts,
      now,
      scenarios: [
        { window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: now + 8 * DAY, value: 0 } },
        { window: "long", name: "30-day", detail: "empty ~28 Jul", to: { at: now + 16 * DAY, value: 0 } },
      ],
    });
    expect(layout.scenarioLines).toHaveLength(2);
    for (const line of layout.scenarioLines) {
      expect(line.x1).toBeCloseTo(layout.latest!.x, 6);
      expect(line.y1).toBeCloseTo(layout.latest!.y, 6);
    }
    // The only filled shapes the series makes are its areas, and every one of
    // them ends at now: nothing joins the two lines.
    for (const s of layout.segments) for (const x of pathXs(s.area)) expect(x).toBeLessThanOrEqual(layout.nowX + 0.01);
  });

  test("gutter labels exist only from 600px, sit 28px apart and keep the lines' order", () => {
    const pts = series([34, 30, 26, 22, 18, 16.4].map((v) => v * GB));
    const now = pts[5]!.at;
    const scenarios: HistoryScenario[] = [
      { window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: now + 30 * DAY, value: 0 } },
      { window: "long", name: "30-day", detail: "empty ~28 Jul", to: { at: now + 32 * DAY, value: 0 } },
    ];
    expect(historyLayout({ width: 599, points: pts, now, scenarios }).scenarioLabels).toEqual([]);
    const wide = historyLayout({ width: 600, points: pts, now, scenarios });
    expect(wide.scenarioLabels).toHaveLength(2);
    const [a, b] = wide.scenarioLabels;
    // The two lines exit within a few px of each other: the labels had to move.
    expect(Math.abs(a!.line.y2 - b!.line.y2)).toBeLessThan(28);
    expect(SCENARIO_LABEL_GAP).toBe(28);
    expect(Math.abs(a!.y - b!.y)).toBeGreaterThanOrEqual(28 - 1e-9);
    // The line ending lower (7-day, steeper) keeps the lower label.
    expect(a!.line.y2 > b!.line.y2).toBe(a!.y > b!.y);
  });
});

describe("label collision", () => {
  test("labels closer than the gap are pushed apart symmetrically, in order", () => {
    const out = spreadLabels([100, 110], 28, 0, 300);
    expect(out[1]! - out[0]!).toBeCloseTo(28, 9);
    expect((out[0]! + out[1]!) / 2).toBeCloseTo(105, 9);
  });

  test("labels already apart do not move", () => {
    expect(spreadLabels([10, 50, 200], 28, 0, 300)).toEqual([10, 50, 200]);
  });

  test("the input order is preserved in the output, whatever order the positions come in", () => {
    const out = spreadLabels([110, 100], 28, 0, 300);
    expect(out[0]! > out[1]!).toBe(true);
  });

  test("a crowd at the bottom bound is pushed back up inside it", () => {
    const out = spreadLabels([295, 298, 299], 28, 0, 300);
    expect(Math.max(...out)).toBeLessThanOrEqual(300);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(28 - 1e-9);
  });
});

describe("ticks", () => {
  const pts = Array.from({ length: 64 }, (_, i) => ({ at: T0 + i * 6 * H, value: 20 }));
  const now = pts[63]!.at;

  test("a phone gets the start, one whole-day midpoint and now", () => {
    const layout = historyLayout({ width: 296, points: pts, now });
    expect(layout.xTicks).toHaveLength(3);
    expect(layout.xTicks[0]!.at).toBe(layout.domain.start);
    expect(layout.xTicks[1]!.at % DAY).toBe(0);
    expect(layout.xTicks[2]).toMatchObject({ at: now, now: true });
  });

  test("the six-hour tier at 880px ticks every four days", () => {
    const layout = historyLayout({ width: 880, points: pts, now });
    const inner = layout.xTicks.slice(1, -1).map((t) => t.at);
    expect(inner.length).toBeGreaterThan(1);
    for (let i = 1; i < inner.length; i += 1) expect(inner[i]! - inner[i - 1]!).toBe(4 * DAY);
    for (const at of inner) expect(at % DAY).toBe(0);
  });

  test("ninety daily points tick every two weeks; thirty-two weekly ones every two months", () => {
    const daily = Array.from({ length: 90 }, (_, i) => ({ at: T0 + i * DAY, value: 20 }));
    const d = historyLayout({ width: 880, points: daily, now: daily[89]!.at }).xTicks.slice(1, -1);
    expect(d[1]!.at - d[0]!.at).toBe(14 * DAY);
    const weekly = Array.from({ length: 32 }, (_, i) => ({ at: T0 + i * 7 * DAY, value: 20 }));
    const w = historyLayout({ width: 880, points: weekly, now: weekly[31]!.at }).xTicks.slice(1, -1);
    expect(w[1]!.at - w[0]!.at).toBe(61 * DAY);
  });

  test("no two ticks sit closer than 48px, and none within 48px of now", () => {
    for (const width of [240, 296, 600, 880, 1280]) {
      const ticks = historyLayout({ width, points: pts, now }).xTicks;
      for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!.x - ticks[i - 1]!.x).toBeGreaterThanOrEqual(48);
    }
    expect(TICK_MIN_GAP).toBe(48);
  });

  test("a tick that would crowd now is dropped rather than moved", () => {
    // Start (0px) and the midpoint (21px) both sit within 48px of now (42px).
    const narrow = timeTicks({ start: 0, now: 60 * DAY, end: 100 * DAY }, linearScale([0, 100 * DAY], [0, 70]), false);
    expect(narrow.map((t) => t.at)).toEqual([60 * DAY]);
    // At 60px from each other, all three stay.
    const wider = timeTicks({ start: 0, now: 60 * DAY, end: 100 * DAY }, linearScale([0, 100 * DAY], [0, 200]), false);
    expect(wider.map((t) => t.at)).toEqual([0, 30 * DAY, 60 * DAY]);
  });

  test("a sparse series ticks its own points, and a single point only now", () => {
    const weekly = [
      { at: T0, value: 30 },
      { at: T0 + 7 * DAY, value: 22 },
      { at: T0 + 14 * DAY, value: 16, provisional: true },
    ];
    const layout = historyLayout({ width: 296, points: weekly, now: weekly[2]!.at, intervalMs: 7 * DAY });
    expect(layout.sparse).toBe(true);
    expect(layout.xTicks.map((t) => t.at)).toEqual(weekly.map((p) => p.at));
    expect(layout.dots).toHaveLength(3);
    const single = historyLayout({ width: 296, points: [weekly[2]!], now: weekly[2]!.at, intervalMs: 6 * H });
    expect(single.xTicks).toEqual([{ at: weekly[2]!.at, x: single.nowX, now: true }]);
  });
});

describe("provisional point", () => {
  test("the last edge into a provisional point is its own dotted tail, not part of the line", () => {
    const layout = historyLayout({ width: 880, points: series([5, 4, 3, 2], { provisionalLast: true }) });
    const [s] = layout.segments;
    expect(pathXs(s!.line)).toHaveLength(3);
    expect(pathXs(s!.tail)).toHaveLength(2);
    expect(layout.latest!.provisional).toBe(true);
  });

  test("without a provisional point there is no tail", () => {
    const layout = historyLayout({ width: 880, points: series([5, 4, 3]) });
    expect(layout.segments[0]!.tail).toBe("");
  });
});

describe("event markers", () => {
  const x = linearScale([0, 100], [0, 100]);
  test("markers under 20px from the cluster's last marker share one box", () => {
    const clusters = clusterMarkers(
      [
        { at: 10, n: 1, label: "a" },
        { at: 50, n: 2, label: "b" },
        { at: 50 + MARKER_CLUSTER_GAP - 7, n: 3, label: "c" },
      ],
      x,
      0,
      100,
    );
    expect(clusters.map((c) => c.label)).toEqual(["1", "2–3"]);
    expect(clusters[1]!.x).toBeCloseTo(56.5, 9);
  });

  test("the walk compares to the LAST marker, so a chain of close markers is one cluster", () => {
    const clusters = clusterMarkers(
      [0, 15, 30, 45].map((at, i) => ({ at, n: i + 1, label: String(i) })),
      x,
      0,
      100,
    );
    expect(clusters.map((c) => c.label)).toEqual(["1–4"]);
  });

  test("a cluster of non-consecutive numbers lists them", () => {
    expect(clusterLabel([5, 2])).toBe("2, 5");
    expect(clusterLabel([2, 3, 4])).toBe("2–4");
  });

  test("boxes never overlap and stay inside the plot", () => {
    // 21px apart: six clusters, each box wider than the space between them.
    const clusters = clusterMarkers(
      [0, 21, 42, 63, 84, 100].map((at, i) => ({ at, n: i + 10, label: String(i) })),
      linearScale([0, 100], [0, 200]),
      0,
      200,
    );
    expect(clusters).toHaveLength(6);
    const boxes = clusters.map((c) => [c.boxX - c.boxWidth / 2, c.boxX + c.boxWidth / 2] as const);
    for (const [a, b] of boxes) {
      expect(a).toBeGreaterThanOrEqual(-1e-9);
      expect(b).toBeLessThanOrEqual(200 + 1e-9);
    }
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]![0]).toBeGreaterThanOrEqual(boxes[i - 1]![1]);
  });
});

describe("layout", () => {
  test("the gutter starts at exactly 600px", () => {
    // Literals, not the constant: the ruling is 600px, and a test that read the
    // constant back would follow it anywhere.
    expect(GUTTER_MIN_WIDTH).toBe(600);
    expect(chartFrame(599, false).wide).toBe(false);
    expect(chartFrame(600, false)).toMatchObject({ wide: true, left: 56, right: 450, top: 8, bottom: 208 });
    expect(chartFrame(296, true)).toMatchObject({ wide: false, left: 44, right: 284, bottom: 158, height: 206 });
  });

  test("a gap keeps its full label at the top of the hatch from 600px; a phone shows ? and captions it", () => {
    const pts = series([30, 29, null, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    const wide = historyLayout({ width: 880, points: pts });
    expect(wide.gaps[0]).toMatchObject({ label: HISTORY_COPY.gap, captioned: false });
    const narrow = historyLayout({ width: 296, points: pts });
    expect(narrow.gaps[0]).toMatchObject({ label: HISTORY_COPY.gapShort, captioned: true });
  });

  test("the scope labels always stay; a colliding future label goes first", () => {
    const pts = series([36, 35, 34, 33, 32, 31, 22, 21], { otherBefore: 7 });
    const layout = historyLayout({ width: 296, points: pts });
    const roles = layout.topLabels.map((l) => l.role);
    expect(roles).toContain("scope");
    expect(roles).not.toContain("future");
  });

  test("the same input lays out identically", () => {
    const pts = series([30, null, 28, 27]);
    expect(JSON.stringify(historyLayout({ width: 500, points: pts }))).toBe(JSON.stringify(historyLayout({ width: 500, points: pts })));
  });
});

describe("projection reason copy", () => {
  test("every reason has the approved words", () => {
    const table: Array<[HistoryEvidenceReason, number | undefined, string]> = [
      ["no-observation", undefined, "no measurements yet"],
      ["stale", undefined, "latest measurement is out of date"],
      ["future", undefined, "measurement time is ahead of the clock"],
      ["incomplete", undefined, "latest measurement is incomplete"],
      ["changed-scope", undefined, "volume changed in the window"],
      ["changed-capacity", undefined, "volume size changed in the window"],
      ["gap", 7, "gap inside the 7-day window"],
      ["ordering", undefined, "measurements out of order"],
      ["insufficient-count", 3, "too few measurements (needs 3)"],
      ["insufficient-span", 30, "under 30 days of history"],
      ["mixed-direction", undefined, "space went up and down; no steady rate"],
      ["single-burst", undefined, "one burst, not a steady rate"],
      ["arithmetic", undefined, "couldn't compute a rate"],
    ];
    for (const [reason, n, text] of table) expect(projectionReasonText(reason, n)).toBe(text);
  });
});

describe("sparkline", () => {
  const pts = (values: Array<number | null>) => values.map((value, i) => ({ at: T0 + i * 6 * H, value }));

  test("a gap breaks the line into two paths", () => {
    const g = sparklineGeometry(pts([1, 2, null, 4, 5]), 120, 24);
    expect(g.paths).toHaveLength(2);
    expect(g.gaps).toBe(1);
    for (const d of g.paths) expect(subpathCount(d)).toBe(1);
  });

  test("an unknown series draws nothing", () => {
    const g = sparklineGeometry(pts([null, null]), 120, 24);
    expect(g).toEqual({ paths: [], dots: [], gaps: 1, measured: 0 });
  });

  test("the line spans its own range inside the padding; a flat one sits on the middle", () => {
    const g = sparklineGeometry(pts([10, 20]), 120, 24);
    expect(g.paths[0]).toBe("M2 22 L118 2");
    expect(sparklineGeometry(pts([7, 7]), 120, 24).paths[0]).toBe("M2 12 L118 12");
  });

  test("a lone point between gaps is a dot", () => {
    expect(sparklineGeometry(pts([1, 2, null, 3, null, 4, 5]), 120, 24).dots).toHaveLength(1);
  });
});
