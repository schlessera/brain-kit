import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distanceM, parseGpx, quantizeRoute, routeMetrics, routePoint, trimRoute, writeGpx } from "../src/route-gpx.js";
import { parseKomoot } from "../src/route.js";

const source = readFileSync(join(import.meta.dir, "fixtures/routes/odysseus.gpx"), "utf8");
const geometry = parseGpx(source);
const p = (lon: number, elevation = 0, time: string | null = null) => routePoint(0, lon, elevation, time);
const gpx = (body: string) => `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">${body}</gpx>`;

describe("route parsing and metrics", () => {
  test("normalized GPX round trips the nonempty geometry and ignores source metadata", () => {
    expect(geometry.segments[0]).toHaveLength(4);
    const normalized = writeGpx(quantizeRoute(geometry.segments));
    expect(parseGpx(normalized).segments).toEqual(geometry.segments);
    expect(normalized).not.toContain("Odysseus navigation exercise");
    expect(normalized).not.toContain("Departure to be trimmed");
    expect(normalized).not.toContain("<extensions");
  });

  test("rejects malformed XML, unsupported versions and doctypes instead of accepting partial geometry", () => {
    for (const bad of [source.replace("</trkseg>", ""), source.replace('version="1.1" creator', 'version="2.0" creator'),
      '<!DOCTYPE gpx [<!ENTITY departure "0">]>' + source.replace('lat="0"', 'lat="&departure;"'), source + "<gpx/>",
      source.replace('encoding="UTF-8"', 'encoding="UTF-16"')]) expect(() => parseGpx(bad)).toThrow();
  });

  test("invalid coordinates fail while invalid or missing optional data stays unknown", () => {
    for (const lat of ["91", "Infinity", "", "null"]) {
      const invalid = source.replace('<trkpt lat="0" lon="0">', `<trkpt lat="${lat}" lon="0">`);
      expect(invalid).toContain(`<trkpt lat="${lat}"`);
      expect(() => parseGpx(invalid)).toThrow(/coordinates/);
    }
    const missing = parseGpx(source.replace("<ele>110</ele>", "").replace("<time>2026-07-15T00:01:00Z</time>", ""));
    expect(routeMetrics(missing.segments)).toMatchObject({ ascent_m: null, altitude_min_m: null, altitude_max_m: null, recorded_duration_s: null });
    const invalid = parseGpx(source.replace("<ele>110</ele>", "<ele>NaN</ele>").replace("2026-07-15T00:01:00Z", "2026-02-30T00:01:00Z"));
    expect(invalid.warnings).toHaveLength(2);
    expect(invalid.segments[0]![1]).toMatchObject({ elevation_m: null, time: null });
  });

  test("only correctly namespaced direct geometry is read; tracks take precedence over routes", () => {
    const spoof = '<extensions xmlns:x="urn:fixture"><x:trk><x:trkseg><x:trkpt lat="91" lon="0"/></x:trkseg></x:trk></extensions>';
    const route = '<rte><rtept lat="1" lon="1"/><rtept lat="1" lon="1.01"/></rte>';
    const parsed = parseGpx(source.replace("<trk>", spoof + route + "<trk>"));
    expect(parsed.segments).toEqual(geometry.segments);
    const routeOnly = parseGpx(gpx(route));
    expect(routeOnly.segments[0]).toHaveLength(2);
    expect(routeOnly.segments[0]![0]!.lat).toBe(1);
    const prefixed = source.replaceAll("<gpx ", "<g:gpx ").replaceAll("</gpx>", "</g:gpx>")
      .replace('xmlns="', 'xmlns:g="').replaceAll(/<(\/?)(trk|trkseg|trkpt|ele|time)(?=[\s>])/g, "<$1g:$2");
    expect(parseGpx(prefixed).segments).toEqual(geometry.segments);
  });

  test("segment gaps are not counted as distance, ascent or duration", () => {
    const segments = [[p(0, 0, "2026-07-15T00:00:00Z"), p(0.001, 10, "2026-07-15T00:01:00Z")],
      [p(1, 100, "2026-07-15T01:00:00Z"), p(1.001, 110, "2026-07-15T01:01:00Z")]];
    expect(routeMetrics(segments)).toMatchObject({ distance_km: 0.22239, ascent_m: 20, recorded_duration_s: 120, shape: "unknown", segments: 2 });
  });

  test("non-monotonic recording timestamps never become a fabricated duration", () => {
    const broken = parseGpx(source.replace("00:02:00Z", "00:00:30Z"));
    expect(broken.segments[0]).toHaveLength(4);
    expect(broken.segments[0]!.every((p) => p.time !== null)).toBe(true);
    expect(broken.segments[0]![2]!.time).toBe("2026-07-15T00:00:30.000Z");
    expect(routeMetrics(broken.segments).recorded_duration_s).toBeNull();
  });

  test("median and three-metre hysteresis smooth small elevation jitter", () => {
    const flat = [[p(0, 100), p(0.001, 101), p(0.002, 100), p(0.003, 101), p(0.004, 100)]];
    expect(routeMetrics(flat).ascent_m).toBe(0);
    expect(routeMetrics(geometry.segments).ascent_m).toBe(20);
    expect(routeMetrics([[p(0, -20), p(0.001, -10)]]).ascent_m).toBe(10);
  });

  test("closure uses both a thirty-metre cap and five percent of distance", () => {
    expect(routeMetrics([[p(0), p(0.0001)]]).shape).toBe("one_way");
    expect(routeMetrics([[p(0), p(0.001), p(0)]]).shape).toBe("loop");
  });

  test("zero and absent elevation remain distinct, including GPX 1.0 routes", () => {
    const route = '<rte><rtept lat="0" lon="0"><ele>0</ele></rtept><rtept lat="0" lon="0.001"><ele>0</ele></rtept></rte>';
    const parsed = parseGpx(gpx(route).replaceAll("1/1", "1/0").replace('version="1.1"', 'version="1.0"'));
    expect(routeMetrics(parsed.segments)).toMatchObject({ ascent_m: 0, altitude_min_m: 0, altitude_max_m: 0 });
    expect(routeMetrics(parseGpx(gpx(route.replaceAll("<ele>0</ele>", ""))).segments).altitude_min_m).toBeNull();
  });

  test("Komoot payloads use geometry, refuse private or mismatched routes, and never evaluate scripts", () => {
    const data = { page: { _embedded: { tour: { id: "42", status: "public", distance: 999999,
      _embedded: { coordinates: { items: [{ lat: 0, lng: 0, alt: 0, t: 0 }, { lat: 0, lng: 0.001, alt: 10, t: 999999 }] } } } } } };
    const html = (state: unknown) => `<script>throw new Error("must not execute"); kmtBoot.setProps(${JSON.stringify(JSON.stringify(state))});</script>`;
    const parsed = parseKomoot(html(data), "42");
    expect(parsed.segments[0]).toHaveLength(2);
    expect(routeMetrics(parsed.segments)).toMatchObject({ distance_km: 0.111195, ascent_m: 10, recorded_duration_s: null });
    expect(() => parseKomoot(html(data), "43")).toThrow(/matching/);
    data.page._embedded.tour.status = "private";
    expect(() => parseKomoot(html(data), "42")).toThrow(/not public/);
    expect(() => parseKomoot('<script>kmtBoot.setProps("not JSON");</script>', "42")).toThrow(/Malformed/);
  });
});

describe("along-track privacy trimming", () => {
  test("cuts both ends on edges and recomputes metrics from the serialized retained track", () => {
    const retained = quantizeRoute(trimRoute(geometry.segments, 100, 100));
    const written = writeGpx(retained), reread = parseGpx(written);
    expect(reread.segments).toEqual(retained);
    expect(routeMetrics(reread.segments).distance_km).toBeCloseTo(0.133585, 6);
    expect(written).not.toContain('lon="0"');
    expect(written).not.toContain('lon="0.003"');
    expect(written).toContain('minlon="0.00089932"');
    expect(written).toContain('maxlon="0.00210068"');
    expect(geometry.segments[0]![0]!.lon).toBe(0);
  });

  test("trimming a full first segment does not retain its boundary or bridge the following gap", () => {
    const first = [p(0), p(0.001)], second = [p(1), p(1.002)];
    const trimmed = trimRoute([first, second], distanceM(first[0]!, first[1]!), 0);
    expect(trimmed).toEqual([second]);
    expect(routeMetrics(trimmed).distance_km).toBeCloseTo(0.22239, 6);
  });

  test("great-circle cuts cross the antimeridian without taking a path through longitude zero", () => {
    const segment = [p(179.999), p(-179.999)];
    const original = distanceM(segment[0]!, segment[1]!);
    const retained = quantizeRoute(trimRoute([segment], original / 4, original / 4));
    expect(retained[0]![0]!.lon).toBeCloseTo(179.9995, 7);
    expect(retained[0]![1]!.lon).toBeCloseTo(-179.9995, 7);
    expect(routeMetrics(retained).distance_km).toBeCloseTo(original / 2000, 6);
  });

  test("serialized cuts stay within one centimetre along the documented sphere", () => {
    const segment = [routePoint(38.35, 20.71, 10), routePoint(38.36, 20.73, 40), routePoint(38.37, 20.72, 20)];
    const original = routeMetrics([segment]).distance_km * 1000;
    for (const start of [0.001, 17.123, 1500]) {
      const end = 97.321, saved = parseGpx(writeGpx(quantizeRoute(trimRoute([segment], start, end))));
      expect(saved.segments[0]!.length).toBeGreaterThan(1);
      expect(Math.abs(distanceM(segment[0]!, saved.segments[0]![0]!) - start)).toBeLessThan(0.01);
      expect(Math.abs(distanceM(segment[2]!, saved.segments[0]!.at(-1)!) - end)).toBeLessThan(0.01);
      expect(Math.abs(routeMetrics(saved.segments).distance_km * 1000 - (original - start - end))).toBeLessThan(0.01);
    }
  });

  test("missing optional data can disappear with the trimmed segment but never gets interpolated from unknown values", () => {
    const segments = [[routePoint(0, 0), routePoint(0, 0.001)], geometry.segments[0]!];
    expect(routeMetrics(segments).ascent_m).toBeNull();
    const firstLength = distanceM(segments[0]![0]!, segments[0]![1]!);
    expect(routeMetrics(trimRoute(segments, firstLength, 0)).ascent_m).toBe(20);
    const absent = parseGpx(source.replace("<ele>100</ele>", "").replace("<time>2026-07-15T00:00:00Z</time>", ""));
    const cut = trimRoute(absent.segments, 50, 0);
    expect(cut[0]![0]).toMatchObject({ elevation_m: null, time: null });
  });

  test("duplicates are harmless, while over-trimming and invalid distances refuse", () => {
    const original = geometry.segments[0]!;
    expect(routeMetrics(trimRoute([[original[0]!, original[0]!, ...original.slice(1)]], 10, 10)).distance_km).toBeCloseTo(0.313585, 6);
    for (const start of [-1, NaN, Infinity, 400]) expect(() => trimRoute(geometry.segments, start, 0)).toThrow();
    expect(() => trimRoute(geometry.segments, 200, 200)).toThrow(/entire/);
    expect(() => trimRoute([[p(0), p(0)]], 0, 0)).toThrow(/positive/);
  });
});
