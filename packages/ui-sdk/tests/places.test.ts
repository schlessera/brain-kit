/**
 * The `map` block's plan (#44), asserted with literal inputs.
 *
 * Every figure below was worked out from the coordinates, not read back from
 * the code: the Ithaca-Troy distance is the haversine of the two Wikipedia
 * geotags in the kit's `fixtures/places.ts`, and the heights and modes are the
 * ladder in the design on the issue.
 */

import { describe, expect, test } from "bun:test";

import { BLOCK_SCHEMA, planPlaces, SHOW_BLOCK_INPUT_SCHEMA } from "../src/client/index.ts";
import {
  drawnBounds,
  formatDistance,
  haversineKm,
  MAX_FRAME_DEGREES,
  numberRuns,
} from "../src/places.js";
import { type MapPlace } from "../src/tool-contracts/blocks.js";

const VATHY = { label: "Vathy", lat: 38.3647, lon: 20.7202 };
const TROY = { label: "Hisarlik", lat: 39.9575, lon: 26.2389 };

/** `count` places in and around Vathy's harbour, ~100 m apart. */
function town(count: number): MapPlace[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `Place ${i + 1}`,
    lat: 38.36 + (i % 6) * 0.001,
    lon: 20.715 + Math.floor(i / 6) * 0.001,
  }));
}

function parses(places: unknown[]): boolean {
  return BLOCK_SCHEMA.safeParse({ kind: "map", places }).success;
}

describe("rows", () => {
  test("every place is exactly one row, in input order, numbered from 1, at every N from 1 to 30", () => {
    for (let n = 1; n <= 30; n++) {
      const places = town(n);
      const { rows } = planPlaces(places);
      expect(rows).toHaveLength(n);
      expect(rows.map((r) => r.n)).toEqual(places.map((_, i) => i + 1));
      expect(rows.map((r) => r.label)).toEqual(places.map((p) => p.label));
    }
  });

  test("a place with no position, at 0, 0, or past 85° is a row with a reason and no pin", () => {
    const { rows } = planPlaces([
      { label: "Raft timber stand" },
      { label: "Null island", lat: 0, lon: 0 },
      { label: "Far north", lat: 86, lon: 20 },
      VATHY,
    ]);
    expect(rows.map((r) => [r.pinned, r.unpinnedWhy])).toEqual([
      [false, "no position"],
      [false, "0, 0 is usually a missing value"],
      [false, "beyond the map's ±85°"],
      [true, undefined],
    ]);
    // The given coordinate still shows where there is one: the reader sees
    // what was claimed and why it was not drawn.
    expect(rows[1]!.coord).toBe("0, 0");
    expect(rows[0]!.coord).toBeUndefined();
  });

  test("a coordinate is trimmed to 4 dp and never padded; its digits say how precise it can be", () => {
    const { rows } = planPlaces([
      { label: "a", lat: 38.1, lon: 20.7 },
      { label: "b", lat: 38.123456, lon: 20.765432 },
      { label: "c", lat: 38, lon: 20 },
      { label: "d", lat: 38.37, lon: 20.72 },
      { label: "e", lat: 38.365, lon: 20.7202 },
    ]);
    expect(rows.map((r) => [r.coord, r.precision])).toEqual([
      ["38.1, 20.7", "to ~10 km"],
      ["38.1235, 20.7654", undefined],
      ["38, 20", "to ~100 km"],
      ["38.37, 20.72", "to ~1 km"],
      // The coarser of the two digits governs.
      ["38.365, 20.7202", "to ~100 m"],
    ]);
  });

  test("accuracy and source are stated as given", () => {
    const { rows } = planPlaces([
      { ...VATHY, accuracyM: 50, source: "notes/voyage.md", meta: "09:40" },
      { label: "far", lat: 38.37, lon: 20.72, accuracyM: 1500 },
    ]);
    expect(rows[0]).toMatchObject({ accuracy: "±50 m, as stated", source: "notes/voyage.md", meta: "09:40" });
    expect(rows[1]!.accuracy).toBe("±1.5 km, as stated");
  });
});

describe("the schema", () => {
  test("31 places is a rejection: no client path truncates", () => {
    expect(parses(town(30))).toBe(true);
    expect(parses(town(31))).toBe(false);
  });

  test("lat without lon, or lon without lat, is a rejection", () => {
    expect(parses([{ label: "half", lat: 38 }])).toBe(false);
    expect(parses([{ label: "half", lon: 20 }])).toBe(false);
    expect(parses([{ label: "none" }])).toBe(true);
  });

  test("out-of-range coordinates and an empty label are rejections", () => {
    expect(parses([{ label: "x", lat: 91, lon: 0 }])).toBe(false);
    expect(parses([{ label: "x", lat: 0, lon: 181 }])).toBe(false);
    expect(parses([{ label: "", lat: 38, lon: 20 }])).toBe(false);
    expect(parses([])).toBe(false);
  });

  test("drawing fields the model might send are stripped and change nothing", () => {
    const places = [VATHY, { label: "Harbour steps", lat: 38.3651, lon: 20.7188 }];
    const input = SHOW_BLOCK_INPUT_SCHEMA.parse({
      block: {
        kind: "map",
        places: places.map((p) => ({ ...p, n: 7, tone: "red" })),
        spanKm: 400,
        zoom: 3,
        height: 320,
      },
    });
    expect(input.block).toEqual({ kind: "map", places });
    if (input.block.kind !== "map") throw new Error("unreachable");
    expect(planPlaces(input.block.places)).toEqual(planPlaces(places));
  });
});

describe("the density ladder", () => {
  test("labels ride the map only for three or fewer pins, all of them 18 characters or less", () => {
    expect(planPlaces([VATHY, { label: "Troy", lat: 38.37, lon: 20.72 }]).onMapLabels).toBe(true);
    const long = "Nineteen characters"; // 19
    expect(long).toHaveLength(19);
    expect(planPlaces([VATHY, { label: long, lat: 38.37, lon: 20.72 }]).onMapLabels).toBe(false);
    expect(planPlaces([VATHY, { label: "x".repeat(18), lat: 38.37, lon: 20.72 }]).onMapLabels).toBe(true);
    expect(planPlaces(town(4)).onMapLabels).toBe(false);
    // An unpinned place's label is not on the map, so it does not count.
    expect(planPlaces([VATHY, { label: long }]).onMapLabels).toBe(true);
  });

  test("the frame height follows the pin count: 1-3 → 170, 4-9 → 200, 10-30 → 260", () => {
    const height = (n: number) => planPlaces(town(n)).frames[0]!.height;
    expect([1, 2, 3].map(height)).toEqual([170, 170, 170]);
    expect([4, 9].map(height)).toEqual([200, 200]);
    expect([10, 30].map(height)).toEqual([260, 260]);
  });

  test("eight pins in one town are one map holding all eight", () => {
    const plan = planPlaces(town(8));
    expect(plan.mode).toBe("map");
    expect(plan.reason).toBeUndefined();
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]!.pins.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("extents", () => {
  test("Ithaca and Troy are a pair, each frame inside 5°, 508 km apart by haversine", () => {
    // Computed separately (Python's math module, the same haversine on the
    // IUGG mean radius, 6371.0088 km): 507.59 km, which is 508 at three
    // figures. The design's own sketch says 508.
    expect(haversineKm(VATHY, TROY)).toBeCloseTo(507.59, 2);
    const plan = planPlaces([VATHY, TROY]);
    expect(plan.mode).toBe("pair");
    expect(plan.reason).toBe("Too far apart for one map · 508 km between them");
    expect(plan.frames.map((f) => f.caption)).toEqual(["1 · Vathy", "2 · Hisarlik"]);
    for (const f of plan.frames) {
      expect(f.bbox[2] - f.bbox[0]).toBeLessThanOrEqual(MAX_FRAME_DEGREES);
      expect(f.bbox[3] - f.bbox[1]).toBeLessThanOrEqual(MAX_FRAME_DEGREES);
    }
  });

  test("three groups across 12° are a list, measured at the widest pair", () => {
    const places = [
      { label: "Ogygia", lat: 36.05, lon: 14.25 },
      { label: "Ithaca", lat: 38.3647, lon: 20.7202 },
      { label: "Troy", lat: 39.9575, lon: 26.2389 },
    ];
    const plan = planPlaces(places);
    expect(plan.mode).toBe("list");
    expect(plan.frames).toEqual([]);
    const widest = haversineKm(places[0]!, places[2]!);
    expect(plan.reason).toBe(`Too spread out to draw · ${formatDistance(widest)} across`);
    // Ogygia to Troy, computed the same way: 1,135.56 km.
    expect(widest).toBeCloseTo(1135.56, 2);
    expect(plan.reason).toBe("Too spread out to draw · 1,140 km across");
  });

  test("longitudes either side of ±180° are a list, not a map across the world", () => {
    const plan = planPlaces([
      { label: "east", lat: -17, lon: 179.5 },
      { label: "west", lat: -17, lon: -179.5 },
    ]);
    expect(plan.mode).toBe("list");
    expect(plan.reason).toBe("Spans the date line; not drawn");
  });

  test("no usable position at all is a list that says so", () => {
    const plan = planPlaces([{ label: "a" }, { label: "b", lat: 0, lon: 0 }]);
    expect(plan).toMatchObject({ mode: "list", reason: "No positions given", frames: [] });
  });

  test("a frame covers what MapView draws at both ends of the width range, and never passes 5°", () => {
    for (const places of [[VATHY], town(8), town(30), [VATHY, { label: "b", lat: 38.9, lon: 20.2 }]]) {
      const plan = planPlaces(places);
      expect(plan.mode).toBe("map");
      const [f] = plan.frames;
      for (const width of [238, 300, 420]) {
        const [w, s, e, n] = drawnBounds(f!.pins, { width, height: f!.height, spanKm: f!.spanKm });
        expect(w).toBeGreaterThanOrEqual(f!.bbox[0] - 1e-9);
        expect(s).toBeGreaterThanOrEqual(f!.bbox[1] - 1e-9);
        expect(e).toBeLessThanOrEqual(f!.bbox[2] + 1e-9);
        expect(n).toBeLessThanOrEqual(f!.bbox[3] + 1e-9);
      }
      expect(f!.bbox[2] - f!.bbox[0]).toBeLessThanOrEqual(MAX_FRAME_DEGREES);
      expect(f!.bbox[3] - f!.bbox[1]).toBeLessThanOrEqual(MAX_FRAME_DEGREES);
    }
  });

  test("a lone pin's stated accuracy draws its ring only when the ring fits a frame", () => {
    expect(planPlaces([{ ...VATHY, accuracyM: 500 }]).frames[0]!.accuracyM).toBe(500);
    expect(planPlaces([{ ...VATHY, accuracyM: 500 }]).frames[0]!.spanKm).toBe(3);
    // 100 km is a 600 km span: stated in the row, not drawn.
    const wide = planPlaces([{ ...VATHY, accuracyM: 100_000 }]);
    expect(wide.mode).toBe("map");
    expect(wide.frames[0]!.accuracyM).toBeUndefined();
    expect(wide.rows[0]!.accuracy).toBe("±100 km, as stated");
    // Beside another pin it is never drawn.
    expect(planPlaces([{ ...VATHY, accuracyM: 50 }, { label: "b", lat: 38.37, lon: 20.72 }]).frames[0]!.accuracyM).toBeUndefined();
  });
});

describe("formatting", () => {
  test("distances are three significant figures, grouped", () => {
    expect(formatDistance(508.3)).toBe("508 km");
    expect(formatDistance(1213.4)).toBe("1,210 km");
    expect(formatDistance(1876)).toBe("1,880 km");
  });

  test("a frame's numbers read as runs", () => {
    expect(numberRuns([1, 2, 3])).toBe("1–3");
    expect(numberRuns([4, 1, 6, 7, 8])).toBe("1, 4, 6–8");
    expect(numberRuns([2])).toBe("2");
  });
});
