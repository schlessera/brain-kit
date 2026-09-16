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
 * tested as algorithms rather than smoke-tested. What is deliberately NOT here
 * is polygon ring closure: D25 measured a hand-rolled version getting three of
 * five locations wrong, and this module does not attempt it.
 */

import { describe, expect, test } from "bun:test";

import {
  OSM_ATTRIBUTION,
  clipLine,
  closedRings,
  detailFor,
  prepareLand,
  fetchCoastline,
  prepare,
  simplify,
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

const CONFIG = (fetchImpl: FetchLike): CoastlineConfig => ({
  enabled: true,
  url: "https://overpass.invalid/api/interpreter",
  userAgent: "brain-kit-test/1.0",
  timeoutMs: 1_000,
  fetchImpl,
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** An Overpass `out geom;` payload: ways whose geometry is `{lat, lon}`. */
function overpassWays(lines: Coord[][]) {
  return { elements: lines.map((line) => ({ type: "way", geometry: line.map(([lon, lat]) => ({ lat, lon })) })) };
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

  test("an open shore yields no land at all", () => {
    const shore: Coord[][] = [
      [
        [15.5, 38.25],
        [15.9, 38.26],
      ],
    ];
    expect(prepareLand(shore, { bbox: STRAIT, widthPx: 330 })).toEqual([]);
  });
});
