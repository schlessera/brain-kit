import { mapViewBounds } from "@schlessera/brain-ui-kit/internal";
import { planPlaces } from "@schlessera/brain-ui-sdk/client";
import { drawnBounds } from "../../ui-sdk/src/places.js";
import { describe, expect, test } from "bun:test";

import { frameGeometry } from "../src/components/chat/tool-cards/map-block.js";

// The `map` block's pure half (#44). Rendering, the requests and the fallback
// are in tests/render/block-card.test.tsx.

describe("the plan's frame is the box the kit draws", () => {
  // The SDK repeats `MapView`'s bounding-box rule because it cannot import the
  // kit, and the geometry request is only right if the two agree: a box that
  // is too small leaves the edge of the drawing without a coastline. These
  // cases cover one pin, a span minimum, a set wider than it, a tall set that
  // the aspect correction widens, a stated accuracy and a high latitude.
  const cases: { name: string; pins: { lat: number; lon: number }[]; spanKm?: number; accuracyM?: number }[] = [
    { name: "one pin", pins: [{ lat: 38.3647, lon: 20.7202 }] },
    { name: "one pin with a ring", pins: [{ lat: 38.3647, lon: 20.7202 }], accuracyM: 900 },
    {
      name: "a town",
      pins: [
        { lat: 38.3644, lon: 20.7202 },
        { lat: 38.3667, lon: 20.7207 },
        { lat: 38.3612, lon: 20.7224 },
      ],
    },
    {
      name: "a tall set",
      pins: [
        { lat: 38.2, lon: 20.7 },
        { lat: 38.9, lon: 20.71 },
      ],
    },
    {
      name: "a wide set",
      pins: [
        { lat: 38.36, lon: 20.2 },
        { lat: 38.37, lon: 21.4 },
      ],
      spanKm: 3,
    },
    { name: "far north", pins: [{ lat: 78.2232, lon: 15.6267 }] },
  ];

  for (const c of cases) {
    for (const width of [238, 330, 420]) {
      for (const height of [170, 200, 260]) {
        test(`${c.name} at ${width}×${height}`, () => {
          const kit = mapViewBounds(c.pins, { width, height, spanKm: c.spanKm, accuracyM: c.accuracyM });
          const sdk = drawnBounds(c.pins, { width, height, spanKm: c.spanKm, accuracyM: c.accuracyM });
          expect(sdk[0]).toBeCloseTo(kit.mw, 9);
          expect(sdk[1]).toBeCloseTo(kit.latBot, 9);
          expect(sdk[2]).toBeCloseTo(kit.me, 9);
          expect(sdk[3]).toBeCloseTo(kit.latTop, 9);
        });
      }
    }
  }

  test("a planned frame contains what the kit draws for it at every width a card can be", () => {
    const plan = planPlaces([
      { label: "Harbour steps", lat: 38.3644, lon: 20.7202 },
      { label: "Agora well", lat: 38.3667, lon: 20.7207 },
      { label: "Boatyard", lat: 38.3644, lon: 20.7253 },
      { label: "Fish market", lat: 38.3614, lon: 20.7179 },
    ]);
    const [frame] = plan.frames;
    expect(frame).toBeDefined();
    for (let width = 238; width <= 420; width += 13) {
      const kit = mapViewBounds(frame!.pins, { width, height: frame!.height, spanKm: frame!.spanKm });
      expect(kit.mw).toBeGreaterThanOrEqual(frame!.bbox[0] - 1e-9);
      expect(kit.latBot).toBeGreaterThanOrEqual(frame!.bbox[1] - 1e-9);
      expect(kit.me).toBeLessThanOrEqual(frame!.bbox[2] + 1e-9);
      expect(kit.latTop).toBeLessThanOrEqual(frame!.bbox[3] + 1e-9);
    }
  });
});

describe("frameGeometry", () => {
  const empty = {
    coastline: [],
    roads: [],
    streets: [],
    land: [],
    detail: "streets" as const,
    partial: false,
    toleranceM: 5,
    attribution: "© OpenStreetMap contributors",
  };
  const line: [number, number][] = [
    [20.72, 38.36],
    [20.73, 38.37],
  ];

  test("an empty answer is `none`, partial or not: a graticule does not locate a reader", () => {
    expect(frameGeometry(empty)).toBe("none");
    expect(frameGeometry({ ...empty, partial: true })).toBe("none");
  });

  test("a partial answer with geometry in it is drawn, and carries its credit", () => {
    const drawn = frameGeometry({ ...empty, partial: true, streets: [line] });
    expect(drawn).toMatchObject({ attribution: "© OpenStreetMap contributors" });
    expect(typeof drawn === "object" && drawn.paths).toHaveLength(1);
  });

  test("land alone is geometry", () => {
    const ring: [number, number][] = [...line, [20.72, 38.37], [20.72, 38.36]];
    const drawn = frameGeometry({ ...empty, land: [ring] });
    expect(typeof drawn === "object" && drawn.land).toEqual({ rings: [ring] });
  });
});
