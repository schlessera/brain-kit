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
 * **The thing that must NOT be hand-rolled is polygon ring closure**, which is
 * what D25 measured going wrong: closing mainland coastline against a viewport
 * rectangle got three of five locations wrong, with diagonal seams and inverted
 * land and sea. That is `fill`, and this module deliberately does not do it. An
 * open polyline clipped against a rectangle has no such trap.
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
   * Roads as well as coastline. Worth it only where the coastline alone does
   * not locate you — an inland place has no coastline at all, and a single
   * shoreline curve is ambiguous.
   */
  roads?: boolean;
}

export interface CoastlineResult {
  coastline: Coord[][];
  roads: Coord[][];
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
  try {
    const coastRaw = await query('["natural"="coastline"]', request, config);
    const roadsRaw = request.roads
      ? await query('["highway"~"^(motorway|trunk|primary)$"]', request, config)
      : [];
    return {
      coastline: prepare(coastRaw, request),
      roads: prepare(roadsRaw, request),
      toleranceM,
      attribution: OSM_ATTRIBUTION,
    };
  } catch {
    // A graticule with a correct pin and a correct scale bar is a good locator.
    // A message that will not render is not.
    return { ...EMPTY, toleranceM };
  }
}
