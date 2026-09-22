/**
 * Coastline and road geometry for an arbitrary bounding box, simplified to the
 * width it will be drawn at.
 *
 * `@schlessera/brain-ui-kit`'s `MapView` draws whatever `[lon, lat]` polylines
 * it is handed and fetches nothing — that is D13, and it is right: a component
 * that reaches for the network cannot be rendered in a test, a screenshot or an
 * offline PWA. But a map that only knows five hard-coded Mediterranean islands
 * is a demo. **This is the other half**: the server side that can produce the
 * same shape of data for anywhere, on demand.
 *
 * ## Why the maths is here and not in a library
 *
 * The build-time fixture pipeline (`packages/ui-kit/tools/geo/generate.ts`)
 * shells out to mapshaper, which is 15 MB and 31 dependencies and exists in
 * that script because it is a one-off run on a developer's machine. It is used
 * there for exactly two operations — clip a bbox, simplify a line — and both
 * are short, well-defined algorithms. Pulling 15 MB into a server to do them
 * per request would be the wrong trade.
 *
 * **Ring closure is here too, and it was the hard one.** D25 measured a
 * hand-rolled closure of mainland coastline against a viewport rectangle
 * getting three of five locations wrong, with diagonal seams and inverted land
 * and sea, and told the next person not to try it. What changed is that the
 * missing fact got measured: OSM winds a coastline so that land is on the
 * LEFT, and 486 of 486 closed rings across three of the fixture locations hold
 * to it. With the winding known, "which side of this open shore is land" stops
 * being a judgement call and becomes a walk around the rectangle in one fixed
 * direction — see `closeAgainstViewport`, which is the whole of it. The
 * closure is also checked against geometry that is on land by definition
 * rather than trusted, which is what `LandOptions.onLand` is for.
 *
 * ## Degrading is a feature
 *
 * Every failure path returns an empty path list rather than throwing. A map
 * with no coastline is a graticule with a correct pin and a correct scale bar —
 * the component's own documented default, and a perfectly good locator. A map
 * that throws is a message that will not render. Overpass is a free shared
 * service that can be slow or down, and a chat surface must never wait on it.
 *
 * ## Licensing, which follows the data rather than the render
 *
 * The rendered map is a Produced Work and carries no share-alike. What this
 * module returns is a Derivative Database, and **a server that caches and
 * serves it is distributing one** — so `attribution` comes back with the
 * geometry rather than being something a caller has to remember, and it is
 * non-optional in the return type for that reason.
 */

/** The part of `fetch` this module actually uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `[west, south, east, north]` in degrees. */
export type BBox = [number, number, number, number];

/** `[lon, lat]`, the order `MapView`'s `paths` prop takes. */
export type Coord = [number, number];

export interface CoastlineConfig {
  /** `false` skips the network entirely — offline, or a privacy opt-out. */
  enabled: boolean;
  /** Overpass endpoint. */
  url: string;
  /**
   * Identifying User-Agent. OSM's policy treats a published integration as an
   * SDK that must say who it is; a browser cannot set this header, which is one
   * of the three reasons the component does not fetch tiles itself.
   */
  userAgent: string;
  /** Milliseconds. A chat surface must not wait on a free shared service. */
  timeoutMs?: number;
  /**
   * Injected for tests. Defaults to global `fetch`.
   *
   * Typed as the SUBSET this module uses rather than as `typeof fetch`: the
   * global carries runtime-specific extras (Bun adds `preconnect`), so a test
   * double would have to implement them to satisfy the type without adding
   * anything to the test.
   */
  fetchImpl?: FetchLike;
}

/**
 * How much of the world to draw, chosen by how much of it fits on screen.
 *
 * A coastline is the right answer for a region and the wrong one for a street:
 * at a kilometre across, a shoreline is one curve at the edge and the map is
 * empty except for its own pins. At fifty kilometres the reverse — every
 * residential street collapses into a grey smear that hides the shape.
 *
 * The thresholds are the same one-pixel reasoning the simplification tolerance
 * uses, applied to the SPACING of a feature class rather than to its detail:
 *
 *   - Major roads sit roughly a kilometre apart. Below ~40 m/px that is about
 *     25px between them, which reads as a network.
 *   - Minor streets sit roughly a hundred metres apart. They need ~8 m/px
 *     before they are 12px apart and legible as separate streets.
 *
 * So the tier is a function of metres-per-pixel, and metres-per-pixel is a
 * function of the bbox and the width it is drawn at — both of which the caller
 * already has to know.
 */
export type MapDetail = "coast" | "roads" | "streets";

/** Above this, a minor street is too close to its neighbour to read. */
const STREETS_MAX_M_PER_PX = 8;
/** Above this, even a major road network is a smear. */
const ROADS_MAX_M_PER_PX = 40;

export function detailFor(bbox: BBox, widthPx: number): MapDetail {
  const mPerPx = toleranceMetres(bbox, widthPx);
  if (mPerPx <= STREETS_MAX_M_PER_PX) return "streets";
  if (mPerPx <= ROADS_MAX_M_PER_PX) return "roads";
  return "coast";
}

export interface CoastlineRequest {
  bbox: BBox;
  /**
   * The pixel width the map will be drawn at. It is the DIVISOR in the
   * simplification tolerance, not a hint: one pixel of the target render is the
   * knee of the size/quality curve, and geometry simplified for a wide view and
   * drawn narrow wastes bytes while the reverse visibly facets.
   */
  widthPx: number;
  /**
   * Override the tier `detailFor` would choose.
   *
   * The automatic answer is right for a map whose span was chosen to frame its
   * pins. It is wrong for the one case D25 measured: Troy is a single shoreline
   * curve at a span where the rule says coastline is enough, and it is not —
   * the road network is what turns a line into a place. So the override exists
   * for "this particular view needs more than its size suggests", not as the
   * normal way to ask.
   */
  detail?: MapDetail;
}

export interface CoastlineResult {
  coastline: Coord[][];
  /** Motorway through secondary: the network that locates a town. */
  roads: Coord[][];
  /** Tertiary through residential: only drawn when a block is legible. */
  streets: Coord[][];
  /** Which tier was actually drawn, so a caller can say so. */
  detail: MapDetail;
  /**
   * True when at least one of the tier's queries failed and its geometry is
   * missing from an otherwise usable result.
   *
   * The street tier is three sequential requests, and a free service under load
   * refuses them individually — so "all or nothing" throws away a perfectly
   * good coastline because the minor streets timed out. Each query degrades on
   * its own instead, and this says so, because a PARTIAL result must not be
   * cached forever: the cache has no TTL, and a bad afternoon would otherwise
   * become a street map that never has streets.
   */
  partial: boolean;
  /**
   * Closed rings of land, for a subtle fill under the stroke.
   *
   * Two sources, and they are drawn as one path under the even-odd rule so a
   * lagoon inside an island is a hole without anyone saying so. An island's
   * coastline stitches head-to-tail into a loop and is land beyond argument; a
   * mainland shore enters the bounding box on one edge and leaves by another
   * and is closed against the box itself, walking its edge on the land side
   * (`closeAgainstViewport`).
   */
  land: Coord[][];
  /** The simplification tolerance actually used, in metres. */
  toleranceM: number;
  /** Non-optional: the caller is distributing a Derivative Database. */
  attribution: string;
}

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

const DEFAULT_TIMEOUT_MS = 8_000;

/** Coordinates at 4 dp — about 11 m, well under a pixel at any sane span. */
const PRECISION = 4;

/** 111.32 km per degree of latitude, the figure `MapView`'s scale bar uses. */
const METRES_PER_DEGREE_LAT = 111_320;

const EMPTY: CoastlineResult = {
  coastline: [],
  roads: [],
  streets: [],
  land: [],
  detail: "coast",
  partial: false,
  toleranceM: 0,
  attribution: OSM_ATTRIBUTION,
};

/* ------------------------------------------------------------------ maths */

/**
 * Metres per pixel across the bbox at its own latitude — the simplification
 * tolerance, and the same number `MapView` computes for its scale bar.
 */
export function toleranceMetres(bbox: BBox, widthPx: number): number {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const spanM = (east - west) * METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180);
  return Math.max(1, Math.round(spanM / Math.max(1, widthPx)));
}

/** Degrees of latitude and longitude that correspond to `metres` here. */
function degreesFor(metres: number, atLat: number): { dLat: number; dLon: number } {
  const dLat = metres / METRES_PER_DEGREE_LAT;
  return { dLat, dLon: dLat / Math.max(0.2, Math.cos((atLat * Math.PI) / 180)) };
}

/**
 * Douglas-Peucker, iterative rather than recursive.
 *
 * A coastline way can carry tens of thousands of points, and the recursive
 * formulation is depth-`n` in the worst case — a nearly-straight line, which is
 * exactly what a simplified shoreline segment looks like. A stack overflow in a
 * request handler is a 500 for a map nobody needed.
 *
 * `toleranceM` is in METRES, and that matters: a degree of longitude is shorter
 * than a degree of latitude everywhere but the equator — 79 km against 111 km
 * at 38 degrees north — so a threshold applied to raw degrees would simplify
 * east-west detail about 1.4x more aggressively than north-south, and a
 * coastline would lose its horizontal shape first. Points are scaled into a
 * space where one unit is one tolerance on each axis, which makes the
 * comparison isotropic and the threshold exactly 1.
 */
export function simplify(line: Coord[], toleranceM: number, atLat: number): Coord[] {
  if (line.length < 3) return line;
  const { dLat, dLon } = degreesFor(toleranceM, atLat);
  // Work in a space where one unit is one tolerance on each axis, so the
  // threshold is 1 and the comparison is isotropic.
  const sx = 1 / dLon;
  const sy = 1 / dLat;

  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;

  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;

    const ax = line[first]![0] * sx;
    const ay = line[first]![1] * sy;
    const bx = line[last]![0] * sx;
    const by = line[last]![1] * sy;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i += 1) {
      const px = line[i]![0] * sx;
      const py = line[i]![1] * sy;
      let d: number;
      if (lenSq === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        // Perpendicular distance to the segment, clamped to its ends so a
        // point beyond either end is measured to the end and not to the
        // infinite line through it.
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worst > 1 && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  return line.filter((_, i) => keep[i] === 1);
}

/**
 * Liang-Barsky, clipping an OPEN polyline to a rectangle.
 *
 * One input line becomes zero or more output lines, because a shoreline can
 * leave the box and come back. This is the operation D25 warned against
 * hand-rolling — but what it warned about was closing a POLYGON against the
 * viewport, which has to decide which side is land and got three of five
 * locations wrong. Clipping an open line has no such decision in it: a segment
 * is inside, outside, or crosses, and the crossing point is arithmetic.
 */
export function clipLine(line: Coord[], bbox: BBox): Coord[][] {
  const [west, south, east, north] = bbox;
  const out: Coord[][] = [];
  let current: Coord[] = [];

  const inside = ([lon, lat]: Coord) => lon >= west && lon <= east && lat >= south && lat <= north;

  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const segment = clipSegment(a, b, bbox);
    if (!segment) {
      // Wholly outside: whatever was being collected ends here.
      if (current.length > 1) out.push(current);
      current = [];
      continue;
    }
    const [from, to] = segment;
    // Only two ways a run can start: nothing collected yet, or the previous
    // segment ended outside and flushed. Both leave `current` empty, so there
    // is no third case where the run has to be broken here — a segment whose
    // end is inside the box hands that exact point to the next segment.
    if (current.length === 0) current.push(from);
    current.push(to);
    if (!inside(b)) {
      // Left the box: this run ends at the boundary. Carrying on would draw a
      // straight line across the gap, through water.
      if (current.length > 1) out.push(current);
      current = [];
    }
  }

  if (current.length > 1) out.push(current);
  return out;
}

/** The Liang-Barsky parameter pass for one segment. `null` when wholly out. */
function clipSegment(a: Coord, b: Coord, bbox: BBox): [Coord, Coord] | null {
  const [west, south, east, north] = bbox;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;

  const edges: [number, number][] = [
    [-dx, a[0] - west],
    [dx, east - a[0]],
    [-dy, a[1] - south],
    [dy, north - a[1]],
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      // Parallel to this edge: outside it means the whole segment is out.
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** 4 dp, and drop a line that simplification collapsed to a point. */
function round(lines: Coord[][]): Coord[][] {
  return lines
    .map((line) => line.map(([lon, lat]) => [Number(lon.toFixed(PRECISION)), Number(lat.toFixed(PRECISION))] as Coord))
    .filter((line) => line.length > 1);
}

/**
 * The whole transform, with no network in it: raw ways in, drawable paths out.
 *
 * Exported so it can be tested against real geometry with no Overpass involved,
 * and so a caller with its own source — a regional extract, a cached tile, a
 * survey of their own — can use the same pipeline.
 */
export function prepare(lines: Coord[][], request: CoastlineRequest): Coord[][] {
  const toleranceM = toleranceMetres(request.bbox, request.widthPx);
  const midLat = (request.bbox[1] + request.bbox[3]) / 2;
  const clipped = lines.flatMap((line) => clipLine(line, request.bbox));
  return round(clipped.map((line) => simplify(line, toleranceM, midLat)));
}

/**
 * Stitch ways head-to-tail and keep the loops.
 *
 * OSM stores a coastline as many `way`s that share endpoints, so an island is
 * only a closed shape once its ways are joined. Joining is exact-endpoint
 * matching — OSM ways that continue each other share a node, so the
 * coordinates are identical rather than merely close, and a tolerance here
 * would invent joins between a shore and a pier that nearly touch it.
 *
 * Ways are simplified AFTER this, never before: simplification moves the
 * endpoints of a line, and a way whose endpoint has moved no longer matches its
 * neighbour. Doing it the other way round turns every island into an open line.
 *
 * What does not close comes back as an open chain rather than being thrown
 * away: a mainland shore is one of those, and `closeAgainstViewport` closes it
 * against the box. See `CoastlineResult.land`.
 */
export function closedRings(lines: Coord[][]): Coord[][] {
  return stitch(lines).rings;
}

/**
 * Stitch ways head-to-tail, keeping BOTH what closed and what did not.
 *
 * The two halves go different ways — a ring is land on its own, a chain is
 * only land once it has been closed against something — so they are separated
 * here, once, rather than each caller re-deciding what a loop is.
 *
 * Each chain grows in BOTH directions, which a loop does not need and an open
 * shore does. Overpass returns ways in no particular order, so a forward-only
 * walk that happens to start in the middle of a shore leaves the half behind it
 * as a second chain — and both halves then end INSIDE the box, where a closure
 * has nothing to attach to and drops them. That is what Capo Peloro did: the
 * tip of Sicily is two ways meeting at the lighthouse, and the strait went out
 * with Sicily's shore missing until the walk went backwards too. Ways are never
 * REVERSED to make a join, only walked from either end of what is already
 * joined: reversing one would reverse which side of it is land.
 */
export function stitch(lines: Coord[][]): { rings: Coord[][]; chains: Coord[][] } {
  const key = (c: Coord) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

  const byStart = new Map<string, Coord[][]>();
  const byEnd = new Map<string, Coord[][]>();
  for (const line of lines) {
    for (const [index, map] of [
      [0, byStart],
      [line.length - 1, byEnd],
    ] as const) {
      const k = key(line[index]!);
      const bucket = map.get(k);
      if (bucket) bucket.push(line);
      else map.set(k, [line]);
    }
  }

  const used = new Set<Coord[]>();
  const rings: Coord[][] = [];
  const chains: Coord[][] = [];

  for (const line of lines) {
    if (used.has(line)) continue;
    used.add(line);
    const chain = [...line];
    const closed = () => key(chain[0]!) === key(chain[chain.length - 1]!);
    for (;;) {
      if (closed()) break;
      const next = (byStart.get(key(chain[chain.length - 1]!)) ?? []).find((l) => !used.has(l));
      if (!next) break;
      used.add(next);
      chain.push(...next.slice(1));
    }
    for (;;) {
      if (closed()) break;
      const previous = (byEnd.get(key(chain[0]!)) ?? []).find((l) => !used.has(l));
      if (!previous) break;
      used.add(previous);
      chain.unshift(...previous.slice(0, -1));
    }
    // A loop needs three distinct points to enclose anything.
    if (chain.length > 3 && key(chain[0]!) === key(chain[chain.length - 1]!)) rings.push(chain);
    else if (chain.length > 1) chains.push(chain);
  }

  return { rings, chains };
}

/**
 * Simplify a RING without opening it.
 *
 * Douglas-Peucker pins the first and last point of a line, which for a ring is
 * the same point — so the loop survives, but the one vertex the algorithm is
 * not allowed to move is arbitrary, and a ring simplified from an arbitrary
 * start can keep a spurious spike there. Splitting the ring at its two most
 * distant points and simplifying each half pins two opposite vertices instead,
 * which is the standard fix and costs one extra pass.
 */
function simplifyRing(ring: Coord[], toleranceM: number, atLat: number): Coord[] {
  if (ring.length < 8) return ring;
  const half = Math.floor((ring.length - 1) / 2);
  const a = simplify(ring.slice(0, half + 1), toleranceM, atLat);
  const b = simplify(ring.slice(half), toleranceM, atLat);
  const joined = [...a, ...b.slice(1)];
  // Still a loop, or it is not land.
  return joined.length > 3 ? joined : ring;
}

/* ------------------------------------------------- closing an open shore */

/**
 * Twice the signed area of a ring, positive when it is wound
 * counterclockwise — which under OSM's convention means the land it encloses
 * is on the inside.
 *
 * Degrees, not metres: this is only ever compared against zero or against
 * another ring's sign, and the longitude/latitude scale factor is positive
 * everywhere, so converting would change the number and not the answer.
 */
export function signedArea(ring: Coord[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  }
  return sum / 2;
}

/**
 * The rectangle's corners in counterclockwise order, indexed by the integer
 * part of `perimeterAt`.
 */
function corners([west, south, east, north]: BBox): [Coord, Coord, Coord, Coord] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
}

/**
 * Where a point sits on the rectangle's perimeter, as a number in `[0, 4)`
 * that increases COUNTERCLOCKWISE from the south-west corner — one unit per
 * edge, so the corners are exactly the integers and "walk to the next corner"
 * is `Math.floor(t) + 1`.
 *
 * `null` for a point that is not on the boundary at all, which is how a chain
 * that simply stops inside the box gets dropped instead of closed. That is a
 * real case: a way whose data ends mid-shore closes into a shape with no
 * meaning, and there is nothing to tell you which side of it is water.
 *
 * The tolerance is relative to the box because these points come out of the
 * clipper's own arithmetic — `a + t * (b - a)` lands a few ulps off the edge it
 * was solved for — and an absolute epsilon that suits a 20 km strait is either
 * blind or paranoid at a 2 km one.
 */
function perimeterAt([lon, lat]: Coord, bbox: BBox): number | null {
  const [west, south, east, north] = bbox;
  const width = east - west;
  const height = north - south;
  const eps = Math.max(width, height) * 1e-6;

  const distances = [south - lat, lon - east, lat - north, west - lon].map(Math.abs);
  let edge = 0;
  for (let i = 1; i < 4; i += 1) if (distances[i]! < distances[edge]!) edge = i;
  if (distances[edge]! > eps) return null;

  // Clamped because a corner point is on two edges at once, and the one that
  // wins by a few ulps may be the one it is a hair past the end of.
  const along = (value: number, from: number, size: number) => Math.min(1, Math.max(0, (value - from) / size));
  switch (edge) {
    case 0:
      return along(lon, west, width);
    case 1:
      return 1 + along(lat, south, height);
    case 2:
      return 2 + along(east - lon, 0, width);
    default:
      return 3 + along(north - lat, 0, height);
  }
}

/**
 * Close open coastline chains against the viewport rectangle, on the land side.
 *
 * This is the operation D25 measured a hand-rolled attempt getting three of
 * five locations wrong. What it was missing is one fact, since measured: **OSM
 * winds a coastline so that land is on the LEFT** (486 of 486 closed rings
 * across Gozo, Corfu and Ithaca are counterclockwise, recorded in
 * `docs/decisions/design-feedback.md`). A polygon traversed counterclockwise
 * also has its interior on the left — so the shore and the land polygon agree
 * about direction, and closing one is not a judgement about which side is
 * water. It is: follow the shore, then keep going counterclockwise around the
 * rectangle until you are back where you started.
 *
 * That single rule is what gets the case the earlier attempt got wrong. A shore
 * that enters and leaves through the SAME edge is a peninsula one way round and
 * a bay the other, and the two want opposite closures — a short hop along the
 * edge for the peninsula, a walk around all four for the bay. Nothing has to
 * decide which it is: the direction the shore runs in already says, and going
 * counterclockwise from the exit point to the entry point produces each of them
 * without a special case.
 *
 * **The walk stops at the next shore, not at its own start.** Closing each
 * shore against the box on its own is right until two of them bound the same
 * piece of land — an island wider than the view, an isthmus, a strip between
 * two seas. Then each shore closes to "everything on my side", the two
 * overlap, and the even-odd rule paints their symmetric difference: the two
 * seas, and not the land between them. So the walk from a shore's exit point
 * carries on counterclockwise only until it meets the point where the NEXT
 * shore comes in, and then follows that shore — which stitches the strip's two
 * sides into the one ring they bound. With a single shore in the view the next
 * entry is its own, and this is exactly the paragraph above.
 *
 * Order matters and is not free to change. Chains are clipped first, so every
 * end sits on the boundary; each piece is simplified while its ends are pinned
 * there; and the rectangle walk is added LAST and never simplified. Simplifying
 * afterwards would be free to drop a corner of the box, and a dropped corner is
 * a diagonal cut across it — the diagonal seam D25 saw, arrived at honestly.
 */
export function closeAgainstViewport(chains: Coord[][], request: CoastlineRequest): Coord[][] {
  const toleranceM = toleranceMetres(request.bbox, request.widthPx);
  const midLat = (request.bbox[1] + request.bbox[3]) / 2;
  const box = corners(request.bbox);

  /** Each clipped shore, with where it crosses onto the box and back off it. */
  const pieces: { points: Coord[]; entry: number; exit: number }[] = [];
  for (const chain of chains) {
    for (const piece of clipLine(chain, request.bbox)) {
      const entry = perimeterAt(piece[0]!, request.bbox);
      const exit = perimeterAt(piece[piece.length - 1]!, request.bbox);
      if (entry === null || exit === null) continue;
      // A shore that only grazes the box clips to one point, repeated. It
      // bounds nothing, and left in the list it is a stop no walk can leave:
      // its entry and its exit are the same place, so it is zero distance
      // ahead of itself and every ring being built ends there.
      const [minLon, minLat, maxLon, maxLat] = extent(piece);
      if (minLon === maxLon && minLat === maxLat) continue;
      pieces.push({ points: simplify(piece, toleranceM, midLat), entry, exit });
    }
  }

  /**
   * The first shore that starts at or after `from`, going counterclockwise.
   *
   * A shore already walked into this ring is not a candidate — except the one
   * the ring started from, which is how a ring closes. Without that, a shore
   * that comes in and goes back out at the SAME point is zero distance ahead
   * of its own exit, so a walk that picked it up would be sent back into it and
   * abandon the ring it had.
   */
  const nextFrom = (from: number, seed: number, used: Set<number>): number => {
    let best = -1;
    let nearest = Infinity;
    for (let i = 0; i < pieces.length; i += 1) {
      if (i !== seed && used.has(i)) continue;
      const ahead = (pieces[i]!.entry - from + 4) % 4;
      if (ahead < nearest) {
        nearest = ahead;
        best = i;
      }
    }
    return best;
  };

  /** The corners passed walking counterclockwise from `from` to `to`. */
  const between = (from: number, to: number): Coord[] => {
    const travel = (to - from + 4) % 4;
    const picked: Coord[] = [];
    // Four steps at most, because the walk is bounded by the rectangle and the
    // comparison is modular: a fifth step wraps past the start and reads as
    // "still ahead of the target" forever.
    for (let step = 0; step < 4; step += 1) {
      const corner = Math.floor(from) + 1 + step;
      if ((corner - from + 4) % 4 >= travel) break;
      picked.push(box[(corner % 4) as 0 | 1 | 2 | 3]);
    }
    return picked;
  };

  const used = new Set<number>();
  const out: Coord[][] = [];
  for (let seed = 0; seed < pieces.length; seed += 1) {
    if (used.has(seed)) continue;
    const ring: Coord[] = [];
    let at = seed;
    let closed = false;
    // Bounded by the number of shores: every one is consumed at most once, and
    // the guard below stops a ring that would otherwise revisit one.
    for (let step = 0; step <= pieces.length; step += 1) {
      used.add(at);
      const piece = pieces[at]!;
      ring.push(...piece.points);
      const next = nextFrom(piece.exit, seed, used);
      ring.push(...between(piece.exit, pieces[next]!.entry));
      if (next === seed) {
        closed = true;
        break;
      }
      at = next;
    }
    if (!closed) continue;
    ring.push(ring[0]!);
    // A closure that encloses nothing is a shore running along the boundary,
    // not land. Sign is not checked beyond that: the walk above can only
    // produce a counterclockwise ring, and a negative one would mean this
    // arithmetic is wrong rather than that the data is.
    if (ring.length > 3 && signedArea(ring) > 0) out.push(ring);
  }

  return out;
}

/**
 * Is a point inside this set of rings, under the even-odd rule `MapView` draws
 * them with? Ray casting, one crossing test per edge.
 */
function insideLand(point: Coord, rings: Coord[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[i + 1]!;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}

/**
 * Do any two of these closures overlap?
 *
 * The even-odd rule composes several closures correctly only while they are
 * DISJOINT — which is the ordinary case, because each one is a separate
 * landmass reaching into the view. Where two overlap, even-odd paints their
 * symmetric difference, and the truth is their union or their intersection: two
 * bays cutting into the same land from opposite edges each close to "everything
 * but my bay", and drawn together that fills the two bays and nothing else —
 * the sea, exactly. Per-chain closure cannot express that shape, and general
 * polygon booleans are the thing this module is not.
 *
 * So the case is detected and refused rather than drawn. Shores do not cross
 * each other, so two overlapping closures always put one's shore inside the
 * other, and a vertex is enough to find it. Vertices ON the box are skipped:
 * every closure has some, they are shared between closures that meet at an
 * edge, and a crossing test is ill-defined there anyway.
 */
function overlapping(rings: Coord[][], bbox: BBox): boolean {
  const [west, south, east, north] = bbox;
  const eps = Math.max(east - west, north - south) * 1e-4;
  const inner = ([lon, lat]: Coord) =>
    lon > west + eps && lon < east - eps && lat > south + eps && lat < north - eps;

  const extents = rings.map(extent);
  for (let i = 0; i < rings.length; i += 1) {
    for (let j = 0; j < rings.length; j += 1) {
      if (i === j) continue;
      // Cheap first: two closures whose extents miss each other cannot overlap,
      // and that is nearly every pair on nearly every view.
      const a = extents[i]!;
      const b = extents[j]!;
      if (a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]) continue;
      for (const point of rings[i]!) {
        if (inner(point) && insideLand(point, [rings[j]!])) return true;
      }
    }
  }
  return false;
}

export interface LandOptions {
  /**
   * Lines that are on land by definition — the road network from the same
   * response. They are not drawn as land and never become part of it; they are
   * the WITNESS that the closure came out the right way round.
   *
   * The closure rests on OSM's winding convention, and a convention is exactly
   * the kind of fact that is true until it is not — a re-tagged way, a mirror
   * serving repaired data, a caller passing geometry from somewhere else. A
   * road is on land by definition, so if the fill does not contain the roads it
   * is the sea, and this module would rather draw no fill than lie about which
   * side is water.
   *
   * Nothing else can tell. Wound the other way, the same shores close into the
   * water between them instead of the land around them — a shape just as
   * plausible, just as closed, and wrong. The roads are the only thing in the
   * response that knows which of the two is the land.
   */
  onLand?: Coord[][];
}

/**
 * Below this share of witnesses inside the closure, the closure is treated as
 * inverted and dropped.
 *
 * The two outcomes are not close together: an inverted fill is the complement
 * of the right one, so the roads go from all inside it to all outside it. Half
 * is a long way from either, which is what makes it a safe place to cut — a few
 * coastal roads on the sea side of a simplified shoreline cannot reach it.
 */
const LAND_WITNESS_SHARE = 0.5;

/** Fewer witnesses than this decide nothing, so they are not asked. */
const LAND_WITNESS_MIN = 20;

/**
 * Closed land: rings that closed on their own, plus open shores closed against
 * the viewport.
 *
 * Rings are simplified and rounded but NOT clipped — clipping a ring against
 * the viewport is the operation that inverts land and sea, so they are left
 * whole and the SVG clips the drawing instead, which it does correctly, for
 * free, and without deciding anything. A chain has no such luxury: it only
 * becomes an area by being closed against something, and `closeAgainstViewport`
 * is that, checked afterwards against `options.onLand`.
 */
export function prepareLand(lines: Coord[][], request: CoastlineRequest, options: LandOptions = {}): Coord[][] {
  const toleranceM = toleranceMetres(request.bbox, request.widthPx);
  const midLat = (request.bbox[1] + request.bbox[3]) / 2;
  const { dLat, dLon } = degreesFor(toleranceM, midLat);
  const [west, south, east, north] = request.bbox;

  const { rings, chains } = stitch(lines);

  const kept = rings.filter((ring) => {
    const [minLon, minLat, maxLon, maxLat] = extent(ring);
    // Wholly outside the view. This is a bbox TEST, not a clip: the ring is
    // either drawn whole or not at all, so nothing here can decide which side
    // of a cut edge is land. A ring nobody can see costs only bytes, and Corfu
    // alone brought 467 of them at 17.7 KB gzipped against 4.2 for the stroke.
    if (maxLon < west || minLon > east || maxLat < south || minLat > north) return false;
    // Smaller than a pixel of the render. The same one-pixel rule the
    // simplification tolerance uses, applied to whole shapes: an islet drawn
    // sub-pixel is a smudge that costs a ring.
    return maxLon - minLon >= dLon || maxLat - minLat >= dLat;
  });

  const islands = round(kept.map((ring) => simplifyRing(ring, toleranceM, midLat)));
  const closures = round(
    closeAgainstViewport(chains, request).filter((ring) => {
      const [minLon, minLat, maxLon, maxLat] = extent(ring);
      return maxLon - minLon >= dLon || maxLat - minLat >= dLat;
    }),
  );
  if (!closures.length) return islands;
  // Linking the shores together is what keeps these disjoint, and disjoint is
  // what the even-odd rule needs to compose them. This is the backstop for
  // geometry that defeats it — shores that cross, ways wound against each
  // other — where the honest answer is the stroke-only map.
  if (overlapping(closures, request.bbox)) return islands;

  // The witnesses an island ring already accounts for say nothing about the
  // closure, so they are not counted for or against it.
  const witnesses = (options.onLand ?? [])
    .flat()
    .filter(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north)
    .filter((point) => !insideLand(point, islands));
  if (witnesses.length >= LAND_WITNESS_MIN) {
    const onLand = witnesses.filter((point) => insideLand(point, closures)).length;
    // Refused rather than drawn: a mainland left as a stroke is the map this
    // module drew before closure existed, and it is a better map than one that
    // fills the sea.
    if (onLand < witnesses.length * LAND_WITNESS_SHARE) return islands;
  }

  return [...islands, ...closures];
}

/** `[minLon, minLat, maxLon, maxLat]`, in the order a `BBox` uses. */
function extent(ring: Coord[]): BBox {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/* ---------------------------------------------------------------- network */

/** Overpass takes `(south,west,north,east)`; everything else here is
 * `[west,south,east,north]`. They are not the same order and getting it wrong
 * returns an empty result rather than an error. */
function overpassBbox([west, south, east, north]: BBox): string {
  return `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
}

interface OverpassResponse {
  elements?: { type?: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Overpass's own JSON, not GeoJSON: `geometry` is `{lat, lon}` objects. */
function toLines(response: OverpassResponse): Coord[][] {
  return (response.elements ?? [])
    .filter((element) => element.type === "way" && (element.geometry?.length ?? 0) > 1)
    .map((element) => element.geometry!.map((point) => [point.lon, point.lat] as Coord));
}

/** Overpass way filters per tier. Regexes are anchored: an unanchored
 * `highway~primary` also matches `primary_link`, which is a slip road and
 * doubles the geometry for nothing at these spans. */
const MAJOR_ROADS = '["highway"~"^(motorway|trunk|primary|secondary)$"]';
const MINOR_STREETS = '["highway"~"^(tertiary|unclassified|residential|living_street|pedestrian)$"]';

async function query(selector: string, request: CoastlineRequest, config: CoastlineConfig): Promise<Coord[][]> {
  const doFetch: FetchLike = config.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    data: `[out:json][timeout:60];way${selector}(${overpassBbox(request.bbox)});out geom;`,
  }).toString();

  const response = await doFetch(config.url, {
    method: "POST",
    headers: {
      "User-Agent": config.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}`);
  return toLines((await response.json()) as OverpassResponse);
}

/**
 * Geometry for a bounding box, ready for `MapView`'s `paths` prop.
 *
 * Never throws: a timeout, an outage, a rate limit or malformed JSON all come
 * back as empty geometry, and the map falls back to the graticule it draws by
 * default. Callers are expected to cache — this module holds no cache of its
 * own, because the thing worth persisting is the result and only the caller
 * knows where it can put a file.
 */
export async function fetchCoastline(
  request: CoastlineRequest,
  config: CoastlineConfig,
): Promise<CoastlineResult> {
  if (!config.enabled) return EMPTY;

  const toleranceM = toleranceMetres(request.bbox, request.widthPx);
  const detail = request.detail ?? detailFor(request.bbox, request.widthPx);

  // Each query degrades on its own. A coastline that arrived is worth drawing
  // even when the streets over it did not.
  let partial = false;
  const ask = async (selector: string): Promise<Coord[][]> => {
    try {
      return await query(selector, request, config);
    } catch {
      partial = true;
      return [];
    }
  };

  const coastRaw = await ask('["natural"="coastline"]');
  const roadsRaw = detail === "coast" ? [] : await ask(MAJOR_ROADS);
  const streetsRaw = detail === "streets" ? await ask(MINOR_STREETS) : [];

  return {
    coastline: prepare(coastRaw, request),
    roads: prepare(roadsRaw, request),
    streets: prepare(streetsRaw, request),
    // From the RAW ways, not the clipped-and-simplified ones: both operations
    // move or cut endpoints, and a way whose endpoint moved no longer meets its
    // neighbour, so every island would come apart into open lines.
    //
    // The roads go in as the witness that the closure came out the right way
    // round (`LandOptions.onLand`), which is free here and costs a tier that
    // fetched none of them nothing: with no witnesses the convention stands on
    // its own, which is what it did before this argument existed.
    land: prepareLand(coastRaw, request, { onLand: [...roadsRaw, ...streetsRaw] }),
    detail,
    partial,
    toleranceM,
    attribution: OSM_ATTRIBUTION,
  };
}
