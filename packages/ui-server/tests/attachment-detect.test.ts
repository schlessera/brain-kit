import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeText, detectKind } from "../src/attachments/detect";

// Routing on stored bytes (#3153, docs/plans/chat-attachments.md §4). Names and
// MIME types are hints; the bytes decide. Odysseus fixtures only.

const PDF = readFileSync(join(import.meta.dir, "../../core/fixtures/corpus/studies/star-chart.pdf"));
const GPX = '<gpx version="1.1"><trk><trkseg><trkpt lat="38.2" lon="20.7"/><trkpt lat="38.2" lon="20.701"/></trkseg></trk></gpx>';
const GEOJSON = JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[20.7, 38.2], [20.71, 38.21]] } });
const at = (name: string, mediaType = "application/octet-stream") => ({ name, mediaType, path: `.brain-ui/attachments/00000000-0000-4000-8000-000000000000/${name}` });
const bytes = (text: string) => new TextEncoder().encode(text);

test("signatures beat names and MIME hints", () => {
  expect(detectKind(PDF, at("ithaca-permit.pdf", "application/pdf"))).toMatchObject({ kind: "pdf", reader: "pdf", mediaType: "application/pdf" });
  expect(detectKind(PDF, at("notes.txt"))).toMatchObject({ kind: "pdf", reader: "pdf" });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  expect(detectKind(png, at("harbour.txt", "text/plain"))).toMatchObject({ kind: "image", reader: "image", mediaType: "image/png" });
  const heic = new Uint8Array([0, 0, 0, 24, ...bytes("ftypheic"), 0, 0, 0, 0]);
  expect(detectKind(heic, at("harbour.heic"))).toMatchObject({ kind: "image", reader: "none", mediaType: "image/heic" });
  expect(detectKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), at("charts.kmz"))).toMatchObject({ kind: "archive", reader: "none" });
  expect(detectKind(new Uint8Array([0x1f, 0x8b, 8, 0]), at("charts.tar.gz"))).toMatchObject({ kind: "archive", reader: "none" });
});

test("text is decided by strict UTF-8, whatever the MIME claims", () => {
  expect(detectKind(bytes("Eurylochus, Perimedes, Elpenor\n"), at("crew-list.txt", "image/png"))).toMatchObject({ kind: "text", reader: "text", mediaType: null });
  expect(detectKind(bytes("day 1: left Troy\n"), at("voyage.log"))).toMatchObject({ kind: "text", reader: "text" });
  // Ordinary JSON stays generic text: only the track parser makes a track.
  expect(detectKind(bytes('{"crew": 44, "ship": "black"}'), at("manifest.json", "application/json"))).toMatchObject({ kind: "text" });
  expect(detectKind(bytes("a\u0000b"), at("blob.bin"))).toMatchObject({ kind: "binary", reader: "none" });
  expect(detectKind(new Uint8Array([0xc3, 0x28, 0x41]), at("sirens.m4a", "audio/mp4"))).toMatchObject({ kind: "binary", reader: "none" });
  expect(decodeText(bytes("\u0001".repeat(3) + "x".repeat(97)))).toBeNull();
  expect(decodeText(bytes("\u0001" + "x".repeat(199)))).toBe("\u0001" + "x".repeat(199));
});

test("valid tracks keep the shared parser's evidence; a failed parse never forges one", () => {
  const gpx = detectKind(bytes(GPX), at("dock-walk.gpx"));
  expect(gpx).toMatchObject({ kind: "track", reader: "track", mediaType: "application/gpx+xml" });
  expect(gpx.track!.meta.detected).toBe("gpx");
  expect(gpx.track!.meta.summary.source.path).toBe(at("dock-walk.gpx").path);
  expect(gpx.track!.meta.summary.measurements.distance.value!).toBeGreaterThan(50);
  expect(detectKind(bytes(GEOJSON), at("dock-walk.json"))).toMatchObject({ kind: "track", mediaType: "application/geo+json" });
  // A name or MIME that says track grants nothing; the text stays readable.
  expect(detectKind(bytes("<kml>not a track</kml>"), at("harbour.kml"))).toEqual({ kind: "text", reader: "text", mediaType: null, trackRejected: true });
  expect(detectKind(bytes("<kml>not a track</kml>"), at("harbour.txt", "application/vnd.google-earth.kml+xml"))).toMatchObject({ trackRejected: true });
  expect(detectKind(bytes("plain"), at("plain.txt"))).not.toHaveProperty("trackRejected");
});
