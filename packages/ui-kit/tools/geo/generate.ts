/**
 * Regenerates `fixtures/geo/*.json` — the simplified OSM coastline (and, for
 * Troy, roads) that `MapView` draws through its existing `paths` prop.
 *
 * ## Run it by hand. Never in CI.
 *
 *     bun packages/ui-kit/tools/geo/generate.ts            # all locations
 *     bun packages/ui-kit/tools/geo/generate.ts gozo troy  # some of them
 *
 * The output is committed. Overpass's usage policy is written for interactive
 * and light use, and a test suite reaching for it on every run is precisely
 * what it asks you not to do — so this exists to make the data **regenerable**
 * rather than hand-maintained, not to make it fetched.
 *
 * ## Why this data at all (D25, measured in `.plan/research/map-tiles.md`)
 *
 * The map is static and must still be recognisable. Natural Earth is public
 * domain and would have been the easy answer; it is 5-10× too coarse at these
 * spans — fifteen vertices for the whole Troy shoreline — and its coarser
 * scales run the wrong way, with four of these five locations returning zero
 * vertices at 1:110m. So OSM is *necessary* rather than preferred, which is
 * what makes the ODbL obligation unavoidable rather than a choice. See
 * `fixtures/geo/LICENSE`.
 *
 * ## The two numbers that matter
 *
 * **Simplification tolerance is one pixel of the target render**, not a round
 * number: `interval = span_metres / RENDER_WIDTH`. Below it you pay bytes for
 * detail no one can see; above it the shoreline visibly facets. A tolerance
 * sweep on Ithaca put the knee exactly there — 0.5px cost 50% more gzipped
 * bytes than 1px for sub-pixel detail.
 *
 * **Coordinates at 4 dp** — about 11 m, a fifth of a pixel at these spans.
 *
 * ## The bbox is larger than the scene, on purpose
 *
 * `MapView` adds a 12% east-west and 14% north-south margin around its pins, so
 * geometry clipped to the scene's own span would stop short of the drawn
 * viewport and leave the coastline ending in mid-air at the edges. `BLEED`
 * covers the margin with room to spare; everything past the viewport is clipped
 * by the SVG at render time and costs only bytes.
 *
 * ## Fill is deliberately not here
 *
 * An outline does not say which side is land, and filling it is a large
 * legibility gain — but mainland coastline never closes inside a bounding box
 * (Messina and Troy yield zero closed rings), so the polygon has to be closed
 * against the viewport rectangle. That was hand-rolled once as an experiment
 * and got **three of five wrong**: a diagonal seam on Corfu, inverted land and
 * sea on Ithaca. The concept is sound; ad-hoc clipping is where it breaks. Fill
 * arrives via already-assembled land polygons and a real clipper, or not at all.
 *
 * ## Fill: the half that IS safe
 *
 * An island's coastline stitches head-to-tail into a closed loop and is land
 * beyond argument, so those rings are emitted and filled. A mainland shore that
 * enters the bbox on one edge and leaves by another is not, and is left as a
 * stroke. Assembly, ring-safe simplification and the ordering rule all live in
 * `@schlessera/brain-ui-sdk/server` — the same code the server runs, so the
 * fixtures cannot drift from what production produces.
 */
import { prepareLand, type Coord } from "@schlessera/brain-ui-sdk/server";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The width `MapView` projects into, and therefore the pixel the tolerance is
 * one of. Must equal the component's `W` default. */
const RENDER_WIDTH = 330;

/** How far past the scene's own span to fetch, covering `MapView`'s 12%/14%
 * viewport margin with room for a scene that widens to fit its pins. */
const BLEED = 1.4;

const OVERPASS = "https://overpass-api.de/api/interpreter";

/** OSM asks an SDK to identify itself; a browser cannot, but this script can. */
const USER_AGENT = "brain-kit-fixtures/1.0 (+https://github.com/schlessera/brain-kit)";

/** Overpass is a shared free service. One request at a time, with a pause. */
const POLITE_DELAY_MS = 2_000;

interface Location {
  id: string;
  /** What the fixture is called in this world, for the file's own header. */
  label: string;
  /** `[lon, lat]`, matching `MapPath["coords"]`. */
  center: [number, number];
  /** The span the scene renders at, in km. The clip is this times `BLEED`. */
  spanKm: number;
  /**
   * Roads as well as coastline. Only where the coastline alone does not locate
   * you: Troy is a single shoreline curve, which is ambiguous, and its road
   * network is what makes it read as a place rather than as a line.
   */
  roads?: boolean;
}

/**
 * Centres are the fixture world's own verified coordinates (`fixtures/places.ts`
 * cites the article each came from).
 *
 * **`spanKm` is the span the SCENE renders at, not a round number**, because it
 * is the divisor in the tolerance: geometry simplified for a 24 km view and then
 * drawn at 9 km facets visibly, and one simplified for 9 km and drawn at 24 km
 * only wastes bytes. Ithaca and the strait take their scenes' spans from
 * `fixtures/places.ts`; the other three take the span their own scene uses.
 */
const LOCATIONS: Location[] = [
  { id: "ithaca", label: "Ithaca", center: [20.7202, 38.3647], spanKm: 12 },
  { id: "gozo", label: "Ogygia (Gozo)", center: [14.25, 36.05], spanKm: 18 },
  { id: "corfu", label: "Scheria (Corfu)", center: [19.87, 39.6], spanKm: 52 },
  { id: "messina", label: "The strait", center: [15.6858, 38.2577], spanKm: 9 },
  { id: "troy", label: "Troy", center: [26.2389, 39.9575], spanKm: 30, roads: true },
];

const KM_PER_DEGREE_LAT = 111;

/** `[west, south, east, north]`, the order mapshaper's `-clip bbox=` wants. */
function bbox(location: Location): [number, number, number, number] {
  const [lon, lat] = location.center;
  const halfKm = (location.spanKm * BLEED) / 2;
  const dLat = halfKm / KM_PER_DEGREE_LAT;
  // Longitude degrees shrink with latitude; at 36-40° that is a 20-25%
  // difference, which is the whole island at these spans.
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Metres per pixel at the render width — the simplification tolerance. */
function interval(location: Location): number {
  return Math.round((location.spanKm * 1000) / RENDER_WIDTH);
}

async function overpass(query: string): Promise<string> {
  const response = await fetch(OVERPASS, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}: ${await response.text()}`);
  return response.text();
}

/** Overpass takes a bbox as `(south,west,north,east)`. mapshaper takes
 * `west,south,east,north`. They are not the same order and the mistake is
 * silent — you get an empty result rather than an error. */
function overpassBbox([west, south, east, north]: [number, number, number, number]): string {
  return `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;
}

/**
 * Overpass returns its OWN JSON, not GeoJSON — `elements[].geometry` is an array
 * of `{lat, lon}` objects, and mapshaper rejects it with "Invalid GeoJSON". The
 * conversion is four lines and explicit here rather than a second tool in the
 * chain: each `way` with geometry becomes one `LineString`, coordinates in
 * `[lon, lat]` order, which is both GeoJSON's order and `MapPath`'s.
 */
interface OverpassResponse {
  elements?: { type?: string; geometry?: { lat: number; lon: number }[] }[];
}

function overpassLines(response: OverpassResponse): Coord[][] {
  return (response.elements ?? [])
    .filter((element) => element.type === "way" && (element.geometry?.length ?? 0) > 1)
    .map((element) => element.geometry!.map((point) => [point.lon, point.lat] as Coord));
}

function toGeoJson(lines: Coord[][]): GeoJson {
  return {
    type: "FeatureCollection",
    features: lines.map((coordinates) => ({
      type: "Feature" as const,
      properties: {},
      geometry: { type: "LineString" as const, coordinates },
    })),
  };
}

interface Geometry {
  type?: string;
  coordinates?: unknown;
}

interface GeoJson {
  type?: string;
  features?: { geometry?: Geometry }[];
  geometries?: Geometry[];
}

/**
 * Every LineString in a GeoJSON, as `[lon, lat]` arrays.
 *
 * Reads BOTH shapes on purpose: the input is a `FeatureCollection`, and
 * mapshaper writes a bare `GeometryCollection` back when the features carry no
 * properties — which ours do not, because a coastline way's OSM tags are not
 * something the fixture ships. Reading only `features` silently yields nothing
 * and every location reports zero vertices, which is how this was first
 * written.
 */
function lines(geojson: GeoJson): [number, number][][] {
  const out: [number, number][][] = [];
  const geometries = geojson.geometries ?? (geojson.features ?? []).map((f) => f.geometry);
  for (const geometry of geometries) {
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      out.push(geometry.coordinates as [number, number][]);
    } else if (geometry.type === "MultiLineString") {
      out.push(...(geometry.coordinates as [number, number][][]));
    }
  }
  // A one-point line draws nothing and still costs a JSON array.
  return out.filter((line) => line.length > 1);
}

async function mapshaper(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["bunx", "--bun", "mapshaper@0.7.61", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`mapshaper failed: ${await new Response(proc.stderr).text()}`);
}

/** Fetch → clip → simplify → `[lon, lat]` arrays, for one OSM selector. */
async function harvest(
  location: Location,
  selector: string,
  work: string,
  name: string,
): Promise<{ lines: [number, number][][]; raw: Coord[][] }> {
  const box = bbox(location);
  const raw = await overpass(
    `[out:json][timeout:90];way${selector}(${overpassBbox(box)});out geom;`,
  );
  const rawLines = overpassLines(JSON.parse(raw) as OverpassResponse);
  const rawPath = join(work, `${location.id}-${name}.raw.json`);
  await writeFile(rawPath, JSON.stringify(toGeoJson(rawLines)));

  const outPath = join(work, `${location.id}-${name}.geo.json`);
  await mapshaper(
    [
      `${location.id}-${name}.raw.json`,
      "-clip",
      `bbox=${box.map((n) => n.toFixed(4)).join(",")}`,
      "-simplify",
      "dp",
      `interval=${interval(location)}`,
      "-o",
      "precision=0.0001",
      "format=geojson",
      `${location.id}-${name}.geo.json`,
    ],
    work,
  );

  return { lines: lines(JSON.parse(await readFile(outPath, "utf8")) as GeoJson), raw: rawLines };
}

async function main() {
  const wanted = process.argv.slice(2);
  const todo = wanted.length ? LOCATIONS.filter((l) => wanted.includes(l.id)) : LOCATIONS;
  if (!todo.length) throw new Error(`No such location. Known: ${LOCATIONS.map((l) => l.id).join(", ")}`);

  const outDir = join(import.meta.dir, "..", "..", "fixtures", "geo");
  await mkdir(outDir, { recursive: true });
  const work = join(tmpdir(), `brain-kit-geo-${Date.now()}`);
  await mkdir(work, { recursive: true });

  let first = true;
  for (const location of todo) {
    if (!first) await Bun.sleep(POLITE_DELAY_MS);
    first = false;

    const coast = await harvest(location, '["natural"="coastline"]', work, "coastline");
    const coastline = coast.lines;
    // Land comes from the RAW ways, never the clipped and simplified ones: both
    // operations move or cut endpoints, and a way whose endpoint has moved no
    // longer meets its neighbour, so every island would come apart into lines.
    const land = prepareLand(coast.raw, { bbox: bbox(location), widthPx: RENDER_WIDTH });
    let roads: [number, number][][] = [];
    if (location.roads) {
      await Bun.sleep(POLITE_DELAY_MS);
      roads = (await harvest(location, '["highway"~"^(motorway|trunk|primary)$"]', work, "roads")).lines;
    }

    const fixture = {
      id: location.id,
      label: location.label,
      center: location.center,
      spanKm: location.spanKm,
      // The tolerance this was simplified at, in metres, so a reader can tell
      // whether the data suits a render wider than the one it was built for.
      toleranceM: interval(location),
      attribution: "© OpenStreetMap contributors",
      coastline,
      roads,
      land,
    };

    const file = join(outDir, `${location.id}.json`);
    await writeFile(file, `${JSON.stringify(fixture)}\n`);

    const vertices = [...coastline, ...roads].reduce((n, l) => n + l.length, 0);
    const bytes = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(fixture))).length;
    console.log(
      `${location.id.padEnd(8)} ${String(coastline.length).padStart(3)} coast + ${String(roads.length).padStart(3)} road + ${String(land.length).padStart(3)} land · ` +
        `${String(vertices).padStart(5)} verts · ${(bytes / 1024).toFixed(1)} KB gz · tolerance ${interval(location)} m`,
    );
  }

  await rm(work, { recursive: true, force: true });
}

await main();
