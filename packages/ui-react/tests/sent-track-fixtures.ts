import { parseImportedTrack, summarizeTrack } from "@schlessera/brain-geo";
import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";

/** Synthetic Odysseus originals; metadata follows the real validated parser. */
export function sentTrackFiles(): SharedFileMeta[] {
  const originals = [
    { name: "ithaca-coastal-route.gpx", incomingName: "Ithaca-to-Pylos-coastal-route-" + "Scylla".repeat(8) + ".gpx",
      source: '<gpx version="1.1"><trk><name>Ithaca coastal route</name><trkseg><trkpt lat="38.31" lon="20.71"/><trkpt lat="38.32" lon="20.72"/></trkseg></trk></gpx>' },
    { name: "harbour-moorings.kml", incomingName: "harbour-moorings.kml",
      source: '<kml><Document>' + Array.from({ length: 4 }, (_, i) => '<Placemark><name>Ithaca mooring ' + (i + 1) + '</name><Point><coordinates>' + (20.71 + i * 0.001) + ',38.31,0</coordinates></Point></Placemark>').join("") + '</Document></kml>' },
  ];
  return originals.map(({ name, incomingName, source }) => {
    const imported = parseImportedTrack(source);
    const path = '.brain-ui/inbox/00000000-0000-0000-0000-000000000000/' + name;
    const { geometry: _geometry, ...summary } = summarizeTrack(imported.track, { kind: "file", path });
    return { name, incomingName, path, mediaType: "application/octet-stream", detected: imported.format,
      bytes: new TextEncoder().encode(source).length,
      summary: { ...summary, waypointCount: imported.waypointCount, waypointOmitted: imported.waypointOmissions.length } };
  });
}
