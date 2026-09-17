/**
 * Regenerates `fixtures/geo/*.json` — the OpenStreetMap geometry `MapView`
 * draws through its `paths` and `land` props.
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
 * ## It runs the SERVER's pipeline, not a copy of it
 *
 * Fetch, clip, simplify, ring assembly and the detail rule all live in
 * `@schlessera/brain-ui-sdk/server`, and this script is a loop around
 * `fetchCoastline`. That is the point: fixtures produced by a second
 * implementation drift from what production draws, and the drift is invisible
 * until someone compares two screenshots taken a month apart.
 *
 * It used to shell out to mapshaper for the clip and the simplify. The
 * hand-written versions were validated against it on real geometry before the
 * swap — the same Overpass response through both gave **identical extents to
 * four decimal places**, with 16% more vertices and more separate polylines
 * because mapshaper joins contiguous ways into arcs. 15 MB and 31 dependencies
 * for two short, well-defined algorithms was the wrong trade for a server, and
 * having made the call once there was no reason to keep it here either.
 *
 * ## Why this data at all (D25, measured in `.plan/research/map-tiles.md`)
 *
 * The map is static and must still be recognisable. Natural Earth is public
 * domain and would have been the easy answer; it is 5-10x too coarse at these
 * spans — fifteen vertices for the whole Troy shoreline — and its coarser
 * scales run the wrong way, with four of these five locations returning zero
 * vertices at 1:110m. So OSM is *necessary* rather than preferred, which is
 * what makes the ODbL obligation unavoidable rather than a choice. See
 * `fixtures/geo/LICENSE`.
 *
 * ## The bbox is larger than the scene, on purpose
 *
 * `MapView` grows its short axis to the card's aspect and then adds a margin,
 * so geometry clipped to the scene's own span would stop short of the drawn
 * viewport and leave the coastline ending in mid-air at the edges. `BLEED`
 * covers it; everything past the viewport is clipped by the SVG at render time
 * and costs only bytes.
 */
import { detailFor, fetchCoastline, type BBox, type MapDetail } from "@schlessera/brain-ui-sdk/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The width `MapView` projects into, and therefore the pixel that both the
 * simplification tolerance and the detail tier are one of. Must equal the
 * component's `W` default. */
const RENDER_WIDTH = 330;

/** How far past the scene's own span to fetch. A wide card can legitimately ask
 * for twice the span in one direction once the short axis has grown to match
 * its aspect, and the margins come on top of that. */
const BLEED = 2.4;

/** OSM asks an SDK to identify itself; a browser cannot, but this script can. */
const USER_AGENT = "brain-kit-fixtures/1.0 (+https://github.com/schlessera/brain-kit)";

/** Overpass is a shared free service. One request at a time, with a pause. */
const POLITE_DELAY_MS = 3_000;

/**
 * Which Overpass to ask. `OVERPASS_URL` overrides it.
 *
 * The canonical instance answers `504 ... the server is probably too busy`
 * freely, and once it decides you are asking a lot it keeps doing so for a
 * while — which is a poor match for a script that makes six requests at once.
 * Public mirrors (`overpass.kumi.systems`, `overpass.osm.ch`) run the same API
 * and are the escape hatch when that happens.
 *
 * The canonical instance is still the DEFAULT, because a mirror's data can be
 * months behind — kumi was serving a June extract in September — and a fixture
 * generator that quietly produces stale geometry is worse than one that makes
 * you wait.
 */
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

interface Location {
  id: string;
  /** What the fixture is called in this world, for the file's own header. */
  label: string;
  /** `[lon, lat]`, matching `MapPath["coords"]`. */
  center: [number, number];
  /** The span the scene renders ACROSS ITS WIDTH, in km. */
  spanKm: number;
  /**
   * Force a finer tier than the span would choose.
   *
   * Only where the automatic answer is wrong, which D25 measured for exactly
   * one of these: Troy is a single shoreline curve at a span the rule calls
   * coastline-sized, and a single curve does not locate you. Its road network
   * is what turns a line into a place.
   */
  detail?: MapDetail;
}

/**
 * Centres are the fixture world's own verified coordinates (`fixtures/places.ts`
 * cites the article each came from).
 *
 * **`spanKm` is the span the SCENE renders at**, not a round number, because it
 * is the divisor in both the simplification tolerance and the detail tier:
 * geometry simplified for a 24 km view and drawn at 9 km facets visibly, and a
 * view fetched as coastline and drawn at street scale is an empty map.
 */
const LOCATIONS: Location[] = [
  { id: "ithaca", label: "Ithaca", center: [20.7202, 38.3647], spanKm: 12 },
  // The town, at the scale a person walks. Same island, same coordinate, two
  // detail tiers: this is the pair the detail rule exists for, and
  // the one place in this world where "what is near me" is a real question.
  { id: "vathy", label: "Vathy", center: [20.7202, 38.3647], spanKm: 1.8 },
  { id: "gozo", label: "Ogygia (Gozo)", center: [14.25, 36.05], spanKm: 18 },
  { id: "corfu", label: "Scheria (Corfu)", center: [19.87, 39.6], spanKm: 52 },
  { id: "messina", label: "The strait", center: [15.6858, 38.2577], spanKm: 9 },
  { id: "troy", label: "Troy", center: [26.2389, 39.9575], spanKm: 30, detail: "roads" },
];

const KM_PER_DEGREE_LAT = 111;

/** How many times to re-ask a busy service before giving up. */
const RETRIES = 4;
const BACKOFF_MS = 15_000;

/** Retry while anything the tier promised is missing, not only when all of it
 * is. A partial result is a tier that timed out, and committing one bakes the
 * outage into the fixture. */
function isEmpty(result: { coastline: unknown[]; roads: unknown[]; streets: unknown[]; partial: boolean }): boolean {
  return result.partial || (!result.coastline.length && !result.roads.length && !result.streets.length);
}

function harvest(location: Location, box: BBox) {
  // The bbox is BLEED times the scene, so at the scene's own scale it would be
  // drawn across BLEED times the render width. Passing the bare render width
  // makes metres-per-pixel come out BLEED times too coarse, which simplifies
  // away detail the scene can show and — worse — picks a detail tier for a view
  // two and a half times larger than the one anyone looks at. Vathy asked for
  // streets and got roads exactly this way.
  return fetchCoastline(
    { bbox: box, widthPx: Math.round(RENDER_WIDTH * BLEED), detail: location.detail },
    {
      enabled: true,
      url: OVERPASS_URL,
      userAgent: USER_AGENT,
      timeoutMs: 90_000,
    },
  );
}

/** `[west, south, east, north]`. */
function bbox(location: Location): BBox {
  const [lon, lat] = location.center;
  const halfKm = (location.spanKm * BLEED) / 2;
  const dLat = halfKm / KM_PER_DEGREE_LAT;
  // Longitude degrees shrink with latitude; at 36-40 degrees that is a 20-25%
  // difference, which is the whole island at these spans.
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

async function main() {
  const wanted = process.argv.slice(2);
  const todo = wanted.length ? LOCATIONS.filter((l) => wanted.includes(l.id)) : LOCATIONS;
  if (!todo.length) throw new Error(`No such location. Known: ${LOCATIONS.map((l) => l.id).join(", ")}`);

  const outDir = join(import.meta.dir, "..", "..", "fixtures", "geo");
  await mkdir(outDir, { recursive: true });

  let first = true;
  for (const location of todo) {
    if (!first) await Bun.sleep(POLITE_DELAY_MS);
    first = false;

    const box = bbox(location);
    // The bbox is BLEED times the scene, so it would be drawn across BLEED
    // times the render width at the scene's own scale. Passing the bare render
    // width instead makes metres-per-pixel come out BLEED times too coarse,
    // which simplifies away detail the scene can show and — worse — picks a
    // detail tier for a view two and a half times larger than the one anyone
    // will look at. Vathy asked for streets and got roads exactly this way.
    // `fetchCoastline` degrades to empty geometry on ANY failure, which is
    // right for a chat surface — a plainer map beats a message that will not
    // render — and leaves this script unable to tell "Overpass is busy" from
    // "there is no coastline here". Emptiness is therefore the retry signal,
    // and the retry lives here rather than in the sdk: a server must fail fast
    // and degrade, a build tool has all the time in the world.
    //
    // Overpass answers `504 ... the server is probably too busy` freely under
    // load, and it is not correlated with the request — the same query can fail
    // and then succeed seconds later.
    let result = await harvest(location, box);
    for (let attempt = 1; attempt <= RETRIES && isEmpty(result); attempt += 1) {
      const wait = BACKOFF_MS * attempt;
      console.log(`${location.id}: incomplete, retrying in ${wait / 1000}s (${attempt}/${RETRIES})`);
      await Bun.sleep(wait);
      result = await harvest(location, box);
    }

    // Writing an empty fixture over a good one is data loss, so this throws
    // rather than writing. Nothing is written before this point.
    if (isEmpty(result)) {
      throw new Error(
        `${location.id}: Overpass returned nothing after ${RETRIES} retries. It rate-limits and ` +
          `times out under load; wait a few minutes and re-run this location on its own. ` +
          `Nothing was written.`,
      );
    }

    const fixture = {
      id: location.id,
      label: location.label,
      center: location.center,
      spanKm: location.spanKm,
      ...result,
    };
    await writeFile(join(outDir, `${location.id}.json`), `${JSON.stringify(fixture)}\n`);

    const verts = [...result.coastline, ...result.roads, ...result.streets, ...result.land].reduce(
      (n, line) => n + line.length,
      0,
    );
    const bytes = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(fixture))).length;
    console.log(
      `${location.id.padEnd(8)} ${result.detail.padEnd(7)} ` +
        `${String(result.coastline.length).padStart(3)} coast ` +
        `${String(result.roads.length).padStart(3)} road ` +
        `${String(result.streets.length).padStart(4)} street ` +
        `${String(result.land.length).padStart(3)} land · ` +
        `${String(verts).padStart(5)} verts · ${(bytes / 1024).toFixed(1)} KB gz · ` +
        `${result.toleranceM} m/px` +
        (detailFor(box, Math.round(RENDER_WIDTH * BLEED)) === result.detail ? "" : " (forced)"),
    );
  }
}

await main();
