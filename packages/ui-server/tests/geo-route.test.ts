/**
 * The route that makes the map work somewhere other than the five places the
 * kit ships fixtures for.
 *
 * No test here reaches Overpass: `fetchGeometry` is injected. That is the
 * repo's no-network rule, and it is also the point of the route — a test suite
 * hammering a free shared service is exactly what its usage policy asks us not
 * to write.
 *
 * What is worth asserting is almost entirely about the CACHE, because the cache
 * is what makes using Overpass at all defensible: one request per place, ever.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoastlineResult } from "@schlessera/brain-ui-sdk/server";

import type { CoastlineConfig } from "../src/config/env.js";
import { cacheKey, createGeoRoutes, parseBBox } from "../src/routes/geo.js";

const STRAIT = "15.6,38.2,15.8,38.32";

const GEOMETRY: CoastlineResult = {
  coastline: [
    [
      [15.62, 38.21],
      [15.65, 38.24],
    ],
  ],
  roads: [],
  toleranceM: 53,
  attribution: "© OpenStreetMap contributors",
};

const EMPTY: CoastlineResult = { coastline: [], roads: [], toleranceM: 53, attribution: "© OpenStreetMap contributors" };

async function config(): Promise<CoastlineConfig> {
  return {
    enabled: true,
    url: "https://overpass.invalid/api/interpreter",
    userAgent: "brain-kit-test/1.0",
    cacheDir: await mkdtemp(join(tmpdir(), "geo-cache-")),
  };
}

function counting(result: CoastlineResult = GEOMETRY) {
  const calls: { bbox: number[]; widthPx: number; roads?: boolean }[] = [];
  const fetchGeometry = async (request: { bbox: number[]; widthPx: number; roads?: boolean }) => {
    calls.push(request);
    return result;
  };
  return { calls, fetchGeometry: fetchGeometry as never };
}

describe("parseBBox", () => {
  test("accepts west,south,east,north", () => {
    expect(parseBBox(STRAIT)).toEqual([15.6, 38.2, 15.8, 38.32]);
  });

  test("refuses a box that is inside out", () => {
    // Swapping the pairs is the easy mistake, and it silently returns an empty
    // result from Overpass rather than an error, so it has to be caught here.
    expect(parseBBox("15.8,38.32,15.6,38.2")).toBeNull();
  });

  test("refuses coordinates off the globe", () => {
    expect(parseBBox("-200,38.2,15.8,38.32")).toBeNull();
    expect(parseBBox("15.6,-91,15.8,38.32")).toBeNull();
  });

  test("refuses a continent", () => {
    // Megabytes of shoreline nobody can read at any render width, and a heavy
    // request to a service we are trying not to bother.
    expect(parseBBox("0,30,40,60")).toBeNull();
  });

  test("refuses nonsense rather than coercing it", () => {
    expect(parseBBox(undefined)).toBeNull();
    expect(parseBBox("")).toBeNull();
    expect(parseBBox("15.6,38.2,15.8")).toBeNull();
    expect(parseBBox("a,b,c,d")).toBeNull();
  });
});

describe("cacheKey", () => {
  test("two near-identical views share one entry", () => {
    // A chat surface asks for the same place with a slightly different box
    // every time the model phrases the query differently. 3 dp is ~110 m.
    const a = parseBBox("15.6001,38.2001,15.8001,38.3201")!;
    const b = parseBBox("15.6002,38.2002,15.8002,38.3202")!;
    expect(cacheKey(a, 330, false)).toBe(cacheKey(b, 330, false));
  });

  test("a different place does not", () => {
    const a = parseBBox(STRAIT)!;
    const b = parseBBox("14.1,35.9,14.4,36.2")!;
    expect(cacheKey(a, 330, false)).not.toBe(cacheKey(b, 330, false));
  });

  test("width is bucketed, so a phone and a slightly wider phone agree", () => {
    const bbox = parseBBox(STRAIT)!;
    expect(cacheKey(bbox, 320, false)).toBe(cacheKey(bbox, 330, false));
    // But a desktop pane gets its own, finer geometry.
    expect(cacheKey(bbox, 330, false)).not.toBe(cacheKey(bbox, 1000, false));
  });

  test("roads are a different entry", () => {
    const bbox = parseBBox(STRAIT)!;
    expect(cacheKey(bbox, 330, true)).not.toBe(cacheKey(bbox, 330, false));
  });

  test("is safe as a filename", () => {
    // Negative longitudes are the trap: a leading "-" is fine but a path
    // separator is not, and coordinates west of Greenwich are common.
    const key = cacheKey(parseBBox("-9.2,38.6,-9.0,38.8")!, 330, false);
    expect(key).not.toContain("/");
    expect(key).toMatch(/^[\w.-]+$/);
  });
});

describe("the route", () => {
  test("rejects a bad bbox before reaching the network", async () => {
    const { calls, fetchGeometry } = counting();
    const app = createGeoRoutes({ config: await config(), fetchGeometry });
    const res = await app.request("/geo/coastline?bbox=nonsense");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("fetches once, then serves from disk", async () => {
    // The whole argument for using a free shared service at all.
    const cfg = await config();
    const { calls, fetchGeometry } = counting();
    const app = createGeoRoutes({ config: cfg, fetchGeometry });

    const first = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(await first.json()).toEqual(GEOMETRY);
    expect(calls).toHaveLength(1);

    const second = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(await second.json()).toEqual(GEOMETRY);
    expect(calls).toHaveLength(1);

    expect(await readdir(cfg.cacheDir)).toHaveLength(1);
  });

  test("a cached entry is served immutable, because a coastline does not move", async () => {
    const cfg = await config();
    const { fetchGeometry } = counting();
    const app = createGeoRoutes({ config: cfg, fetchGeometry });
    await app.request(`/geo/coastline?bbox=${STRAIT}`);
    const res = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  test("three maps of one place in flight together fetch once", async () => {
    // A screen can carry several maps, and a cold cache would otherwise send
    // one request per map for the same geometry.
    const { calls, fetchGeometry } = counting();
    const app = createGeoRoutes({ config: await config(), fetchGeometry });
    await Promise.all([
      app.request(`/geo/coastline?bbox=${STRAIT}`),
      app.request(`/geo/coastline?bbox=${STRAIT}`),
      app.request(`/geo/coastline?bbox=${STRAIT}`),
    ]);
    expect(calls).toHaveLength(1);
  });

  test("an outage is not cached, so it does not become permanent", async () => {
    // An empty result is usually a timeout or a rate limit. Writing that to a
    // cache with no TTL would turn a bad afternoon into a place that never has
    // a coastline again.
    const cfg = await config();
    const { calls, fetchGeometry } = counting(EMPTY);
    const app = createGeoRoutes({ config: cfg, fetchGeometry });

    const res = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
    expect(await readdir(cfg.cacheDir).catch(() => [])).toHaveLength(0);

    await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(calls).toHaveLength(2);
  });

  test("a map with no coastline is a 200, never a 500", async () => {
    // A graticule with a correct pin and a correct scale bar is a good
    // locator. A chat message that will not render is not.
    const app = createGeoRoutes({
      config: await config(),
      fetchGeometry: (async () => {
        throw new Error("overpass exploded");
      }) as never,
    });
    const res = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      coastline: [],
      roads: [],
      toleranceM: 0,
      attribution: "© OpenStreetMap contributors",
    });
  });

  test("every response carries the attribution, including the empty ones", async () => {
    // A server that caches and serves OSM-derived geometry is distributing a
    // Derivative Database. A client must not be able to draw it without having
    // been handed the credit.
    const { fetchGeometry } = counting(EMPTY);
    const app = createGeoRoutes({ config: await config(), fetchGeometry });
    const res = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect((await res.json()).attribution).toBe("© OpenStreetMap contributors");
  });

  test("a corrupt cache file is refetched rather than served", async () => {
    const cfg = await config();
    const { calls, fetchGeometry } = counting();
    const app = createGeoRoutes({ config: cfg, fetchGeometry });
    const bbox = parseBBox(STRAIT)!;
    await writeFile(join(cfg.cacheDir, cacheKey(bbox, 330, false)), "{ this is not json");

    const res = await app.request(`/geo/coastline?bbox=${STRAIT}`);
    expect(await res.json()).toEqual(GEOMETRY);
    expect(calls).toHaveLength(1);
  });

  test("roads are asked for only when requested", async () => {
    const { calls, fetchGeometry } = counting();
    const app = createGeoRoutes({ config: await config(), fetchGeometry });
    await app.request(`/geo/coastline?bbox=${STRAIT}`);
    await app.request(`/geo/coastline?bbox=${STRAIT}&roads=1`);
    expect(calls.map((call) => call.roads === true)).toEqual([false, true]);
  });
});
