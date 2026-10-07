/**
 * The geometry pipeline that makes a map work for somewhere other than the five
 * places the kit ships fixtures for.
 *
 * Everything here runs with **no network**: the maths is pure and is tested
 * against real coordinates, and the one function that does fetch is given an
 * injected `fetchImpl`. That is not only the repo's no-network rule — a test
 * that reaches Overpass would be exactly the abuse of a free shared service its
 * usage policy asks us not to commit.
 *
 * The two algorithms here replace a 15 MB build-time dependency, so they are
 * tested as algorithms rather than smoke-tested. The third, viewport closure,
 * is the one D25 measured a hand-rolled version getting three of five locations
 * wrong — so it is tested by asking what a reader asks of the render: is the
 * point on the land side filled, and is the point on the water side not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OSM_ATTRIBUTION,
  clipLine,
  closeAgainstViewport,
  closedRings,
  detailFor,
  prepareLand,
  fetchCoastline,
  prepare,
  signedArea,
  simplify,
  stitch,
  toleranceMetres,
  type BBox,
  type CoastlineConfig,
  type Coord,
  type FetchLike,
} from "../src/server/coastline.js";

/** The Strait of Messina, from `packages/ui-kit/fixtures/places.ts`. */
const SCYLLA: Coord = [15.719, 38.2507];
const CHARYBDIS: Coord = [15.6508, 38.2647];
const STRAIT: BBox = [15.6, 38.2, 15.8, 38.32];

const roots: string[] = [];
afterEach(async () => {for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});});
const CONFIG = (fetchImpl: FetchLike): CoastlineConfig => {
  const root = mkdtempSync(join(tmpdir(), "brain-sdk-geo-")); roots.push(root);
  return {enabled: true, url: "https://overpass.invalid/api/interpreter", userAgent: "brain-kit-test/1.0", timeoutMs: 1_000, fetchImpl,
    admissionDir: join(root, "admission"), geo: {userAgent: "brain-kit-test/1.0", timeoutMs: 1_000, cacheDir: root, minimumIntervalMs: 0,
      overpass: {enabled: true, endpoints: ["https://overpass.invalid/api/interpreter"]}}};
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** An Overpass `out geom;` payload: ways whose geometry is `{lat, lon}`. */
function overpassWays(lines: Coord[][]) {
  return { elements: lines.map((line) => ({ type: "way", geometry: line.map(([lon, lat]) => ({ lat, lon })) })) };
}

/**
 * Is this point painted, under the even-odd rule `MapView` draws the rings
 * with? Written out here rather than imported so the tests measure the fill
 * rather than agree with it: a ring list is not evidence of anything until
 * something asks which side of it a point is on.
 */
function fills(rings: Coord[][], [x, y]: Coord): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[i + 1]!;
      if (ay! > y !== by! > y && x < ((bx! - ax!) * (y - ay!)) / (by! - ay!) + ax!) inside = !inside;
    }
  }
  return inside;
}

describe("the simplification tolerance", () => {
  test("is one pixel of the render, measured across the bbox at its own latitude", () => {
    // The strait's bbox is 0.2 degrees of longitude at ~38.26 degrees north.
    const expected = Math.round((0.2 * 111_320 * Math.cos((38.26 * Math.PI) / 180)) / 330);
    expect(toleranceMetres(STRAIT, 330)).toBe(expected);
  });

  test("a wider render asks for finer geometry", () => {
    // The relationship has to be inverse, or a large map gets coarse data.
    expect(toleranceMetres(STRAIT, 660)).toBeLessThan(toleranceMetres(STRAIT, 330));
  });

  test("never zero, however wide the render", () => {
    // A zero tolerance makes Douglas-Peucker keep every vertex, which is the
    // 100x-over-detailed raw data the whole pipeline exists to avoid.
    expect(toleranceMetres(STRAIT, 100_000)).toBeGreaterThan(0);
    expect(toleranceMetres(STRAIT, 0)).toBeGreaterThan(0);
  });
});

describe("detailFor", () => {
  // The threshold the whole tier system rests on, and it is the same one-pixel
  // reasoning the simplification tolerance uses — applied to the SPACING of a
  // feature class rather than to its detail. A map is empty if it draws only
  // shorelines at a kilometre across, and illegible if it draws every
  // residential street at fifty.
  const across = (km: number): BBox => {
    const dLon = km / 111 / Math.cos((38.26 * Math.PI) / 180);
    return [15.6, 38.2, 15.6 + dLon, 38.26];
  };

  test("a region gets its shape and nothing else", () => {
    // 50 km across a phone is 150 m/px; a residential street is invisible and a
    // motorway network is a smear.
    expect(detailFor(across(50), 330)).toBe("coast");
    expect(detailFor(across(14), 330)).toBe("coast");
  });

  test("a town-sized view gets the road network", () => {
    // Major roads sit ~1 km apart, so at 13 m/px they are ~75px apart.
    expect(detailFor(across(4), 330)).toBe("roads");
  });

  test("a walkable view gets every street", () => {
    // Minor streets sit ~100 m apart and need ~8 m/px to be 12px apart.
    expect(detailFor(across(2), 330)).toBe("streets");
    expect(detailFor(across(0.5), 330)).toBe("streets");
  });

  test("the tier follows the WIDTH, not just the ground", () => {
    // The same ground on a desktop pane can afford detail a phone cannot, which
    // is the whole reason the rule is metres-per-pixel and not kilometres.
    const bbox = across(6);
    expect(detailFor(bbox, 330)).toBe("roads");
    expect(detailFor(bbox, 1320)).toBe("streets");
  });
});

describe("simplify", () => {
  test("keeps the ends, always", () => {
    // A line whose endpoints moved is a line that no longer meets its
    // neighbours, which shows up as a gap in a coastline.
    const line: Coord[] = [SCYLLA, [15.7, 38.2555], [15.68, 38.26], CHARYBDIS];
    const out = simplify(line, 5_000, 38.26);
    expect(out[0]).toEqual(SCYLLA);
    expect(out[out.length - 1]).toEqual(CHARYBDIS);
  });

  test("collapses a straight line to its two ends", () => {
    const straight: Coord[] = Array.from({ length: 50 }, (_, i) => [15.6 + i * 0.002, 38.2] as Coord);
    expect(simplify(straight, 100, 38.2)).toHaveLength(2);
  });

  test("keeps a deviation larger than the tolerance and drops one smaller", () => {
    // One point pushed north of the line between two others. 0.01 degrees of
    // latitude is about 1.1 km, so it survives a 100 m tolerance and does not
    // survive a 5 km one.
    const kinked: Coord[] = [
      [15.6, 38.2],
      [15.7, 38.21],
      [15.8, 38.2],
    ];
    expect(simplify(kinked, 100, 38.2)).toHaveLength(3);
    expect(simplify(kinked, 5_000, 38.2)).toHaveLength(2);
  });

  test("measures in metres on both axes, not in degrees", () => {
    // At 38 degrees north a degree of longitude is ~79 km and a degree of
    // latitude is ~111 km, so a threshold applied to raw degrees simplifies
    // east-west detail about 1.4x more aggressively and a coastline loses its
    // horizontal shape first.
    //
    // The two kinks below deviate by the SAME 0.005 degrees, one in longitude
    // (~395 m here) and one in latitude (~556 m). At a 450 m tolerance the
    // metre measurement drops one and keeps the other; a degree measurement
    // sees 0.005 against 0.00404 twice and keeps BOTH. Asserting that the two
    // disagree is what makes this test able to fail — an earlier version
    // compared their lengths for equality and passed against either
    // implementation.
    const tolerance = 450;
    const eastKink: Coord[] = [
      [15.6, 38.2],
      [15.605, 38.3],
      [15.6, 38.4],
    ];
    const northKink: Coord[] = [
      [15.6, 38.2],
      [15.7, 38.205],
      [15.8, 38.2],
    ];
    expect(simplify(eastKink, tolerance, 38.2)).toHaveLength(2);
    expect(simplify(northKink, tolerance, 38.2)).toHaveLength(3);
  });

  test("does not blow the stack on a long nearly-straight line", () => {
    // The recursive formulation is depth-n here, and a nearly-straight line is
    // exactly what a shoreline segment looks like. 50k is far past the ~11k
    // frames a default stack allows and far past any real OSM way, which is the
    // point: this must not be a 500. Kept to 50k rather than 200k because a
    // SEEDED bug in the threshold turns this into an O(n^2) walk, and a test
    // that takes three minutes to fail is a test people stop running.
    const long: Coord[] = Array.from(
      { length: 50_000 },
      (_, i) => [15.6 + i * 1e-6, 38.2 + (i % 2) * 1e-9] as Coord,
    );
    expect(() => simplify(long, 50, 38.2)).not.toThrow();
  });
});

describe("clipLine", () => {
  test("passes a line that is wholly inside, untouched", () => {
    const line: Coord[] = [CHARYBDIS, SCYLLA];
    expect(clipLine(line, STRAIT)).toEqual([line]);
  });

  test("drops a line that is wholly outside", () => {
    const elsewhere: Coord[] = [
      [10, 40],
      [10.1, 40.1],
    ];
    expect(clipLine(elsewhere, STRAIT)).toEqual([]);
  });

  test("cuts a line at the boundary rather than at its own vertex", () => {
    // Enters from the west. The first output point must be ON the western edge,
    // not the original off-box vertex — otherwise the drawing extends past the
    // viewport and the SVG clips it at a different place than the data says.
    const entering: Coord[] = [
      [15.4, 38.25],
      [15.7, 38.25],
    ];
    const [clipped] = clipLine(entering, STRAIT);
    expect(clipped![0]![0]).toBeCloseTo(15.6, 9);
    expect(clipped![clipped!.length - 1]).toEqual([15.7, 38.25]);
  });

  test("splits a line that leaves the box and comes back", () => {
    // A real shoreline does this constantly. One input way, two drawn paths —
    // joining them would draw a straight line across the gap, through water.
    //
    // Exactly ONE vertex is outside, so no segment is wholly outside the box.
    // That matters: a line with a fully-outside segment in the middle gets
    // split by the wholly-outside branch instead, and an earlier version of
    // this test used one — so it passed against an implementation that never
    // split at a boundary at all.
    const inOutIn: Coord[] = [
      [15.7, 38.25],
      [15.9, 38.25],
      [15.7, 38.26],
    ];
    const out = clipLine(inOutIn, STRAIT);
    expect(out.length).toBe(2);
    // And each run ends on the eastern edge it left through, rather than at
    // the off-box vertex.
    expect(out[0]![out[0]!.length - 1]![0]).toBeCloseTo(15.8, 9);
    expect(out[1]![0]![0]).toBeCloseTo(15.8, 9);
    for (const line of out) {
      for (const [lon, lat] of line) {
        expect(lon).toBeGreaterThanOrEqual(STRAIT[0] - 1e-9);
        expect(lon).toBeLessThanOrEqual(STRAIT[2] + 1e-9);
        expect(lat).toBeGreaterThanOrEqual(STRAIT[1] - 1e-9);
        expect(lat).toBeLessThanOrEqual(STRAIT[3] + 1e-9);
      }
    }
  });

  test("never emits a one-point line", () => {
    // A single point draws nothing and still costs an array in the payload.
    const grazing: Coord[] = [
      [15.4, 38.25],
      [15.6, 38.25],
      [15.4, 38.26],
    ];
    for (const line of clipLine(grazing, STRAIT)) {
      expect(line.length).toBeGreaterThan(1);
    }
  });
});

describe("prepare", () => {
  test("clips, simplifies and rounds to 4 dp", () => {
    const line: Coord[] = Array.from({ length: 500 }, (_, i) => [15.4 + i * 0.001, 38.25] as Coord);
    const out = prepare([line], { bbox: STRAIT, widthPx: 330 });
    expect(out.length).toBe(1);
    // Straight, so it collapses to its two clipped ends.
    expect(out[0]).toHaveLength(2);
    for (const [lon, lat] of out[0]!) {
      expect(String(lon).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
      expect(String(lat).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });

  test("a bbox with nothing in it yields nothing, not a throw", () => {
    expect(prepare([], { bbox: STRAIT, widthPx: 330 })).toEqual([]);
  });
});

describe("fetchCoastline", () => {
  test("turns Overpass's own JSON into drawable paths", async () => {
    const shoreline: Coord[] = [
      [15.62, 38.21],
      [15.65, 38.24],
      [15.7, 38.3],
    ];
    const result = await fetchCoastline(
      { bbox: STRAIT, widthPx: 330 },
      CONFIG(async () => jsonResponse(overpassWays([shoreline]))),
    );
    expect(result.coastline.length).toBe(1);
    expect(result.attribution).toBe(OSM_ATTRIBUTION);
    expect(result.toleranceM).toBe(toleranceMetres(STRAIT, 330));
  });

  test("asks for roads only when roads were asked for", async () => {
    const queries: string[] = [];
    const spy: FetchLike = async (_url, init) => {
      queries.push(String(init?.body ?? ""));
      return jsonResponse(overpassWays([]));
    };

    await fetchCoastline({ bbox: STRAIT, widthPx: 330 }, CONFIG(spy));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("coastline");

    queries.length = 0;
    await fetchCoastline({ bbox: STRAIT, widthPx: 330, detail: "roads" }, CONFIG(spy));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("highway");
  });

  test("sends the bbox in Overpass's order, which is not the one we hold", async () => {
    // Overpass wants (south,west,north,east); everything else here is
    // [west,south,east,north]. Getting it wrong returns an empty result rather
    // than an error, which is the kind of bug that ships.
    let body = "";
    await fetchCoastline(
      { bbox: STRAIT, widthPx: 330 },
      CONFIG(async (_url, init) => {
        body = String(init?.body ?? "");
        return jsonResponse(overpassWays([]));
      }),
    );
    expect(decodeURIComponent(body)).toContain("38.20000,15.60000,38.32000,15.80000");
  });

  test("identifies itself, because a browser cannot", async () => {
    const seen: { userAgent?: string | null } = {};
    await fetchCoastline(
      { bbox: STRAIT, widthPx: 330 },
      CONFIG(async (_url, init) => {
        seen.userAgent = new Headers(init?.headers).get("User-Agent");
        return jsonResponse(overpassWays([]));
      }),
    );
    expect(seen.userAgent).toBe("brain-kit-test/1.0");
  });

  test("degrades to an empty map rather than throwing", async () => {
    // Every one of these is a normal Tuesday for a free shared service. A map
    // with no coastline is still a correct locator; a message that will not
    // render is not.
    const failures: FetchLike[] = [
      async () => {
        throw new Error("network down");
      },
      async () => new Response("rate limited", { status: 429 }),
      async () => new Response("<html>not json</html>", { status: 200 }),
    ];
    for (const fetchImpl of failures) {
      const result = await fetchCoastline({ bbox: STRAIT, widthPx: 330 }, CONFIG(fetchImpl));
      expect(result.coastline).toEqual([]);
      expect(result.attribution).toBe(OSM_ATTRIBUTION);
    }
  });

  test("disabled means no request at all, not an empty one", async () => {
    let called = false;
    const result = await fetchCoastline(
      { bbox: STRAIT, widthPx: 330 },
      {
        ...CONFIG(async () => {
          called = true;
          return jsonResponse(overpassWays([]));
        }),
        enabled: false,
      },
    );
    expect(called).toBe(false);
    expect(result.coastline).toEqual([]);
  });
});

describe("closedRings", () => {
  /** A square island, stored the way OSM does: several ways sharing endpoints. */
  const ISLAND: Coord[][] = [
    [
      [15.6, 38.2],
      [15.7, 38.2],
    ],
    [
      [15.7, 38.2],
      [15.7, 38.3],
    ],
    [
      [15.7, 38.3],
      [15.6, 38.3],
    ],
    [
      [15.6, 38.3],
      [15.6, 38.2],
    ],
  ];

  test("stitches ways that share endpoints into one loop", () => {
    // An island is only a closed shape once its ways are joined; OSM never
    // stores it as one.
    const rings = closedRings(ISLAND);
    expect(rings).toHaveLength(1);
    expect(rings[0]![0]).toEqual(rings[0]![rings[0]!.length - 1]);
  });

  test("stitches them in any order", () => {
    // Overpass does not promise an order, and an implementation that only
    // walked forwards from the first way would work by luck.
    const shuffled = [ISLAND[2]!, ISLAND[0]!, ISLAND[3]!, ISLAND[1]!];
    expect(closedRings(shuffled)).toHaveLength(1);
  });

  test("drops a chain that does not close", () => {
    // A mainland shore enters the box on one edge and leaves by another.
    // Closing it means deciding which side is land against the viewport, which
    // is the decision that inverted land and sea in D25's measurements.
    const mainland: Coord[][] = [
      [
        [15.6, 38.2],
        [15.65, 38.25],
      ],
      [
        [15.65, 38.25],
        [15.7, 38.3],
      ],
    ];
    expect(closedRings(mainland)).toEqual([]);
  });

  test("keeps an island and drops the mainland beside it", () => {
    expect(closedRings([...ISLAND, [[15.9, 38.2], [15.95, 38.3]]])).toHaveLength(1);
  });

  test("joins only on an exact shared node", () => {
    // OSM ways that continue each other share a node, so the coordinates are
    // identical. A tolerance would invent a join between a shore and a pier
    // that nearly touches it.
    const nearlyTouching: Coord[][] = [
      [
        [15.6, 38.2],
        [15.7, 38.2],
      ],
      [
        [15.70001, 38.2],
        [15.7, 38.3],
      ],
    ];
    expect(closedRings(nearlyTouching)).toEqual([]);
  });

  test("joins a shore handed over out of order, from both ends", () => {
    // Overpass promises no order, and a walk that only goes forwards leaves the
    // half BEHIND its starting way as a second chain. Both halves then end
    // inside the box, where a closure has nothing to attach to — which is how
    // the tip of Sicily, two ways meeting at the Capo Peloro lighthouse, went
    // missing from the strait's fill.
    const second: Coord[] = [
      [15.65, 38.25],
      [15.8, 38.3],
    ];
    const first: Coord[] = [
      [15.5, 38.2],
      [15.65, 38.25],
    ];
    const { chains } = stitch([second, first]);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toEqual([
      [15.5, 38.2],
      [15.65, 38.25],
      [15.8, 38.3],
    ]);
  });

  test("never reverses a way to make a join, because that reverses which side is land", () => {
    // Two ways that meet end-to-end rather than head-to-tail are two shores
    // facing each other, not one shore. Joining them would silently invert the
    // winding half the fill depends on.
    const { chains } = stitch([
      [
        [15.5, 38.2],
        [15.65, 38.25],
      ],
      [
        [15.8, 38.3],
        [15.65, 38.25],
      ],
    ]);
    expect(chains).toHaveLength(2);
  });

  test("a ring of three points or fewer encloses nothing", () => {
    const degenerate: Coord[][] = [
      [
        [15.6, 38.2],
        [15.7, 38.2],
        [15.6, 38.2],
      ],
    ];
    expect(closedRings(degenerate)).toEqual([]);
  });
});

describe("prepareLand", () => {
  test("simplifies a ring without opening it", () => {
    // Douglas-Peucker moves endpoints, and a ring whose ends stopped meeting is
    // a line. This is the property the fill depends on completely.
    const circle: Coord[] = Array.from({ length: 200 }, (_, i) => {
      const t = (i / 199) * Math.PI * 2;
      return [15.7 + 0.05 * Math.cos(t), 38.26 + 0.05 * Math.sin(t)] as Coord;
    });
    circle[circle.length - 1] = circle[0]!;

    const [ring] = prepareLand([circle], { bbox: STRAIT, widthPx: 330 });
    expect(ring).toBeDefined();
    expect(ring![0]).toEqual(ring![ring!.length - 1]);
    expect(ring!.length).toBeLessThan(circle.length);
    expect(ring!.length).toBeGreaterThan(3);
  });

  test("does not clip rings to the bbox", () => {
    // Clipping a ring against the viewport is the operation that inverts land
    // and sea. The SVG clips the DRAWING instead, which it does correctly and
    // without deciding anything — so a ring may legitimately extend past the
    // box it was requested for.
    const straddling: Coord[] = [
      [15.5, 38.15],
      [15.9, 38.15],
      [15.9, 38.4],
      [15.5, 38.4],
      [15.5, 38.15],
    ];
    const [ring] = prepareLand([straddling], { bbox: STRAIT, widthPx: 330 });
    expect(ring).toBeDefined();
    const lons = ring!.map((c) => c[0]);
    expect(Math.min(...lons)).toBeLessThan(STRAIT[0]);
    expect(Math.max(...lons)).toBeGreaterThan(STRAIT[2]);
  });

  test("an open shore is closed against the viewport, on the land side", () => {
    // It used to yield nothing at all. West to east means land to the north,
    // and the fill has to reach the top of the box rather than stop at the
    // shore — which is the whole of what closure buys.
    const shore: Coord[][] = [
      [
        [15.5, 38.25],
        [15.9, 38.26],
      ],
    ];
    const land = prepareLand(shore, { bbox: STRAIT, widthPx: 330 });
    expect(land).toHaveLength(1);
    expect(fills(land, [15.7, 38.31])).toBe(true);
    expect(fills(land, [15.7, 38.21])).toBe(false);
  });

  test("an island beside a mainland shore comes out exactly as it did alone", () => {
    // The criterion the island fixtures rest on. Adding closure must not move
    // a ring by a coordinate: this compares the two outputs rather than
    // eyeballing a render, and the ring is the one the fixtures ship.
    const island: Coord[][] = [
      [
        [15.66, 38.24],
        [15.7, 38.24],
        [15.7, 38.28],
        [15.66, 38.28],
        [15.66, 38.24],
      ],
    ];
    // The shore runs east to west, so its land is to the SOUTH of it and the
    // island sits clear to the north — a closure that swallowed the island
    // would turn it into a hole under the even-odd rule, which is a different
    // bug with the same symptom.
    const alone = prepareLand(island, { bbox: STRAIT, widthPx: 330 });
    const beside = prepareLand([...island, [[15.9, 38.21], [15.5, 38.215]]], { bbox: STRAIT, widthPx: 330 });
    expect(alone).toHaveLength(1);
    expect(beside.slice(0, 1)).toEqual(alone);
    expect(beside).toHaveLength(2);
  });

  test("a closure smaller than a pixel of the render is not worth a ring", () => {
    // The same one-pixel rule the island rings are filtered by. A shore that
    // clips the very corner of the box encloses a smudge.
    const tiny = 0.0003;
    const sliver: Coord[][] = [
      [
        [STRAIT[2] + tiny, STRAIT[1] + 2 * tiny],
        [STRAIT[2] - 2 * tiny, STRAIT[1] - tiny],
      ],
    ];
    expect(prepareLand(sliver, { bbox: STRAIT, widthPx: 330 })).toEqual([]);
  });

  test("a chain that simply stops inside the box is dropped, not closed", () => {
    // A way whose data ends mid-shore closes into a shape with no meaning, and
    // nothing in it says which side is water.
    const dangling: Coord[][] = [
      [
        [15.5, 38.25],
        [15.7, 38.26],
      ],
    ];
    expect(prepareLand(dangling, { bbox: STRAIT, widthPx: 330 })).toEqual([]);
  });
});

/**
 * Closing an open shore against the viewport — the operation D25 measured going
 * wrong on three of five locations, and the reason this module said for two
 * waves that it did not do fill.
 *
 * Every test here asks the same question a reader asks of the render: is the
 * point on the land side filled, and is the point on the water side not? A
 * predicate on the ring's vertices would pass just as happily with land and sea
 * the wrong way round, which is precisely the bug.
 */
describe("closeAgainstViewport", () => {
  /** Four points, one per edge of `STRAIT`, well inside it. */
  const NORTH: Coord = [15.7, 38.31];
  const SOUTH: Coord = [15.7, 38.21];
  const EAST: Coord = [15.79, 38.26];
  const WEST: Coord = [15.61, 38.26];

  /** A shore straight across the middle of the box, from `a` to `b`. */
  const across = (a: Coord, b: Coord): Coord[][] => [[a, b]];

  /** Well past the box on each side, so the chain is clipped rather than
   * ending on the boundary by construction — which is what real ways do. */
  const OUTSIDE = { west: 15.4, east: 16.0, south: 38.1, north: 38.4 } as const;

  const close = (chains: Coord[][]) => closeAgainstViewport(chains, { bbox: STRAIT, widthPx: 330 });

  test("west to east puts the land to the north", () => {
    // OSM winds a coastline with land on the LEFT, and left of due east is
    // north. This is the fact the whole closure rests on.
    const land = close(across([OUTSIDE.west, 38.26], [OUTSIDE.east, 38.26]));
    expect(land).toHaveLength(1);
    expect(fills(land, NORTH)).toBe(true);
    expect(fills(land, SOUTH)).toBe(false);
  });

  test("east to west puts the land to the south", () => {
    const land = close(across([OUTSIDE.east, 38.26], [OUTSIDE.west, 38.26]));
    expect(fills(land, SOUTH)).toBe(true);
    expect(fills(land, NORTH)).toBe(false);
  });

  test("south to north puts the land to the west", () => {
    const land = close(across([15.7, OUTSIDE.south], [15.7, OUTSIDE.north]));
    expect(fills(land, WEST)).toBe(true);
    expect(fills(land, EAST)).toBe(false);
  });

  test("north to south puts the land to the east", () => {
    const land = close(across([15.7, OUTSIDE.north], [15.7, OUTSIDE.south]));
    expect(fills(land, EAST)).toBe(true);
    expect(fills(land, WEST)).toBe(false);
  });

  test("a shore across a corner fills the corner and keeps its right angle", () => {
    // Entering on the east edge and leaving on the south one, the walk back has
    // exactly one corner to pick up. Dropping it would cut the corner off with
    // a diagonal — the seam D25 saw — so the corner is asserted, not assumed.
    // Crosses the east edge at 38.28 and the south edge at 15.70, so the land
    // is the triangle between them and the corner.
    const land = close(across([16.0, 38.44], [15.6, 38.12]));
    expect(land).toHaveLength(1);
    expect(land[0]!).toContainEqual([STRAIT[2], STRAIT[1]]);
    expect(fills(land, [15.78, 38.21])).toBe(true);
    expect(fills(land, [15.62, 38.31])).toBe(false);
  });

  test("a peninsula in and out of one edge fills only the peninsula", () => {
    // The case the earlier attempt got wrong. Land on the left all the way
    // round: south down the western flank, north back up the eastern one.
    const land = close([
      [
        [15.68, OUTSIDE.north],
        [15.68, 38.24],
        [15.72, 38.24],
        [15.72, OUTSIDE.north],
      ],
    ]);
    expect(land).toHaveLength(1);
    expect(fills(land, [15.7, 38.3])).toBe(true);
    expect(fills(land, [15.65, 38.3])).toBe(false);
    expect(fills(land, [15.75, 38.3])).toBe(false);
  });

  test("a bay in and out of the same edge fills everything except the bay", () => {
    // The same two points on the same edge, traversed the other way. Nothing
    // decides between this and the peninsula above: the direction the shore
    // runs in is the decision, and the walk follows it.
    const land = close([
      [
        [15.72, OUTSIDE.north],
        [15.72, 38.24],
        [15.68, 38.24],
        [15.68, OUTSIDE.north],
      ],
    ]);
    expect(land).toHaveLength(1);
    expect(fills(land, [15.7, 38.3])).toBe(false);
    expect(fills(land, [15.65, 38.3])).toBe(true);
    expect(fills(land, [15.75, 38.3])).toBe(true);
    expect(fills(land, [15.7, 38.21])).toBe(true);
  });

  test("two shores facing each other across a strait fill both sides and not the water", () => {
    // Messina, in miniature: Sicily to the west with its shore running north,
    // Calabria to the east with its shore running south. Each closes on its own
    // and neither reaches into the channel.
    const land = close([
      [
        [15.66, OUTSIDE.south],
        [15.66, OUTSIDE.north],
      ],
      [
        [15.74, OUTSIDE.north],
        [15.74, OUTSIDE.south],
      ],
    ]);
    expect(land).toHaveLength(2);
    expect(fills(land, [15.62, 38.26])).toBe(true);
    expect(fills(land, [15.78, 38.26])).toBe(true);
    expect(fills(land, [15.7, 38.26])).toBe(false);
  });

  test("two shores bounding a strip of land fill the strip and neither sea", () => {
    // The case that defeats closing each shore on its own: an island wider than
    // the view, an isthmus, a coastal plain between two seas. Closed
    // separately, each shore claims everything on its side, the two claims
    // overlap, and the even-odd rule paints their symmetric difference — the
    // two seas, with the land between them left empty. The walk stops at the
    // next shore instead, which stitches the strip's two sides into one ring.
    const land = close([
      [
        [15.4, 38.24],
        [16.0, 38.24],
      ],
      [
        [16.0, 38.28],
        [15.4, 38.28],
      ],
    ]);
    expect(land).toHaveLength(1);
    expect(fills(land, [15.7, 38.26])).toBe(true);
    expect(fills(land, [15.7, 38.22])).toBe(false);
    expect(fills(land, [15.7, 38.3])).toBe(false);
  });

  test("a linked ring picks up the corners between the shores it joins", () => {
    // The strip above runs clear across the box, so its ring passes no corner.
    // Here the second shore cuts the north-east corner off as water, and the
    // ring has to walk round the north-WEST one to get back to the first
    // shore. A link that dropped the corner would cut it off with a diagonal —
    // the seam D25 saw.
    const land = close([
      // Enters west at 38.24, leaves east at 38.26; land to the north.
      [
        [15.4, 38.22],
        [16.0, 38.28],
      ],
      // Enters east at 38.30, leaves north at 15.70; land to the south.
      [
        [16.0, 38.26],
        [15.6, 38.36],
      ],
    ]);
    expect(land).toHaveLength(1);
    expect(land[0]!).toContainEqual([STRAIT[0], STRAIT[3]]);
    expect(fills(land, [15.62, 38.3])).toBe(true);
    expect(fills(land, [15.78, 38.315])).toBe(false);
    expect(fills(land, [15.7, 38.21])).toBe(false);
  });

  test("the whole closure is counterclockwise, which is what land-on-the-left means", () => {
    for (const chains of [
      across([OUTSIDE.west, 38.26], [OUTSIDE.east, 38.26]),
      across([OUTSIDE.east, 38.26], [OUTSIDE.west, 38.26]),
      across([15.7, OUTSIDE.south], [15.7, OUTSIDE.north]),
      across([15.7, OUTSIDE.north], [15.7, OUTSIDE.south]),
    ]) {
      const rings = close(chains);
      expect(rings).toHaveLength(1);
      for (const ring of rings) expect(signedArea(ring)).toBeGreaterThan(0);
    }
  });

  test("a shore that only grazes the box does not take the fill with it", () => {
    // The clipper answers a tangent touch with one point repeated. It bounds
    // nothing — and because its entry and its exit are the same place, it is
    // zero distance ahead of every other shore's exit, so a walk that could
    // reach it would end there and lose the ring it was building. Found by an
    // independent review; the fill here used to come back empty.
    const land = close([
      [
        [15.4, 38.24],
        [16.0, 38.24],
        [16.0, 38.5],
        [15.7, 38.32], // exactly on the north edge, and straight back out
        [15.4, 38.5],
      ],
    ]);
    expect(land).toHaveLength(1);
    expect(fills(land, NORTH)).toBe(true);
    expect(fills(land, SOUTH)).toBe(false);
  });

  test("a lobe that comes in and goes back out at one point is its own ring", () => {
    // The same tangency from the inside: a shore that touches the boundary,
    // loops into the view and returns to the point it came in at. That one is
    // real land and closes on itself, so the walk has to take it without
    // letting it swallow the shore beside it.
    const land = close([
      [
        [15.7, 38.4],
        [15.7, 38.28],
        [15.72, 38.3],
        [15.7, 38.32],
        [15.7, 38.4],
      ],
      [
        [16.0, 38.24],
        [15.4, 38.24],
      ],
    ]);
    expect(land).toHaveLength(2);
    expect(fills(land, [15.705, 38.3])).toBe(true);
    expect(fills(land, [15.65, 38.22])).toBe(true);
    expect(fills(land, [15.65, 38.3])).toBe(false);
    expect(fills(land, [15.75, 38.3])).toBe(false);
  });

  test("a shore running along the boundary encloses nothing", () => {
    expect(close([[[15.6, 38.2], [15.6, 38.32]]])).toEqual([]);
  });

  test("a closed ring never reaches here, so an island is never cut against the box", () => {
    // `stitch` sends loops the other way. This is the guard on that split: a
    // ring handed to the closure directly would be clipped, and clipping a ring
    // is the operation that inverts land and sea.
    const island: Coord[][] = [
      [
        [15.66, 38.24],
        [15.7, 38.24],
        [15.7, 38.28],
        [15.66, 38.28],
        [15.66, 38.24],
      ],
    ];
    expect(stitch(island).chains).toEqual([]);
    expect(stitch(island).rings).toHaveLength(1);
  });
});

describe("the winding convention is checked, not trusted", () => {
  /** A shore wound the wrong way round: OSM puts land on the left, this puts
   * it on the right. Everything below is the same geometry twice. */
  const RIGHT_WAY: Coord[][] = [[[15.4, 38.26], [16.0, 38.26]]];
  const WRONG_WAY: Coord[][] = [[[16.0, 38.26], [15.4, 38.26]]];

  /** A road grid on the northern half — on land by definition. */
  const ROADS: Coord[][] = Array.from({ length: 6 }, (_, i) => [
    [15.62 + i * 0.03, 38.28],
    [15.62 + i * 0.03, 38.30],
    [15.63 + i * 0.03, 38.31],
    [15.64 + i * 0.03, 38.29],
  ] as Coord[]);

  const request = { bbox: STRAIT, widthPx: 330 };

  test("a fill that contains the roads is kept", () => {
    const land = prepareLand(RIGHT_WAY, request, { onLand: ROADS });
    expect(land).toHaveLength(1);
    expect(fills(land, [15.7, 38.31])).toBe(true);
  });

  test("a fill that puts the roads in the water is refused, not drawn", () => {
    // Wound the other way the closure is the exact complement — the sea, filled
    // confidently. The roads are the witness that says so, and the answer is
    // the stroke-only map this module drew before closure existed rather than a
    // map that lies about which side is water.
    expect(prepareLand(WRONG_WAY, request, { onLand: ROADS })).toEqual([]);
  });

  test("islands survive a refusal, because nothing about them was in doubt", () => {
    const island: Coord[][] = [
      [
        [15.66, 38.24],
        [15.7, 38.24],
        [15.7, 38.26],
        [15.66, 38.26],
        [15.66, 38.24],
      ],
    ];
    const land = prepareLand([...island, ...WRONG_WAY], request, { onLand: ROADS });
    expect(land).toHaveLength(1);
    expect(fills(land, [15.68, 38.25])).toBe(true);
  });

  test("a strait wound the other way fills the channel, and the witnesses refuse it", () => {
    // Two facing shores, and the flip is not a no-op: wound the other way they
    // link through the boundary into the water between them instead of the two
    // coasts. Nothing in the geometry says which of those is land — the roads
    // do.
    const strait: Coord[][] = [
      [
        [15.66, 38.1],
        [15.66, 38.4],
      ],
      [
        [15.74, 38.4],
        [15.74, 38.1],
      ],
    ];
    const flipped = strait.map((shore) => [...shore].reverse());
    const request = { bbox: STRAIT, widthPx: 330 };
    /** A road on each coast, which is where roads are. */
    const coastal: Coord[][] = Array.from({ length: 6 }, (_, i) => [
      [15.62, 38.24 + i * 0.01],
      [15.63, 38.245 + i * 0.01],
      [15.78, 38.24 + i * 0.01],
      [15.77, 38.245 + i * 0.01],
    ] as Coord[]);

    const right = prepareLand(strait, request, { onLand: coastal });
    expect(fills(right, [15.62, 38.26])).toBe(true);
    expect(fills(right, [15.78, 38.26])).toBe(true);
    expect(fills(right, [15.7, 38.26])).toBe(false);

    const wrong = prepareLand(flipped, request);
    expect(fills(wrong, [15.7, 38.26])).toBe(true);
    expect(prepareLand(flipped, request, { onLand: coastal })).toEqual([]);
  });

  test("too few witnesses decide nothing, and the convention stands on its own", () => {
    // A coast-tier request fetches no roads at all. Refusing every mainland
    // fill for want of a witness would throw away the whole feature to guard
    // against a convention that 486 of 486 measured rings hold to.
    const one: Coord[][] = [[[15.7, 38.29], [15.71, 38.3]]];
    expect(prepareLand(WRONG_WAY, request, { onLand: one })).toHaveLength(1);
    expect(prepareLand(WRONG_WAY, request)).toHaveLength(1);
  });
});
