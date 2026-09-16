import type { Logger } from "@opentelemetry/api-logs";
import { OSM_ATTRIBUTION, fetchCoastline, type BBox, type CoastlineResult } from "@schlessera/brain-ui-sdk/server";
import { Hono } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoastlineConfig } from "../config/env.js";

/**
 * Map geometry for an arbitrary place, fetched once and cached forever.
 *
 * `MapView` fetches nothing — that is D13 and it is right, because a component
 * that reaches for the network cannot be rendered in a test, a screenshot or an
 * offline PWA. The kit ships coastline for five fixture locations so its
 * stories have something real to draw. **This route is what makes the map work
 * anywhere else**, which is the difference between a demo and a feature.
 *
 * ## The cache is not an optimisation, it is the licence to do this at all
 *
 * Overpass is a free shared service whose usage policy is written for light
 * interactive use. Fetching per map view would be abuse; fetching once per
 * place and never again is not. **Coastlines do not move**, so there is no TTL
 * here and that is deliberate — a cache entry has no reason to expire, and an
 * expiring one would turn a bounded number of requests into an unbounded one.
 *
 * The consequence to keep in mind: to pick up a genuine OSM improvement, delete
 * the file. That is the right trade for a shoreline and would be the wrong one
 * for anything that changes.
 *
 * ## Quantised keys, so near-identical views share an entry
 *
 * A chat surface asks for the same place with slightly different boxes every
 * time the model phrases a query differently. The key rounds the bbox to 3 dp
 * (~110 m) and buckets the width, so "the same map again" is a cache hit rather
 * than a fresh request to a service we are trying not to bother.
 *
 * ## It never fails
 *
 * Every error path returns empty geometry with a 200. A map with no coastline
 * is a graticule with a correct pin and a correct scale bar — the component's
 * own default, and a good locator. A 500 here would be a chat message that will
 * not render, which is a far worse outcome than a plainer map.
 *
 * ## ODbL
 *
 * A server that caches and serves OSM-derived geometry is distributing a
 * Derivative Database, not merely rendering a Produced Work. `attribution`
 * comes back in every response — including the empty ones — so a client cannot
 * draw this data without having been handed the credit for it.
 */

/** Matches `MapView`'s own default projection width. */
const DEFAULT_WIDTH = 330;

/** The widths a request is rounded to. A phone, a tablet, a desktop pane. */
const WIDTH_BUCKETS = [330, 660, 1320];

/** ~110 m. Two requests for the same place agree to this; a different place
 * does not. */
const KEY_PRECISION = 3;

/** A box larger than this is asking for a continent's shoreline, which is
 * megabytes of geometry nobody can read at any render width. */
const MAX_SPAN_DEGREES = 5;

export interface GeoRouteDeps {
  config: CoastlineConfig;
  log?: Logger;
  /** Injected in tests so no test ever reaches Overpass. */
  fetchGeometry?: typeof fetchCoastline;
}

function bucketWidth(width: number): number {
  return WIDTH_BUCKETS.find((w) => width <= w) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]!;
}

/** `w,s,e,n` → a validated bbox, or `null` with the reason left to the caller. */
export function parseBBox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const parts = raw.split(",").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west >= east || south >= north) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (east - west > MAX_SPAN_DEGREES || north - south > MAX_SPAN_DEGREES) return null;
  return [west, south, east, north];
}

/** Stable, quantised, and safe as a filename. */
export function cacheKey(bbox: BBox, width: number, roads: boolean): string {
  const box = bbox.map((n) => n.toFixed(KEY_PRECISION)).join("_").replace(/-/g, "m");
  return `${box}-w${bucketWidth(width)}${roads ? "-roads" : ""}.json`;
}

export function createGeoRoutes(deps: GeoRouteDeps): Hono {
  const { config, log } = deps;
  const fetchGeometry = deps.fetchGeometry ?? fetchCoastline;

  /** In-flight requests, so a screen with three maps of one place fetches once. */
  const inFlight = new Map<string, Promise<CoastlineResult>>();

  async function readCache(file: string): Promise<CoastlineResult | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as CoastlineResult;
    } catch {
      return null;
    }
  }

  async function writeCache(file: string, result: CoastlineResult): Promise<void> {
    try {
      await mkdir(config.cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(result));
    } catch (err) {
      // A cache that cannot be written is slow, not broken. Serving the
      // geometry we already have in hand is strictly better than failing.
      log?.emit({
        severityText: "WARN",
        body: "coastline cache write failed",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return new Hono().get("/geo/coastline", async (c) => {
    const bbox = parseBBox(c.req.query("bbox"));
    if (!bbox) return c.json({ error: "invalid_bbox" }, 400);

    const width = Number(c.req.query("width") ?? DEFAULT_WIDTH);
    const roads = c.req.query("roads") === "1";
    const key = cacheKey(bbox, Number.isFinite(width) && width > 0 ? width : DEFAULT_WIDTH, roads);
    const file = join(config.cacheDir, key);

    const cached = await readCache(file);
    if (cached) {
      // Cached forever on purpose; see the note above. The header says so, so a
      // PWA can hold it too and a place already looked at costs nothing.
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.json(cached);
    }

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const result = await fetchGeometry(
            { bbox, widthPx: bucketWidth(width), roads },
            { enabled: config.enabled, url: config.url, userAgent: config.userAgent },
          );
          // Only a result with geometry in it is worth keeping: an empty one is
          // usually an outage, and caching that forever would make a transient
          // failure permanent.
          if (result.coastline.length || result.roads.length) await writeCache(file, result);
          return result;
        } catch (err) {
          // `fetchCoastline` already swallows its own failures, so this is the
          // boundary owning the guarantee rather than trusting it: this route
          // must not be able to produce a 500, because a 500 here is a chat
          // message that will not render, and the alternative is a map that is
          // merely plainer.
          log?.emit({
            severityText: "WARN",
            body: "coastline fetch failed",
            attributes: { error: err instanceof Error ? err.message : String(err) },
          });
          return { coastline: [], roads: [], toleranceM: 0, attribution: OSM_ATTRIBUTION };
        }
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    return c.json(await pending);
  });
}
