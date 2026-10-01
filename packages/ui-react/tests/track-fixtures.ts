import { trackMapProps } from "../src/lib/track-display.js";
import { parseImportedTrack, summarizeTrack } from "@schlessera/brain-geo";
import type { TrackFileView } from "@schlessera/brain-ui-sdk/protocol";

/** Invented Odyssey track, approximately 10 km; no personal recording or location. */
export function trackView(coordinates?: unknown[][]): TrackFileView {
  const points = coordinates ?? Array.from({ length: 129 }, (_, i) => {
    const angle = 2 * Math.PI * i / 128;
    return [20.71 + Math.cos(angle) * 1591.55 / (111_195 * Math.cos(38.31 * Math.PI / 180)), 38.31 + Math.sin(angle) * 1591.55 / 111_195, 12];
  });
  const source = JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Ithaca loop" }, geometry: { type: "LineString", coordinates: points } },
    { type: "Feature", properties: { name: "Raft timber stand" }, geometry: { type: "Point", coordinates: [20.71, 38.31, 12] } },
  ] });
  const imported = parseImportedTrack(source);
  const path = ".brain-ui/inbox/00000000-0000-0000-0000-000000000000/ithaca-loop.geojson";
  const { geometry: _geometry, ...summary } = summarizeTrack(imported.track, { kind: "file", path });
  return { ...imported, file: { name: "ithaca-loop.geojson", incomingName: "Ithaca loop", mediaType: "application/octet-stream", detected: "geojson", bytes: new TextEncoder().encode(source).length, path,
    summary: { ...summary, waypointCount: imported.waypointCount, waypointOmitted: imported.waypointOmissions.length } } };
}

export function trackDisplayFixture() { const view = trackView(); return { view, props: trackMapProps(view) }; }
