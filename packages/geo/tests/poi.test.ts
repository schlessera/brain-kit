import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GeoClient } from "../src/server/client.js";
import { normalizeTrack } from "../src/track.js";
import type { GeoConfigInput } from "../src/config.js";
import type { PoiQuery } from "../src/server/poi.js";
import type { GeoRuntimeOptions } from "../src/server/io.js";

const roots: string[] = [];
afterEach(async () => {for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});});
const primary = "https://overpass.example.invalid/api/interpreter", secondary = "https://fallback.example.invalid/api/interpreter";
const query: PoiQuery = {near: {lat: 38.36, lon: 20.71}, tags: {amenity: "cafe"}, radiusM: 100};
const cafe = {type: "node", id: 123, lat: 38.3601, lon: 20.7101, tags: {name: "Ithaca café", amenity: "cafe", opening_hours: "Mo-Fr 09:00-17:00"}};
const park = {type: "way", id: 124, center: {lat: 38.361, lon: 20.711}, tags: {amenity: "parking"}};
async function setup(fetchImpl: GeoRuntimeOptions["fetchImpl"], extra: GeoConfigInput = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-geo-poi-")); roots.push(root);
  const config: GeoConfigInput = {userAgent: "brain-geo-fixture/1.0", cacheDir: root, minimumIntervalMs: 0,
    overpass: {enabled: true, endpoints: [primary, secondary]}, ...extra};
  const runtime = {fetchImpl, admissionDir: join(root, "admission")};
  return {config, runtime, geo: new GeoClient(config, runtime)};
}

/** Instance-local latency observation; retain the real fsync/rename writer. */
function delayAdmissionWrites(geo: GeoClient, delayMs: number, admissionDir: string) {
  const instrumented = (geo as unknown as {transport: {writeAtomic(path: string, value: unknown): Promise<void>}}).transport;
  const original = instrumented.writeAtomic;
  const writes = new Map<string, number>(), delayed: string[] = [];
  instrumented.writeAtomic = async (path, value) => {
    const count = (writes.get(path) ?? 0) + 1; writes.set(path, count);
    const admission = dirname(path) === admissionDir;
    if (admission && count % 2 === 0) await Bun.sleep(delayMs);
    await original.call(instrumented, path, value);
    if (admission && count % 2 === 0) delayed.push(path);
  };
  return {writes, delayed, restore() {instrumented.writeAtomic = original;}};
}

describe("bounded shared Overpass POI queries", () => {
  test("a nonempty query identifies itself, keeps unknown hours and serves another client from disk", async () => {
    const requests: {url: string; init: RequestInit}[] = [];
    const {geo, config, runtime} = await setup(async (url, init) => {requests.push({url, init}); return Response.json({elements: [cafe, park]});});
    const result = await geo.poi(query);
    expect(result.value).toHaveLength(2);
    expect(result.value![0]).toMatchObject({name: "Ithaca café", openingHours: {value: "Mo-Fr 09:00-17:00", interpreted: false}});
    expect(result.value![1]).toMatchObject({position: "bounding_box_center", openingHours: {value: null, interpreted: false}, unknown: [{field: "openingHours", reason: "not_mapped"}]});
    expect(result.value![0]!.distance.value!).toBeGreaterThan(0);
    expect(result.source).toMatchObject({endpoint: primary, fallback: {used: false}, transfer: {data: "query_geometry", sent: true}});
    const request = requests[0]!, text = new URLSearchParams(String(request.init.body)).get("data")!;
    expect(text).toContain('nwr["amenity"="cafe"](around:100,38.36,20.71)');
    expect(text).toContain("[maxsize:33554432]"); expect(text).toEndWith("out center 1001;");
    expect(new Headers(request.init.headers).get("User-Agent")).toBe("brain-geo-fixture/1.0");
    const cached = await new GeoClient(config, runtime).poi(query);
    expect(cached.value).toHaveLength(2);
    expect(cached.source).toMatchObject({fromCache: true, fetchedAt: result.source!.fetchedAt, transfer: {sent: false}});
    expect(requests).toHaveLength(1);
  });

  test("along-track queries keep gaps, complete recovery metadata and unsimplified coordinates", async () => {
    let text = "";
    const track = normalizeTrack([[{lat: 0, lon: 0}, {lat: 0, lon: 0.001}, {lat: 91, lon: 0.002}, {lat: 0, lon: 0.003}, {lat: 0, lon: 0.004}]]);
    const original = JSON.stringify(track);
    const {geo} = await setup(async (_url, init) => {text = new URLSearchParams(String(init.body)).get("data")!;
      return Response.json({elements: [{...cafe, lat: 0, lon: 0.002}]});});
    const result = await geo.poi({alongTrack: track, tags: {amenity: "cafe"}, radiusM: 50});
    expect(result.value).toHaveLength(1);
    expect(result.value![0]!.distance.value!).toBeGreaterThan(110);
    expect(text.match(/nwr/g)).toHaveLength(2);
    expect(text).toContain("(around:50,0,0,0,0.001)"); expect(text).toContain("(around:50,0,0.003,0,0.004)");
    expect(result).toMatchObject({status: "partial", track: {partial: true, counts: {input: 5, retained: 4, omitted: 1, segments: 2}}});
    expect(result.track!.omissions).toEqual(track.omissions);
    expect(JSON.stringify(track)).toBe(original);
  });

  test("exact tag values are escaped and reordered identical filters share a cache key", async () => {
    let requests = 0, text = "";
    const {geo} = await setup(async (_url, init) => {requests++; text = new URLSearchParams(String(init.body)).get("data")!; return Response.json({elements: [cafe]});});
    const value = 'cafe"];out;("\\';
    const first = await geo.poi({...query, tags: {name: value, amenity: true}});
    expect(first.value).toHaveLength(1);
    expect(text).toContain(`["name"=${JSON.stringify(value)}]`); expect(text).toContain('["amenity"]');
    expect((await geo.poi({...query, tags: {amenity: true, name: value}})).source!.fromCache).toBe(true);
    expect(requests).toBe(1);
  });

  test("disabled, unconfigured and invalid spatial/query inputs send no request", async () => {
    let requests = 0;
    const fetchImpl = async () => {requests++; return Response.json({elements: [cafe]});};
    expect((await (await setup(fetchImpl, {overpass: {enabled: false, endpoints: [primary]}})).geo.poi(query)).status).toBe("disabled");
    expect((await (await setup(fetchImpl, {overpass: {enabled: true, endpoints: []}})).geo.poi(query)).error!.code).toBe("configuration");
    const {geo} = await setup(fetchImpl);
    for (const bad of [{...query, radiusM: 0}, {...query, radiusM: 5_001}, {...query, tags: {}}, {...query, tags: {name: "raw\ncontrol"}},
      {...query, near: {lat: 91, lon: 0}}, {...query, near: {lat: 90, lon: 0}},
      {alongTrack: normalizeTrack([[{lat: 0, lon: 0}, {lat: 0, lon: 6}]]), tags: query.tags, radiusM: 100},
      {alongTrack: normalizeTrack([[]]), tags: query.tags, radiusM: 100}] as PoiQuery[]) {
      expect(await geo.poi(bad)).toMatchObject({error: {code: "input"}});
    }
    expect(requests).toBe(0);
  });

  test("point, section and UTF-8 query budgets refuse before dispatch without simplification", async () => {
    let requests = 0;
    const {geo} = await setup(async () => {requests++; return Response.json({elements: [cafe]});});
    const input = (sections: {lat: number; lon: number}[][]) => ({alongTrack: normalizeTrack(sections), tags: query.tags, radiusM: 100});
    for (const bad of [input([Array.from({length: 2_001}, (_, i) => ({lat: 0, lon: i / 10_000}))]),
      input(Array.from({length: 101}, (_, i) => [{lat: 0, lon: i / 10_000}]))]) {
      expect(await geo.poi(bad)).toMatchObject({error: {code: "input"}});
    }
    const huge = input([Array.from({length: 2_000}, (_, i) => ({lat: 38 + 1 / Math.PI, lon: 20 + 1 / Math.PI + i / 100_000}))]);
    expect(await geo.poi(huge)).toMatchObject({error: {message: "POI query exceeds 64 KiB."}});
    expect(requests).toBe(0);
  });

  // Classification owns a generous fixture budget even when real durable
  // admission persistence is slow. Only a deliberately stalled request
  // below proves the transport deadline; a remark is a decoder outcome.
  for (const admissionDelayMs of [0, 150]) {
    for (const failure of [
      {name: "wrong-shape JSON", code: "bad_response", response: () => Response.json({wrong: "shape"})},
      {name: "malformed JSON", code: "bad_response", response: () => new Response("{")},
      {name: "HTTP error", code: "http", response: () => new Response("broken", {status: 503})},
      {name: "runtime timeout remark", code: "timeout", response: () => Response.json({elements: [], remark: "runtime error: Query timed out"})},
    ] as const) test(`${failure.name} keeps classification, ordered fallback and cache provenance after ${admissionDelayMs}ms persistence`, async () => {
      const urls: string[] = [];
      const {geo, runtime} = await setup(async url => {
        urls.push(url);
        if (url === secondary) return Response.json({elements: [cafe]});
        return failure.response();
      }, {timeoutMs: 5_000});
      const persistence = delayAdmissionWrites(geo, admissionDelayMs, runtime.admissionDir);
      try {
        const result = await geo.poi(query);
        expect(result.attempts[0]?.error?.code, "POI_PRIMARY_CLASSIFICATION").toBe(failure.code);
        expect(result.value, "POI_CLASSIFIED_NONEMPTY_FALLBACK").toHaveLength(1);
        expect(urls, "POI_ORDERED_EXACTLY_ONCE_FALLBACK").toEqual([primary, secondary]);
        expect(result.source).toMatchObject({endpoint: secondary, fromCache: false,
          fallback: {used: true, primaryEndpoint: primary, reason: failure.code}});
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts.map(a => a.requestSent)).toEqual([true, true]);
        expect(persistence.delayed, "REAL_DELAYED_ADMISSION_WRITES_COMPLETED").toHaveLength(2);
        for (const path of persistence.delayed) {
          expect(persistence.writes.get(path)).toBe(2);
          expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({blockedUntil: 0});
        }
        expect((await readdir(runtime.admissionDir)).filter(name => name.endsWith(".lock"))).toEqual([]);
        const cached = await geo.poi(query);
        expect(cached.value).toEqual(result.value);
        expect(cached.source).toMatchObject({endpoint: secondary, fromCache: true,
          fallback: {used: true, primaryEndpoint: primary, reason: failure.code}});
        expect(cached.attempts[0]?.error?.code, "CACHED_FALLBACK_PRIMARY_FAILURE_RETAINED").toBe(failure.code);
        expect(cached.attempts.map(a => a.requestSent)).toEqual([true, false]);
        expect(urls, "CACHED_SECONDARY_NO_EXTRA_REQUEST").toEqual([primary, secondary, primary]);
      } finally {persistence.restore();}
    });
  }

  test("a genuinely stalled primary observes abort and then exactly one secondary succeeds within a bounded settlement", async () => {
    const timeoutMs = 5_000, watchdogHeadroomMs = 1_500;
    const urls: string[] = [];
    let aborted = false, releaseStalled: (() => void) | undefined;
    const {geo} = await setup(async (url, init) => {
      urls.push(url);
      if (url === secondary) return Response.json({elements: [cafe]});
      return new Promise<Response>((resolve, reject) => {
        releaseStalled = () => resolve(Response.json({elements: [cafe]}));
        init.signal!.addEventListener("abort", () => {aborted = true; reject(new Error("aborted"));}, {once: true});
      });
    }, {timeoutMs});
    const pending = geo.poi(query);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, new Promise<null>(resolve => {
        watchdog = setTimeout(() => resolve(null), timeoutMs + watchdogHeadroomMs);
      })]);
      expect(result, "POI_CHAIN_SETTLED_WITHIN_BUDGET").not.toBeNull();
      expect(aborted, "POI_PRIMARY_ABORT_OBSERVED").toBe(true);
      expect(result!.attempts[0]?.error?.code).toBe("timeout");
      expect(result!.value, "POI_TIMEOUT_NONEMPTY_FALLBACK").toHaveLength(1);
      expect(urls, "POI_TIMEOUT_EXACTLY_ONCE_ENDPOINT_ORDER").toEqual([primary, secondary]);
      expect(result!.attempts.map(a => a.requestSent)).toEqual([true, true]);
      expect(result!.source).toMatchObject({endpoint: secondary, fallback: {used: true, reason: "timeout", primaryEndpoint: primary}});
    } finally {
      clearTimeout(watchdog);
      // A missing timeout guard must fail its named settlement assertion,
      // then release the real request before afterEach removes owned state.
      releaseStalled?.();
      await pending;
    }
  });

  test("denials stop fallback even to an already cached endpoint and persist across clients", async () => {
    for (const status of [401, 403, 429, 504]) {
      const urls: string[] = [];
      let denied = false;
      const {geo, config, runtime} = await setup(async url => {
        urls.push(url); return denied && url === primary ? new Response("admission", {status, headers: {"Retry-After": "60"}}) : Response.json({elements: [cafe]});
      });
      await new GeoClient({...config, overpass: {enabled: true, endpoints: [secondary]}}, runtime).poi(query);
      urls.length = 0; denied = true;
      const first = await geo.poi(query);
      expect(urls).toEqual([primary]);
      expect(first).toMatchObject({error: {code: "admission_denied", httpStatus: status}});
      const next = await new GeoClient(config, runtime).poi({...query, radiusM: 101});
      expect(next.error!.code).toBe("admission_denied"); expect(next.source!.requestSent).toBe(false);
      expect(urls).toEqual([primary]);
    }
  });

  test("a resource-denial JSON remark is neither a cached empty match nor fallback permission", async () => {
    const urls: string[] = [];
    const {geo, config, runtime} = await setup(async url => {urls.push(url); return Response.json({elements: [], remark: "runtime error: Query run out of memory"});});
    const first = await geo.poi(query);
    expect(first.error!.code).toBe("admission_denied");
    expect(first.value).toBeNull(); expect(urls).toEqual([primary]);
    expect((await new GeoClient(config, runtime).poi(query)).error!.code).toBe("admission_denied");
    expect(urls).toEqual([primary]);
  });

  test("genuine empty matches cache; wholly malformed elements are retried as errors", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return Response.json({elements: count <= 2 ? [{...cafe, lat: 91}] : []});});
    expect(await geo.poi(query)).toMatchObject({error: {code: "bad_response"}});
    expect((await geo.poi(query)).status).toBe("no_match");
    expect((await geo.poi(query)).source!.fromCache).toBe(true);
    expect(count).toBe(3);
  });

  test("partial element replies, duplicate identities and the result sentinel are disclosed", async () => {
    const {geo} = await setup(async () => Response.json({elements: [cafe, {...cafe, lat: 91}, cafe, park]}));
    const result = await geo.poi(query);
    expect(result.value).toHaveLength(2);
    expect(result).toMatchObject({status: "partial", counts: {input: 4, retained: 2, omitted: 2}, truncated: false});
    const {geo: capped} = await setup(async () => Response.json({elements: Array.from({length: 1_001}, (_, i) => ({...cafe, id: i + 1}))}));
    const cap = await capped.poi(query);
    expect(cap.value).toHaveLength(1_000);
    expect(cap).toMatchObject({status: "partial", truncated: true, counts: {input: 1_001, retained: 1_000, omitted: 1}});
    expect(cap.warnings.some(w => w.includes("more matching"))).toBe(true);
  });

  test("every failed endpoint is attempted once and a cached fallback retains its cause", async () => {
    const urls: string[] = [], third = "https://third.example.invalid/api/interpreter";
    const {geo} = await setup(async url => {urls.push(url); return new Response("down", {status: 503});},
      {overpass: {enabled: true, endpoints: [primary, secondary, third]}});
    expect((await geo.poi(query)).error!.code).toBe("http"); expect(urls).toEqual([primary, secondary, third]);
    const {geo: duplicate} = await setup(async url => {urls.push(url); return new Response("down", {status: 503});},
      {overpass: {enabled: true, endpoints: [primary, primary, secondary]}});
    urls.length = 0; await duplicate.poi(query); expect(urls).toEqual([primary, secondary]);
  });

  test("zero coordinates, isolated retained evidence and malformed representative points stay explicit", async () => {
    const bodies: string[] = [];
    const {geo} = await setup(async (_url, init) => {
      bodies.push(new URLSearchParams(String(init.body)).get("data")!);
      return Response.json({elements: [{...cafe, lat: 0, lon: 0, tags: {amenity: "cafe", opening_hours: ""}},
        {...park, center: {lat: 91, lon: 0}}, {type: "node", id: 125, tags: {amenity: "cafe"}}]});
    });
    const result = await geo.poi({alongTrack: normalizeTrack([[{lat: 0, lon: 0}]]), tags: query.tags, radiusM: 100});
    expect(result.value).toHaveLength(1);
    expect(result.value![0]).toMatchObject({point: {lat: 0, lon: 0}, distance: {value: 0}, openingHours: {value: null}});
    expect(result).toMatchObject({status: "partial", counts: {input: 3, retained: 1, omitted: 2}, query: {sections: 1, points: 1}});
    expect(bodies[0]).toContain("(around:100,0,0)");
  });

  test("responses beyond the sentinel fail distinctly without becoming cached matches", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return Response.json({elements: Array.from({length: 1_002}, (_, i) => ({...cafe, id: i + 1}))});});
    expect(await geo.poi(query)).toMatchObject({value: null, error: {code: "response_limit"}});
    expect(await geo.poi(query)).toMatchObject({value: null, error: {code: "response_limit"}});
    expect(count).toBe(4);
  });
});
