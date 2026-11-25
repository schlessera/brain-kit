/**
 * CapacityGauge's pure geometry (#4542): which segments a capacity draws,
 * and where the Low and Very low ticks go.
 */
import { describe, expect, test } from "bun:test";

import {
  CAPTION_GLYPH_PX,
  capacityDrawable,
  capacitySegments,
  percentLabel,
  thresholdsValid,
  tickLayout,
} from "../src/storage/capacity-geometry.js";

const GB = 1e9;
/** The brief's Low fixture: 16.4 GB available of 161 GB, 1.2 GB reserved. */
const LOW = { total: 161 * GB, used: 143.4 * GB, free: 17.6 * GB, available: 16.4 * GB };
const THRESHOLDS = { low: 0.1, veryLow: 0.05 };
const LABELS = { low: "Low 10%", veryLow: "Very low 5%" };

describe("capacity segments", () => {
  test("run used → reserved → available and cover the whole track", () => {
    const segments = capacitySegments(LOW)!;
    expect(segments.map((s) => s.kind)).toEqual(["used", "reserved", "available"]);
    expect(segments[0]!.start).toBe(0);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBeCloseTo(segments[i - 1]!.start + segments[i - 1]!.size, 12);
    }
    const last = segments.at(-1)!;
    expect(last.start + last.size).toBeCloseTo(1, 12);
    expect(segments[1]!.size).toBeCloseTo(1.2 / 161, 12);
    expect(last.size).toBeCloseTo(16.4 / 161, 12);
  });

  test("a segment with no bytes is left out, never drawn at zero width", () => {
    const noReserve = capacitySegments({ total: 100, used: 60, free: 40, available: 40 })!;
    expect(noReserve.map((s) => s.kind)).toEqual(["used", "available"]);
    const full = capacitySegments({ total: 100, used: 100, free: 0, available: 0 })!;
    expect(full.map((s) => s.kind)).toEqual(["used"]);
    const allReserved = capacitySegments({ total: 100, used: 90, free: 10, available: 0 })!;
    expect(allReserved.map((s) => s.kind)).toEqual(["used", "reserved"]);
    for (const set of [noReserve, full, allReserved]) for (const s of set) expect(s.size).toBeGreaterThan(0);
  });

  test("figures that cannot be drawn honestly draw no bar", () => {
    const refused = [
      { total: 0, used: 0, free: 0, available: 0 },
      { total: -1, used: 0, free: 0, available: 0 },
      { total: 100, used: 70, free: 40, available: 30 }, // used + free ≠ total
      { total: 100, used: 60, free: 40, available: 41 }, // available > free
      { total: 100, used: -5, free: 105, available: 50 },
      { total: Number.NaN, used: 60, free: 40, available: 30 },
      { total: 100, used: 60, free: 40, available: Number.POSITIVE_INFINITY },
    ];
    for (const c of refused) {
      expect(capacityDrawable(c), JSON.stringify(c)).toBe(false);
      expect(capacitySegments(c), JSON.stringify(c)).toBeNull();
    }
    expect(capacityDrawable(LOW)).toBe(true);
  });
});

describe("threshold ticks", () => {
  test("10% and 5% available sit at 90% and 95% from the used end", () => {
    const layout = tickLayout(296, THRESHOLDS, LABELS);
    expect(layout.low).toBeCloseTo(0.9, 12);
    expect(layout.veryLow).toBeCloseTo(0.95, 12);
    // The brief's measurements: 266.4px and 281.2px on a 296px track.
    expect(layout.low * 296).toBeCloseTo(266.4, 9);
    expect(layout.veryLow * 296).toBeCloseTo(281.2, 9);
    expect(layout.gapPx).toBeCloseTo(14.8, 9);
  });

  test("positions come from the thresholds, not from the figures", () => {
    const layout = tickLayout(400, { low: 0.3, veryLow: 0.2 }, { low: "Low 30%", veryLow: "Very low 20%" });
    expect(layout.low).toBeCloseTo(0.7, 12);
    expect(layout.veryLow).toBeCloseTo(0.8, 12);
  });

  test("every realistic card width merges the two labels into one caption", () => {
    for (const width of [160, 260, 296, 940]) {
      const layout = tickLayout(width, THRESHOLDS, LABELS);
      expect(layout.split, `${width}px`).toBe(false);
      expect(layout.collapsed, `${width}px`).toBe(false);
    }
  });

  test("labels split only when the gap is 18px or more and each label fits beside its tick", () => {
    const wide = { low: 0.3, veryLow: 0.2 };
    const labels = { low: "Low 30%", veryLow: "Very low 20%" };
    // 12 glyphs + key = 87.2px of room needed right of the Very low tick.
    const need = labels.veryLow.length * CAPTION_GLYPH_PX + 8;
    expect(tickLayout(Math.ceil(need / 0.2), wide, labels).split).toBe(true);
    expect(tickLayout(Math.floor(need / 0.2) - 1, wide, labels).split).toBe(false);
    // 18px gap boundary, with labels short enough to fit.
    const short = { low: "L", veryLow: "V" };
    expect(tickLayout(180, wide, short).gapPx).toBeCloseTo(18, 9);
    expect(tickLayout(180, wide, short).split).toBe(true);
    expect(tickLayout(179, wide, short).split).toBe(false);
  });

  test("the ticks collapse into one marker only below a 4px gap", () => {
    expect(tickLayout(80, THRESHOLDS, LABELS).collapsed).toBe(false);
    expect(tickLayout(79, THRESHOLDS, LABELS).collapsed).toBe(true);
  });

  test("an unmeasured track keeps the ticks apart with a merged caption", () => {
    for (const width of [null, 0, Number.NaN]) {
      const layout = tickLayout(width, THRESHOLDS, LABELS);
      expect(layout).toMatchObject({ gapPx: null, collapsed: false, split: false });
      expect(layout.low).toBeCloseTo(0.9, 12);
    }
  });

  test("thresholds must order 0 < veryLow < low < 1", () => {
    expect(thresholdsValid(THRESHOLDS)).toBe(true);
    for (const t of [{ low: 0.05, veryLow: 0.1 }, { low: 0.1, veryLow: 0.1 }, { low: 1, veryLow: 0.5 }, { low: 0.1, veryLow: 0 }, { low: Number.NaN, veryLow: 0.05 }]) {
      expect(thresholdsValid(t), JSON.stringify(t)).toBe(false);
    }
  });

  test("percent labels keep one decimal at most", () => {
    expect(percentLabel(0.1)).toBe("10%");
    expect(percentLabel(0.05)).toBe("5%");
    expect(percentLabel(0.125)).toBe("12.5%");
    expect(percentLabel(0.07)).toBe("7%");
  });
});
