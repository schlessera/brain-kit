import { describe, expect, test } from "bun:test";
import { geometryPaths, spanFor, viewBox } from "../src/components/chat/tool-cards/location-card.js";

// The card's pure half: the span a fix earns, the box the map will draw and
// the geometry's weights. Rendering is covered in tests/render/render-smoke.test.tsx.

describe("spanFor", () => {
  test("a good fix gets the kit's town-scale default", () => {
    expect(spanFor(12)).toBe(1.6);
    expect(spanFor(200)).toBe(1.6);
  });
  test("a coarse fix widens the view so the uncertainty fits the frame", () => {
    // 1.2 km of uncertainty: six times over is 7.2 km across the card.
    expect(spanFor(1200)).toBeCloseTo(7.2, 6);
  });
});

describe("viewBox", () => {
  test("is centred on the pin, wider east-west than the span by the map's margin", () => {
    const [w, s, e, n] = viewBox(38.3653, 20.7169, 1.6);
    expect((w + e) / 2).toBeCloseTo(20.7169, 6);
    expect((s + n) / 2).toBeCloseTo(38.3653, 6);
    // 1.6 km at 38°N is 0.0184° of longitude; 24% more for the margins.
    const degLon = (1.6 / 111 / Math.cos((38.3653 * Math.PI) / 180)) * 1.24;
    expect(e - w).toBeCloseTo(degLon, 6);
    // The height follows the card's aspect, not the span.
    expect(n - s).toBeLessThan(e - w);
    expect(n - s).toBeGreaterThan(0);
  });
  test("is never wider than the server accepts, even at a coarse fix near the pole", () => {
    const [w, s, e, n] = viewBox(84, 10, 400);
    expect(e - w).toBeLessThanOrEqual(5);
    expect(n - s).toBeLessThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(89);
  });
  test("clamps at the antimeridian rather than wrapping", () => {
    const [w, , e] = viewBox(0, 179.995, 1.6);
    expect(e).toBe(180);
    expect(w).toBeLessThan(179.995);
  });
});

describe("geometryPaths", () => {
  test("keeps the tiers apart by weight, coastline heaviest, streets lightest", () => {
    const paths = geometryPaths({
      coastline: [[[0, 0], [1, 1]]],
      roads: [[[0, 0], [1, 0]]],
      streets: [[[0, 0], [0, 1]], [[1, 1], [2, 2]]],
      land: [],
      detail: "streets",
      partial: false,
      toleranceM: 2,
      attribution: "x",
    });
    expect(paths.map((p) => p.width)).toEqual([1, 0.6, 0.35, 0.35]);
    expect(new Set(paths.map((p) => p.tone))).toEqual(new Set(["neutral"]));
  });
});
