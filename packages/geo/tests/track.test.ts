import { describe, expect, test } from "bun:test";
import { parseGpx, parseTrackGpx, routeMetrics } from "../src/track.js";

const pt = (lat: string, lon: string, extra = "") => `<trkpt lat="${lat}" lon="${lon}">${extra}</trkpt>`;
const gpx = (segments: string[]) => `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk>${segments.map(s => `<trkseg>${s}</trkseg>`).join("")}</trk></gpx>`;
const recover = (source: string): unknown => {
  try { return parseTrackGpx(source); } catch { return { status: "error" }; }
};

describe("shared GPX recovery", () => {
  test("an invalid coordinate splits two usable sections and reports the omission", () => {
    const source = gpx([pt("0", "0") + pt("0", "0.001") + pt("91", "0") + pt("0", "1") + pt("0", "1.001")]);
    const result = recover(source);
    expect(result).toMatchObject({ status: "partial", partial: true,
      counts: { input: 5, retained: 4, omitted: 1, segments: 2 },
      omissions: [{ index: 2, reason: "latitude_out_of_range" }] });
    const parsed = result as ReturnType<typeof parseTrackGpx>;
    expect(parsed.segments.map(s => s.length)).toEqual([2, 2]);
    expect(routeMetrics(parsed.segments).distance_km).toBeCloseTo(0.22239, 6);
    expect(() => parseGpx(source)).toThrow(/coordinates/);
  });

  test("recovery never bridges omission gaps", () => {
    const parsed = parseTrackGpx(gpx([pt("0", "0") + pt("0", "0.001") + pt("91", "0") + pt("0", "1") + pt("0", "1.001")]));
    expect(parsed.segments.map(s => s.map(p => p.lon))).toEqual([[0, 0.001], [1, 1.001]]);
    expect(routeMetrics(parsed.segments).distance_km).toBeCloseTo(0.22239, 6);
  });

  test("strict travel entry point still rejects invalid coordinates", () => {
    const source = gpx([pt("0", "0") + pt("91", "0") + pt("0", "0.001")]);
    expect(() => parseGpx(source)).toThrow(/coordinates/);
  });

  test("recovering geometry does not bridge elapsed or elevation measurements", () => {
    const meta = (e: number, t: string) => `<ele>${e}</ele><time>2026-07-12T${t}Z</time>`;
    const parsed = parseTrackGpx(gpx([pt("0", "0", meta(100, "00:00:00")) + pt("0", "0.001", meta(110, "00:01:00"))
      + pt("91", "0") + pt("0", "1", meta(1000, "01:00:00")) + pt("0", "1.001", meta(1010, "01:01:00"))]));
    expect(routeMetrics(parsed.segments)).toMatchObject({ ascent_m: 20, recorded_duration_s: 120, shape: "unknown" });
    expect(parsed.partial).toBe(true);
  });

  test("valid isolated points remain available as evidence without a drawable line", () => {
    const parsed = parseTrackGpx(gpx([pt("0", "0") + pt("91", "0") + pt("90", "180")]));
    expect(parsed.segments.map(s => s.map(p => [p.lat, p.lon]))).toEqual([[[0, 0]], [[90, 180]]]);
    expect(parsed).toMatchObject({ status: "no_line", counts: { input: 3, retained: 2, omitted: 1, segments: 2 } });
  });

  test("recovery counts invalid points toward the resource limit", () => {
    const source = gpx([pt("91", "0").repeat(200_001)]);
    expect(() => parseTrackGpx(source)).toThrow(/200,000 points/);
  });

  test("recovery refuses oversized source bytes", () => {
    const source = gpx([pt("0", "0") + pt("0", "1")]) + " ".repeat(20 * 1024 * 1024);
    expect(() => parseTrackGpx(source)).toThrow(/20 MiB/);
  });

  test("recovery refuses doctypes even when no entity is referenced", () => {
    const source = '<!DOCTYPE gpx [<!ENTITY x "0">]>' + gpx([pt("0", "0") + pt("0", "1")]);
    expect(() => parseTrackGpx(source)).toThrow(/doctypes/);
  });

  test("foreign namespaces cannot inject points into recovered geometry", () => {
    const source = gpx([pt("0", "0") + '<x:trkpt xmlns:x="urn:foreign" lat="0" lon="179"/>' + pt("0", "0.001")]);
    const parsed = parseTrackGpx(source);
    expect(parsed.segments[0]!.map(p => p.lon)).toEqual([0, 0.001]);
    expect(parsed.counts).toEqual({ input: 2, retained: 2, omitted: 0, segments: 1 });
  });

  test("invalid coordinates do not hide structurally duplicated fields", () => {
    const source = gpx([pt("91", "0", "<ele>0</ele><ele>1</ele>") + pt("0", "1")]);
    expect(() => parseTrackGpx(source)).toThrow(/Duplicate GPX point ele/);
  });

  test("wholly unusable geometry has a no-line outcome with exact evidence", () => {
    expect(recover(gpx([pt("NaN", "0") + pt("0", "181")]))).toMatchObject({
      status: "no_line", partial: true, segments: [],
      counts: { input: 2, retained: 0, omitted: 2, segments: 0 },
      omissions: [{ index: 0, reason: "latitude_missing_or_invalid" }, { index: 1, reason: "longitude_out_of_range" }] });
  });

  test("valid zero, poles and repeated points survive with unknown optional data", () => {
    const parsed = parseTrackGpx(gpx([pt("0", "0") + pt("0", "0"), pt("90", "180") + pt("90", "180")]));
    expect(parsed.segments.flat().map(p => [p.lat, p.lon])).toEqual([[0, 0], [0, 0], [90, 180], [90, 180]]);
    expect(parsed.counts).toEqual({ input: 4, retained: 4, omitted: 0, segments: 2 });
    expect(routeMetrics(parsed.segments)).toMatchObject({ distance_km: 0, ascent_m: null, recorded_duration_s: null });
  });

  test("recovery still rejects malformed, unsafe and nested input", () => {
    for (const source of [gpx([pt("0", "0") + pt("0", "1")]).slice(0, -6),
      '<!DOCTYPE gpx [<!ENTITY x "0">]>' + gpx([pt("0", "0") + pt("0", "1")]),
      gpx(["<extensions>".repeat(129) + "</extensions>".repeat(129)])]) {
      expect(() => parseTrackGpx(source)).toThrow();
    }
  });
});
