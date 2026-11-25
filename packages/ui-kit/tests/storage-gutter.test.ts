import { describe, expect, test } from "bun:test";
import { storageAll, storagePackFolder, storageAppDominant, type StorageEntry } from "../fixtures/storage.js";
import { storageRectangles, storageTiles, TILE_GUTTER } from "../src/storage/storage-geometry.js";

/** The map's inputs as a caller builds them: known positive sizes, children under 1% folded into one aggregate. */
function inputs(entries: readonly StorageEntry[]) {
  const known = entries.filter((e) => e.bytes !== null && e.bytes > 0).sort((a, b) => b.bytes! - a.bytes!);
  const total = known.reduce((sum, e) => sum + e.bytes!, 0);
  const shown = known.filter((e) => e.bytes! / total >= 0.01).map((e) => ({ id: e.id, bytes: e.bytes! }));
  const rest = total - shown.reduce((sum, e) => sum + e.bytes, 0);
  return rest > 0 ? [...shown, { id: "smaller", bytes: rest }] : shown;
}

const EPS = 1e-6;
/** Separation of two boxes: the larger of the horizontal and vertical gaps. Negative or 0 means they overlap or touch. */
const separation = (a: Box, b: Box) =>
  Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The 120px strip, a phone map, the stacked 16:10 map and the side-by-side 4:3 one.
const SIZES = [
  [296, 120],
  [296, 185],
  [600, 375],
  [616, 462],
  [1256, 785],
];
const SETS = { all: storageAll, appDominant: storageAppDominant, packs: storagePackFolder };

describe("storage map gutter (#4544 design feedback)", () => {
  for (const [name, entries] of Object.entries(SETS))
    for (const [w, h] of SIZES)
      test(`${name} at ${w} x ${h}: no two tiles overlap or touch; neighbours are ${TILE_GUTTER}px apart`, () => {
        const tiles = storageTiles(inputs(entries), w, h);
        expect(tiles.length).toBeGreaterThan(1);
        for (let i = 0; i < tiles.length; i++)
          for (let j = i + 1; j < tiles.length; j++) {
            const gap = separation(tiles[i]!, tiles[j]!);
            expect(gap, `STORAGE_TILE_GUTTER: ${tiles[i]!.item.id} / ${tiles[j]!.item.id}`).toBeGreaterThanOrEqual(TILE_GUTTER - EPS);
          }
        for (const tile of tiles) {
          expect(tile.width, `${tile.item.id} keeps fill`).toBeGreaterThanOrEqual(1);
          expect(tile.height, `${tile.item.id} keeps fill`).toBeGreaterThanOrEqual(1);
        }
      });

  test("the outer map edge stays flush and every shared edge is trimmed by half the gutter", () => {
    const items = inputs(storageAll);
    const natural = storageRectangles(items, 616, 462);
    const drawn = storageTiles(items, 616, 462);
    expect(drawn.map((t) => t.item.id)).toEqual(natural.map((t) => t.item.id));
    const half = TILE_GUTTER / 2;
    for (const [i, n] of natural.entries()) {
      const d = drawn[i]!;
      const trim = (outer: boolean) => (outer ? 0 : half);
      expect(d.x - n.x).toBeCloseTo(trim(n.x < EPS), 9);
      expect(d.y - n.y).toBeCloseTo(trim(n.y < EPS), 9);
      expect(n.x + n.width - (d.x + d.width)).toBeCloseTo(trim(n.x + n.width > 616 - EPS), 9);
      expect(n.y + n.height - (d.y + d.height)).toBeCloseTo(trim(n.y + n.height > 462 - EPS), 9);
    }
    // Some tile touches each outer edge: the map is flush, not framed.
    expect(drawn.some((t) => t.x === 0) && drawn.some((t) => t.y === 0)).toBe(true);
    expect(drawn.some((t) => Math.abs(t.x + t.width - 616) < EPS) && drawn.some((t) => Math.abs(t.y + t.height - 462) < EPS)).toBe(true);
  });

  test("a sliver keeps 1px of fill inside the map and still never touches its neighbour", () => {
    const drawn = storageTiles(
      [
        { id: "big", bytes: 1000 },
        { id: "sliver", bytes: 1 },
      ],
      300,
      100,
    );
    const sliver = drawn.find((t) => t.item.id === "sliver")!;
    expect(sliver.width).toBeCloseTo(1, 9);
    expect(sliver.x + sliver.width).toBeLessThanOrEqual(300 + EPS);
    expect(separation(drawn[0]!, sliver)).toBeGreaterThan(0);
  });

  test("a tile thinner than the gutter plus 1px between two neighbours keeps 1px of fill", () => {
    // 2.5px wide with a neighbour on each side: trimming 1px off both edges would leave 0.5px.
    const drawn = storageTiles(
      [
        { id: "left", bytes: 500 },
        { id: "thin", bytes: 2.5 },
        { id: "right", bytes: 497.5 },
      ],
      1000,
      100,
    );
    const thin = drawn.find((t) => t.item.id === "thin")!;
    expect(thin.width, "STORAGE_TILE_MIN_FILL").toBeGreaterThanOrEqual(1);
    for (const other of drawn.filter((t) => t !== thin)) expect(separation(thin, other), "never touches").toBeGreaterThan(0);
  });
});
