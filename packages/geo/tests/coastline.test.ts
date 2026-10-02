import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, prepareLand, type CoastlineRequest, type Coord } from "../src/coastline.js";
import { GeoClient } from "../src/server/client.js";
import { fetchCoastline } from "../src/server/coastline.js";
import { prepare as sdkPrepare, prepareLand as sdkPrepareLand, fetchCoastline as sdkFetch } from "../../ui-sdk/src/server/coastline.js";
import type { GeoConfigInput } from "../src/config.js";
import type { GeoRuntimeOptions } from "../src/server/io.js";

const roots: string[] = [];
afterEach(async () => {for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});});
const endpoint = "https://coast.example.invalid/api/interpreter";
const request: CoastlineRequest = {bbox: [15.6, 38.2, 15.8, 38.32], widthPx: 330, detail: "streets"};
const coastline: Coord[][] = [[[15.62, 38.21], [15.65, 38.24], [15.7, 38.3]]];
const ways = (lines = coastline) => ({elements: lines.map(line => ({type: "way", geometry: line.map(([lon, lat]) => ({lat, lon}))}))});
async function setup(fetchImpl: GeoRuntimeOptions["fetchImpl"], extra: GeoConfigInput = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-geo-coast-")); roots.push(root);
  const config: GeoConfigInput = {userAgent: "brain-geo-fixture/1.0", cacheDir: root, minimumIntervalMs: 0,
    overpass: {enabled: true, endpoints: [endpoint]}, ...extra};
  const runtime = {fetchImpl, admissionDir: join(root, "admission")};
  return {config, runtime, geo: new GeoClient(config, runtime)};
}

describe("shared coastline client and SDK compatibility", () => {
  test("the SDK exports the actual shared implementation and every layer retains fetch/cache evidence", async () => {
    expect(sdkPrepare).toBe(prepare); expect(sdkPrepareLand).toBe(prepareLand); expect(sdkFetch).toBe(fetchCoastline);
    const bodies: string[] = [];
    const {geo, config, runtime} = await setup(async (_url, init) => {bodies.push(new URLSearchParams(String(init.body)).get("data")!); return Response.json(ways());});
    const result = await geo.coastline(request);
    expect(result.value!.coastline).toHaveLength(1); expect(result.value!.roads).toHaveLength(1); expect(result.value!.streets).toHaveLength(1);
    expect(result.value!.coastline).toEqual(prepare(coastline, request));
    expect(result.queries.map(q => q.layer)).toEqual(["coastline", "roads", "streets"]);
    expect(result.queries.map(q => q.result.source!.transfer.sent)).toEqual([true, true, true]);
    expect(bodies).toHaveLength(3); expect(bodies[0]).toContain("38.20000,15.60000,38.32000,15.80000");
    const cached = await new GeoClient(config, runtime).coastline(request);
    expect(cached.value!.coastline).toHaveLength(1);
    expect(cached.queries.map(q => q.result.source!.fromCache)).toEqual([true, true, true]);
    expect(cached.queries.map(q => q.result.source!.transfer.sent)).toEqual([false, false, false]);
    expect(cached.queries[0]!.result.source!.fetchedAt).toBe(result.queries[0]!.result.source!.fetchedAt);
    expect(bodies).toHaveLength(3);
  });

  test("the legacy wrapper keeps its exact geometry shape and canonical endpoint/cache settings", async () => {
    const urls: string[] = [];
    const {geo, config, runtime} = await setup(async url => {urls.push(url); return Response.json(ways());});
    const result = await geo.coastline({...request, detail: "coast"});
    const legacy = await sdkFetch({...request, detail: "coast"}, {enabled: true, url: "https://unused.example.invalid", userAgent: "unused",
      geo: config, fetchImpl: runtime.fetchImpl, admissionDir: runtime.admissionDir});
    expect(legacy.coastline).toHaveLength(1);
    expect(legacy).toEqual(result.value!);
    expect(Object.keys(legacy).sort()).toEqual(["attribution", "coastline", "detail", "land", "partial", "roads", "streets", "toleranceM"]);
    expect(urls).toEqual([endpoint]);
    const disabled = await sdkFetch(request, {enabled: false, url: endpoint, userAgent: "unused", geo: config, fetchImpl: runtime.fetchImpl});
    expect(disabled).toMatchObject({coastline: [], roads: [], streets: [], land: [], detail: "coast", partial: false, toleranceM: 0});
    expect(urls).toEqual([endpoint]);
  });

  test("a genuine failed layer retains good coastline and permits later layers without a fabricated complete result", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return count === 2 ? new Response("down", {status: 503}) : Response.json(ways());});
    const result = await geo.coastline(request);
    expect(result.value!.coastline).toHaveLength(1); expect(result.value!.streets).toHaveLength(1);
    expect(result.value!.roads).toEqual([]);
    expect(result).toMatchObject({status: "partial", value: {partial: true}, error: null});
    expect(result.queries[1]!.result.error).toMatchObject({code: "http", httpStatus: 503});
    expect(count).toBe(3);
  });

  test("admission denial stops all later layers and retains earlier geometry with its own source", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return count === 1 ? Response.json(ways()) : new Response("resource refusal", {status: 504});});
    const result = await geo.coastline(request);
    expect(count).toBe(2);
    expect(result.value!.coastline).toHaveLength(1);
    expect(result).toMatchObject({status: "partial", value: {roads: [], streets: [], partial: true}});
    expect(result.queries.map(q => q.layer)).toEqual(["coastline", "roads"]);
    expect(result.queries[1]!.result.error).toMatchObject({code: "admission_denied"});
    expect(result.source!.fetchedAt).toBe(result.queries[0]!.result.source!.fetchedAt);
  });

  test("JSON resource refusal stops layers and repeats, while mixed malformed ways remain partial", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return Response.json({elements: [], remark: "runtime error: Query run out of memory"});});
    expect(await geo.coastline(request)).toMatchObject({value: null, error: {code: "admission_denied"}});
    expect(count).toBe(1);
    expect(await geo.coastline(request)).toMatchObject({value: null, error: {code: "admission_denied"}});
    expect(count).toBe(1);
    const {geo: partial} = await setup(async () => Response.json({elements: [...ways().elements, {type: "way", geometry: [{lat: 91, lon: 0}, {lat: 0, lon: 0}]}]}));
    const result = await partial.coastline({...request, detail: "coast"});
    expect(result.value!.coastline).toHaveLength(1);
    expect(result).toMatchObject({status: "partial", value: {partial: true}});
    expect(result.queries[0]!.result.counts).toEqual({input: 2, retained: 1, omitted: 1});
  });

  test("wide or invalid background requests never dispatch and do not alter the original bounds", async () => {
    let count = 0;
    const {geo} = await setup(async () => {count++; return Response.json(ways());});
    const wide: CoastlineRequest = {bbox: [0, 0, 6, 1], widthPx: 330}, original = JSON.stringify(wide);
    expect(await geo.coastline(wide)).toMatchObject({value: null, error: {code: "input"}});
    expect(await geo.coastline({bbox: [0, -91, 1, 1], widthPx: 330})).toMatchObject({error: {code: "input"}});
    expect(await geo.coastline({...request, widthPx: 0})).toMatchObject({error: {code: "input"}});
    expect(count).toBe(0); expect(JSON.stringify(wide)).toBe(original);
  });

  test("all malformed geometry is an error and the legacy wrapper still returns empty partial paths", async () => {
    const {geo, config, runtime} = await setup(async () => Response.json({elements: [{type: "way", geometry: [{lat: 91, lon: 0}, {lat: 0, lon: 0}]}]}));
    expect(await geo.coastline({...request, detail: "coast"})).toMatchObject({value: null, error: {code: "bad_response"}});
    expect(await fetchCoastline({...request, detail: "coast"}, {enabled: true, url: endpoint, userAgent: "brain-geo-fixture/1.0", geo: config,
      fetchImpl: runtime.fetchImpl, admissionDir: runtime.admissionDir})).toMatchObject({coastline: [], land: [], partial: true});
  });

  test("way and vertex limits count malformed entries without accepting or caching oversized geometry", async () => {
    for (const elements of [Array.from({length: 10_001}, () => ways().elements[0]!),
      [{type: "way", geometry: Array.from({length: 200_001}, () => ({lat: 0, lon: 0}))}],
      [{type: "way", geometry: Array.from({length: 200_001}, () => ({lat: 91, lon: 0}))}]]) {
      const {geo} = await setup(async () => Response.json({elements}));
      expect(await geo.coastline({...request, detail: "coast"})).toMatchObject({value: null, error: {code: "response_limit"}});
    }
  });

  test("malformed vertex structures count toward the limit before response validation", async () => {
    const {geo} = await setup(async () => Response.json({elements: [{type: "way",
      geometry: Array.from({length: 200_001}, () => ({lat: 0, lon: "invalid"}))}]}));
    expect(await geo.coastline({...request, detail: "coast"})).toMatchObject({value: null, error: {code: "response_limit"}});
  });
});
