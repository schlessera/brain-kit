import { expect, test } from "bun:test";
import { parseImportedTrack, summarizeTrack } from "../src/index.js";
import { MAX_ROUTE_BYTES } from "../src/internal.js";

const gpx = '<gpx version="1.1"><wpt lat="2" lon="3"><name>Harbour gate</name></wpt><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';
test("GPX adapters keep the common line measurements and named waypoint evidence", () => {
  const parsed = parseImportedTrack(gpx);
  expect(parsed.format).toBe("gpx");
  expect(parsed.track.segments[0]).toHaveLength(2);
  expect(parsed.waypoints).toEqual([{ lat: 2, lon: 3, elevation_m: null, time: null, name: "Harbour gate" }]);
  const summary = summarizeTrack(parsed.track, { kind: "file", path: "ithaca.gpx" });
  expect(summary.measurements.distance.value!).toBeCloseTo(111.1273, 2);
  expect(summary.measurements.elapsed.value).toBeNull();
  expect(summary.measurements.movingTime.value).toBeNull();
});
test("KML lines and waypoint positions are longitude,latitude and preserve gaps", () => {
  const parsed = parseImportedTrack('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Gate</name><Point><coordinates>3,2,10</coordinates></Point></Placemark><Placemark><MultiGeometry><LineString><coordinates>3,2,10 3.001,2,12 bad,2,13 4,2,15 4.001,2,16</coordinates></LineString><LineString><coordinates>5,2 5.001,2</coordinates></LineString></MultiGeometry></Placemark></Document></kml>');
  expect(parsed.waypoints[0]).toMatchObject({ lat: 2, lon: 3, name: "Gate", elevation_m: 10 });
  expect(parsed.track.segments.map(s => s.map(p => p.lon))).toEqual([[3, 3.001], [4, 4.001], [5, 5.001]]);
  expect(parsed.track.counts).toEqual({ input: 7, retained: 6, omitted: 1, segments: 3 });
  expect(parsed.track.status).toBe("partial");
  expect(parsed.track.omissions[0]).toMatchObject({ index: 2, reason: "longitude_missing_or_invalid" });
});
test("supported GeoJSON recovers invalid coordinates without coercion or gap bridges", () => {
  const parsed = parseImportedTrack(JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Waypoint" }, geometry: { type: "Point", coordinates: [0, 0] } },
    { type: "Feature", properties: null, geometry: { type: "MultiLineString", coordinates: [[[0, 0], [1, 0], [2, 95], [3, 0], [4, 0]], [[5, 0], ["6", 0], [7, 0]]] } },
  ] }));
  expect(parsed.waypoints[0]).toMatchObject({ lat: 0, lon: 0, name: "Waypoint" });
  expect(parsed.track.segments.map(s => s.map(p => p.lon))).toEqual([[0, 1], [3, 4], [5], [7]]);
  expect(parsed.track.counts).toEqual({ input: 8, retained: 6, omitted: 2, segments: 4 });
  expect(parsed.track.omissions.map(o => o.index)).toEqual([2, 6]);
});
test("waypoint-only files and invalid waypoint evidence never fabricate a line", () => {
  const parsed = parseImportedTrack('<gpx version="1.1"><wpt lat="90" lon="0"/><wpt lat="99" lon="0"/></gpx>');
  expect(parsed.track.status).toBe("no_line");
  expect(parsed.waypointCount).toBe(2);
  expect(parsed.waypoints).toHaveLength(1);
  expect(parsed.waypoints[0]!.lat).toBe(90);
  expect(parsed.waypointOmissions).toEqual([{ index: 1, reason: "latitude_out_of_range", reasons: ["latitude_out_of_range"] }]);
});
for (const [name, source] of [
  ["ordinary JSON", '{"hello":"world"}'],
  ["XML entities", '<!DOCTYPE kml [<!ENTITY x "text">]><kml/>'],
  ["malformed XML", '<kml><LineString></kml>'],
  ["alternate encoding", '<?xml version="1.0" encoding="ISO-8859-1"?><kml/>'],
  ["unsupported KML geometry", '<kml><Polygon/></kml>'],
  ["unsupported JSON geometry", '{"type":"Polygon","coordinates":[]}'],
  ["alternate JSON CRS", '{"type":"LineString","crs":{},"coordinates":[[0,0],[1,1]]}'],
  ["duplicate coordinates", '<kml><LineString><coordinates>0,0 1,1</coordinates><coordinates>2,2 3,3</coordinates></LineString></kml>'],
] as const) test(`${name} remains a structural error`, () => { expect(() => parseImportedTrack(source)).toThrow(); });
test("byte, depth and aggregate point limits count all evidence", () => {
  expect(() => parseImportedTrack(" ".repeat(MAX_ROUTE_BYTES + 1))).toThrow("20 MiB");
  expect(() => parseImportedTrack('<kml>' + '<Folder>'.repeat(129) + '</Folder>'.repeat(129) + '</kml>')).toThrow("nesting");
  expect(() => parseImportedTrack('<gpx version="1.1">' + '<wpt lat="2" lon="3"/>'.repeat(200_001) + '</gpx>')).toThrow("200,000");
});

test("GeoJSON wrappers are structurally validated, rather than treating mislabeled ordinary objects as geometry", () => {
  const line = { type: "LineString", coordinates: [[3,2],[3.01,2]] };
  const feature = { type: "Feature", properties: {}, geometry: line };
  for (const bad of [{ type: "FeatureCollection", features: [line] }, { type: "GeometryCollection", geometries: [feature] }, { type: "Feature", properties: {}, geometry: feature }]) expect(() => parseImportedTrack(JSON.stringify(bad))).toThrow();
  expect(parseImportedTrack(JSON.stringify({ type: "FeatureCollection", features: [feature] })).track.counts.retained).toBe(2);
});
