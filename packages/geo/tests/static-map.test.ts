import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { normalizeTrack, parseTrackGpx, routePoint, type ParsedTrack } from "../src/track.js";
import { GeoClient } from "../src/server/client.js";
import { mapViewport } from "../src/server/map-svg.js";
import type { GeoConfigInput } from "../src/config.js";
import type { GeoRuntimeOptions } from "../src/server/io.js";
import type { StaticMapInput } from "../src/server/static-map.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bbox: [number, number, number, number] = [15.6, 38.2, 15.8, 38.32];
const line = normalizeTrack([[{ lat: 38.23, lon: 15.63 }, { lat: 38.25, lon: 15.68 }, { lat: 38.28, lon: 15.73 }]]);
const track = { track: line, source: { kind: "file" as const, path: "routes/harbour.gpx" }, label: "Harbour walk" };
const input: StaticMapInput = { title: "Harbour walk and stops", tracks: [track], widthPx: 768, bbox,
  pins: [{ lat: 38.23, lon: 15.63, label: "Harbour" }, { lat: 38.28, lon: 15.73, label: "Viewpoint" }] };
const ways = { elements: [{ type: "way", geometry: [{ lat: 38.21, lon: 15.61 }, { lat: 38.21, lon: 15.77 },
  { lat: 38.30, lon: 15.77 }, { lat: 38.30, lon: 15.61 }, { lat: 38.21, lon: 15.61 }] }] };
async function setup(fetchImpl: GeoRuntimeOptions["fetchImpl"] = async () => Response.json(ways), extra: GeoConfigInput = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-static-map-")); roots.push(root);
  const config: GeoConfigInput = { userAgent: "brain-static-map-fixture/1.0", cacheDir: root, minimumIntervalMs: 0,
    overpass: { enabled: true, endpoints: ["https://map.example.invalid/api/interpreter"] }, ...extra };
  return { root, geo: new GeoClient(config, { fetchImpl, admissionDir: join(root, "admission") }) };
}
async function pixels(png: Uint8Array) {
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("deterministic vector static maps", () => {
  test("fixed concrete geometry/tracks/pins produce identical real PNGs with local glyphs and visible source/attribution", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json(ways); });
    const background = await geo.coastline({ bbox, widthPx: 768, detail: "coast" });
    expect(background.value!.coastline.length).toBeGreaterThan(0);
    const original = JSON.stringify({ ...input, background });
    const first = await geo.staticMap({ ...input, background }), second = await geo.staticMap({ ...input, background });
    expect(first.kind).toBe("geometry"); expect(first.png!.byteLength).toBeGreaterThan(10_000);
    expect(first.png).toEqual(second.png);
    expect(await sharp(first.png!).metadata()).toMatchObject({ format: "png", width: 768, height: first.heightPx });
    expect(first.text).toContain("© OpenStreetMap contributors (ODbL)");
    expect(first.text).toContain("Background layer coastline: ok");
    expect(first.svg).toContain('aria-label="Stop 2: Viewpoint');
    expect(first.svg).not.toMatch(/<(?:image|text|script)\b|\bhref=/);
    expect(first.svg).toContain('fill-rule="evenodd"');
    expect(requests).toBe(1); expect(JSON.stringify({ ...input, background })).toBe(original);
  });

  test("recovered sections leave a real white pixel gap, exact omissions and an unchanged original file", async () => {
    const { root, geo } = await setup();
    const source = '<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0.001"/><trkpt lat="0" lon="0.002"/><trkpt lat="95" lon="0.004"/><trkpt lat="0" lon="0.006"/><trkpt lat="0" lon="0.007"/></trkseg></trk></gpx>';
    const file = join(root, "original.gpx"); await writeFile(file, source);
    const recovered = parseTrackGpx(source);
    const result = await geo.staticMap({ tracks: [{ track: recovered, source: { kind: "file", path: "original.gpx" } }],
      bbox: [0, -0.002, 0.008, 0.002], widthPx: 768, background: "none" });
    const frameY = Number(/<clipPath id="map-frame"><rect x="24" y="([\d.]+)"/.exec(result.svg!)![1]);
    const [x, y] = mapViewport(result.bounds!, 768, frameY).point({ lat: 0, lon: 0.004 });
    const image = await pixels(result.png!), offset = (Math.round(y) * image.info.width + Math.round(x)) * 4;
    // First assertion for gap mutations: it observes the encoded PNG, before path/count assertions can mask it.
    expect([...image.data.subarray(offset, offset + 4)]).toEqual([255, 255, 255, 255]);
    expect(result.svg!.match(/id="track-1-section-\d+"/g)).toHaveLength(2);
    expect(result.tracks[0]!.summary.counts).toEqual({ input: 5, retained: 4, omitted: 1, segments: 2 });
    expect(result.tracks[0]!.omissions).toEqual(recovered.omissions);
    expect(result.text).toContain("Point 3: latitude out of range");
    expect(result.status).toBe("partial");
    expect(await readFile(file, "utf8")).toBe(source);
  });

  test("a projectable track wider than five degrees becomes track-only without a background query", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json(ways); });
    const wide = normalizeTrack([[{ lat: 30, lon: 0 }, { lat: 31, lon: 6 }]]);
    const result = await geo.staticMap({ tracks: [{ track: wide, source: { kind: "file", path: "wide.gpx" } }] });
    expect(requests).toBe(0);
    expect(result).toMatchObject({ kind: "track_only", reason: "background_extent", status: "partial" });
    expect(result.png!.byteLength).toBeGreaterThan(10_000);
    expect(result.tracks[0]!.summary.geometry[0]![1]!.lon).toBe(6);
    expect(result.method.scale!.value).toBeGreaterThan(0);
    expect(result.text).toContain("Track-only"); expect(result.text).toContain("wide.gpx");
    expect(result.attribution).toEqual([]);
  });

  test("polar and date-line coordinates stay valid source evidence with a clear unsupported drawing outcome", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json(ways); });
    for (const section of [[{ lat: 90, lon: 0 }, { lat: 89, lon: 1 }], [{ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }]]) {
      const parsed = normalizeTrack([section]), original = JSON.stringify(parsed);
      const result = await geo.staticMap({ tracks: [{ track: parsed, source: { kind: "file", path: "unsupported.gpx" } }],
        pins: [{ ...section[0]!, label: "Source stop" }] });
      expect(requests).toBe(0);
      expect(result).toMatchObject({ kind: "none", reason: "unsupported_projection", png: null, status: "no_map" });
      expect(result.tracks[0]!.summary.geometry[0]!.map(p => ({ lat: p.lat, lon: p.lon }))).toEqual(section);
      expect(result.text).toContain("This projection cannot display the source coordinates"); expect(result.text).toContain("Source stop");
      expect(result.pins[0]).toMatchObject({ drawn: false, reason: "no_artifact" });
      expect(JSON.stringify(parsed)).toBe(original);
    }
  });

  test("unavailable background yields an actual plain PNG with usable track evidence and no OSM-background claim", async () => {
    const { geo } = await setup(async () => new Response("unavailable", { status: 503 }));
    const result = await geo.staticMap(input);
    expect(result).toMatchObject({ kind: "track_only", reason: "background_unavailable", status: "partial" });
    expect(result.png!.byteLength).toBeGreaterThan(10_000);
    expect(result.background!.queries[0]!.result.error!.code).toBe("http");
    expect(result.tracks[0]!.summary.measurements.distance.value).toBeGreaterThan(1);
    expect(result.text).toContain("no complete background is claimed"); expect(result.attribution).toEqual([]);
  });

  test("absent routes retain every requested stop/leg and cropped stop with no fabricated line", async () => {
    const geo = new GeoClient();
    const route = await geo.route([{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0, lon: 0.3 }], "foot");
    const result = await geo.staticMap({ routes: [route], bbox: [-0.001, -0.001, 0.002, 0.001], background: "none" });
    expect(result.pins).toHaveLength(3); expect(result.legs).toHaveLength(2);
    expect(result.pins[2]).toMatchObject({ index: 3, drawn: false, reason: "outside_viewport" });
    expect(result.legs.map(leg => leg.available)).toEqual([false, false]);
    expect(result.text).toContain("Route 1 stop 3: 0, 0.3");
    expect(result.text).toContain("Route 1 leg 2: 0, 0.001 to 0, 0.3; route unavailable");
    expect(result.svg).not.toContain('id="route-1-section-1"');
    expect(result.png!.byteLength).toBeGreaterThan(10_000);
  });

  test("calculated routes retain actual dataset/zero estimates and draw numbered stops with no second route request", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json({ code: "Ok",
      routes: [{ geometry: { type: "LineString", coordinates: [[15.63, 38.23], [15.73, 38.28]] }, distance: 0, duration: 0, legs: [{ distance: 0, duration: 0 }] }],
      waypoints: [{ location: [15.63, 38.23], name: "Harbour", distance: 0 }, { location: [15.73, 38.28], name: "Viewpoint", distance: 0 }] }); },
    { routing: { endpoints: { foot: { url: "https://map.example.invalid/route/v1", profile: "foot", preparedMode: "foot", dataset: "fixture walking", verification: "fixture prepared mode" } } } });
    const route = await geo.route([{ lat: 38.23, lon: 15.63 }, { lat: 38.28, lon: 15.73 }], "foot");
    expect(route.value).not.toBeNull();
    const result = await geo.staticMap({ routes: [route], background: "none" });
    expect(requests).toBe(1); expect(result.pins).toHaveLength(2);
    expect(result.legs[0]).toMatchObject({ available: true, distanceM: 0, durationS: 0 });
    expect(result.text).toContain("dataset fixture walking"); expect(result.text).toContain("distance 0 m; duration 0 s");
    expect(result.svg).toContain('id="route-1-section-1"'); expect(result.svg).toContain('stroke-dasharray="8 4"');
    expect(result.attribution[0]!.text).toContain("OpenStreetMap");
  });

  test("zero coordinates/repeated points and singleton no-line evidence remain drawable without fabricated measurements", async () => {
    const geo = new GeoClient();
    for (const section of [[{ lat: 0, lon: 0 }], [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }]]) {
      const result = await geo.staticMap({ tracks: [{ track: normalizeTrack([section]), source: { kind: "file", path: "zero.gpx" } }], background: "none" });
      expect(result.png!.byteLength).toBeGreaterThan(1_000);
      expect(result.tracks[0]!.summary.measurements.distance.value).toBe(section.length === 1 ? null : 0);
      expect(result.tracks[0]!.summary.geometry[0]).toHaveLength(section.length);
      if (section.length === 1) expect(result.svg).toContain('id="track-1-section-1-point"');
    }
  });

  test("an oversized legend preserves the last complete stop and gives a text fallback rather than truncating the PNG", async () => {
    const pins = Array.from({ length: 1_000 }, (_, index) => ({ lat: 0, lon: 0, label: `${index + 1} ${"long stop ".repeat(99)}` }));
    const result = await new GeoClient().staticMap({ pins, background: "none" });
    expect(result.png).toBeNull();
    expect(result).toMatchObject({ kind: "none", reason: "render_budget", png: null });
    expect(result.pins).toHaveLength(1_000); expect(result.text).toContain(`Stop 1000: ${pins[999]!.label}`);
    expect(result.pins.every(pin => !pin.drawn)).toBe(true);
  });

  test("unsupported font glyphs preserve full text instead of producing a blank or missing stop label", async () => {
    const result = await new GeoClient().staticMap({ pins: [{ lat: 0, lon: 0, label: "Source \u{10ffff}" }], background: "none" });
    expect(result).toMatchObject({ kind: "none", reason: "unsupported_text", png: null });
    expect(result.text).toContain("Source \u{10ffff}");
  });

  test("projection has the analytic equatorial center/isotropic scale and reports its latitude assumption", () => {
    const viewport = mapViewport([-1, -1, 1, 1], 1_000, 0);
    expect(viewport.point({ lat: 0, lon: 0 })).toEqual([500, 280]);
    const x = viewport.point({ lat: 0, lon: 1 })[0] - 500, y = 280 - viewport.point({ lat: 1, lon: 0 })[1];
    expect(y / x).toBeCloseTo(1.00005, 5);
    expect(viewport.scale.latitude).toBeCloseTo(0, 9);
    expect(viewport.scale.value / viewport.scale.lengthPx).toBeCloseTo((Math.PI * 6_371_008.8 / 180) / x, 3);
  });

  test("OSM-derived FOSSGIS graphics visibly retain the operator's graphics license and terms", async () => {
    const { geo } = await setup();
    const background = await geo.coastline({ bbox, widthPx: 768, detail: "coast" });
    background.attribution.push({ text: "FOSSGIS service terms", url: "https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/" });
    const result = await geo.staticMap({ ...input, background });
    expect(result.png!.byteLength).toBeGreaterThan(10_000);
    expect(result.text).toContain("Graphics: CC BY-SA (FOSSGIS service terms)");
    expect(result.svg).toContain('aria-label="Graphics: CC BY-SA');
    expect(result.attribution).toContainEqual({ text: "Graphics: CC BY-SA (FOSSGIS service terms)", url: "https://creativecommons.org/licenses/by-sa/2.0/" });
  });

  test("prefetched partial geometry stays partial, while empty paths cannot claim a usable OSM background", async () => {
    const { geo } = await setup();
    const background = await geo.coastline({ bbox, widthPx: 768, detail: "coast" });
    expect(background.value!.coastline[0]!.length).toBeGreaterThan(1);
    background.status = "partial";
    const partial = await geo.staticMap({ ...input, background });
    expect(partial.status).toBe("partial"); expect(partial.kind).toBe("geometry");
    expect(partial.png!.byteLength).toBeGreaterThan(10_000);
    background.value = { ...background.value!, coastline: [[]], roads: [], streets: [], land: [] };
    const empty = await geo.staticMap({ ...input, background });
    expect(empty.kind).toBe("track_only"); expect(empty.attribution).toEqual([]);
    expect(empty.text).toContain("Background geometry is unavailable");
    expect(empty.png!.byteLength).toBeGreaterThan(10_000);
  });

  test("missing spatial evidence and malformed/oversized prefetched background fail clearly without dispatch", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json(ways); });
    expect(await geo.staticMap({ tracks: [{ track: normalizeTrack([]), source: { kind: "file", path: "empty.gpx" } }] }))
      .toMatchObject({ kind: "none", reason: "no_spatial_input", png: null });
    expect(requests).toBe(0);
    const background = await geo.coastline({ bbox, widthPx: 768, detail: "coast" });
    background.value!.coastline = Array.from({ length: 10_001 }, () => []);
    await expect(geo.staticMap({ ...input, background })).rejects.toThrow("geometry budget");
    background.value!.coastline = [[[0, 91]]];
    await expect(geo.staticMap({ ...input, background })).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("resource guards reject excessive retained geometry before dispatch and preserve the accepted maximum", async () => {
    let requests = 0;
    const { geo } = await setup(async () => { requests++; return Response.json(ways); });
    const oversized: ParsedTrack = { ...line, segments: [Array.from({ length: 200_001 }, () => routePoint(90, 0))],
      counts: { input: 200_001, retained: 200_001, omitted: 0, segments: 1 } };
    expect(oversized.segments[0]!.length).toBe(oversized.counts.retained);
    await expect(geo.staticMap({ tracks: [{ track: oversized, source: { kind: "file", path: "oversized.gpx" } }] })).rejects.toThrow("200000");
    expect(requests).toBe(0);
    const maximum = normalizeTrack([Array.from({ length: 200_000 }, () => ({ lat: 90, lon: 0 }))]);
    const result = await geo.staticMap({ tracks: [{ track: maximum, source: { kind: "file", path: "maximum.gpx" } }] });
    expect(result.reason).toBe("unsupported_projection"); expect(result.tracks[0]!.summary.counts.retained).toBe(200_000);
    expect(requests).toBe(0);
  });
});
