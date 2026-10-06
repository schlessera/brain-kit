import { type TrackMapProps } from "@schlessera/brain-ui-kit";
import { mapViewBounds } from "@schlessera/brain-ui-kit/internal";
import type { TrackFileView } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { geometryPaths } from "../components/chat/tool-cards/location-card.js";

export interface TrackDisplay {
  view: TrackFileView;
  props: TrackMapProps;
}
/** Fit every retained point through its envelope; never clamp or wrap imported evidence. */
export function planTrack(view: TrackFileView): { fitPoints: TrackMapProps["fitPoints"]; bbox?: [number, number, number, number]; reason?: string } {
  const bounds = view.file.summary?.bounds;
  if (view.track.status === "no_line" || !bounds) return { fitPoints: [], reason: "No usable track line in this file. The complete summary, waypoint list and original remain below." };
  const [west, south, east, north] = bounds;
  const fitPoints = [{ lon: west, lat: south }, { lon: west, lat: north }, { lon: east, lat: south }, { lon: east, lat: north }];
  if (Math.max(Math.abs(south), Math.abs(north)) > 85 || east - west > 180) return { fitPoints, reason: "This track exceeds the static map's Mercator or longitude range. Coordinates are preserved; the complete summary and original remain below." };
  // Union covers the supported card at every width, including a narrow pane.
  const frames = [110, 420].map(width => mapViewBounds(fitPoints, { width, height: 220, spanKm: 0.1 }));
  const bbox: [number, number, number, number] = [Math.min(...frames.map(f => f.mw)), Math.min(...frames.map(f => f.latBot)), Math.max(...frames.map(f => f.me)), Math.max(...frames.map(f => f.latTop))];
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -85 || bbox[3] > 85) return { fitPoints, reason: "The full track cannot fit this static projection without clipping or wrapping. Coordinates are preserved; the complete summary and original remain below." };
  // The background query guard is independent of track projection support.
  return { fitPoints, ...(bbox[2] - bbox[0] <= 5 && bbox[3] - bbox[1] <= 5 ? { bbox } : {}) };
}

function metres(value: number | null): string { return value === null ? "Unknown" : `${Math.round(value).toLocaleString("en-US")} m`; }
function seconds(value: number | null): string {
  if (value === null) return "Unknown";
  const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), seconds = Math.round(value % 60);
  return [hours ? `${hours} h` : "", minutes ? `${minutes} min` : "", seconds || !value ? `${seconds} s` : ""].filter(Boolean).join(" ");
}
/** All measurements come from the unsimplified shared parser, including true zero values. */
export function trackMapProps(view: TrackFileView, title?: string): TrackMapProps {
  const summary = view.file.summary;
  if (!summary) throw Error("Track summary is unavailable.");
  const plan = planTrack(view);
  const m = summary.measurements;
  const reason = (field: string) => summary.unknown.find(item => item.field === field)?.reason.replaceAll("_", " ");
  const metrics: TrackMapProps["metrics"] = [
    { label: "Distance", value: m.distance.value === null ? "Unknown" : m.distance.value >= 1000 ? `${(m.distance.value / 1000).toFixed(2)} km` : metres(m.distance.value), reason: reason("distance") },
    { label: "Ascent", value: metres(m.ascent.value), reason: reason("ascent") },
    { label: "Descent", value: metres(m.descent.value), reason: reason("descent") },
    { label: "Altitude minimum", value: metres(m.altitudeMin.value), reason: reason("altitudeMin") },
    { label: "Altitude maximum", value: metres(m.altitudeMax.value), reason: reason("altitudeMax") },
    { label: "Elapsed with pauses", value: seconds(m.elapsed.value), reason: reason("elapsed") },
    { label: "Moving time", value: "Unavailable", reason: reason("movingTime") ?? "No movement estimator in this import." },
    { label: "Shape", value: summary.shape === "one_way" ? "One way" : summary.shape === "loop" ? "Loop" : "Unknown", reason: reason("shape") },
  ];
  const omissions = (label: string, items: TrackFileView["track"]["omissions"]) => {
    const counts = new Map<string, number>();
    for (const item of items) for (const reason of item.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return items.length ? `${label}: ${items.length} omitted (${[...counts].map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`).join("; ")}). Each omitted line point breaks the line.` : "";
  };
  const coordinate = (point: { lat: number; lon: number }) => `${point.lat}, ${point.lon}`;
  const evidence = [
    summary.partial ? "Partial measurements · usable sections only; original and recovered gaps are excluded." : "Measurements cover usable sections only; elapsed includes pauses and excludes segment gaps.",
    `${summary.counts.retained} retained of ${summary.counts.input} line points · ${summary.counts.omitted} omitted · ${summary.counts.segments} usable sections · ${Math.max(0, summary.counts.segments - 1)} gaps.`,
    plan.reason ? "No points drawn; the original coordinates are retained in the attached file." : `${summary.counts.retained} points drawn, unsimplified · separate lines preserve every gap.`,
    ...(summary.start ? [`Start: ${coordinate(summary.start)}${summary.start.time ? ` · ${summary.start.time}` : " · time unknown"}`] : []),
    ...(summary.end ? [`End: ${coordinate(summary.end)}${summary.end.time ? ` · ${summary.end.time}` : " · time unknown"}`] : []),
    ...(summary.bounds ? [`Bounds west, south, east, north: ${summary.bounds.join(", ")}`] : []),
    `${view.waypoints.length} usable of ${view.waypointCount} waypoints; ${view.waypointOmissions.length} omitted.`,
    omissions("Line points", view.track.omissions), omissions("Waypoints", view.waypointOmissions),
    ...summary.warnings,
    ...(summary.source.recordingClaim ? [`File recording claim (unverified): ${summary.source.recordingClaim.text}`] : []),
    "Distance: great-circle. Elevation: three-point median, 3 m hysteresis; complete eligible elevation required.",
  ].filter(Boolean);
  const endpoints: TrackMapProps["endpoints"] = summary.start && summary.end ? [
    { lat: summary.start.lat, lon: summary.start.lon, label: "S", marker: "start", tone: "teal" }, { lat: summary.end.lat, lon: summary.end.lon, label: "E", marker: "end", tone: "amber" },
  ] : [];
  return {
    title: title ?? (view.file.incomingName || view.file.name), format: view.format === "geojson" ? "GeoJSON" : view.format.toUpperCase(),
    originalPath: view.file.path, originalName: view.file.name,
    paths: view.track.segments.map(segment => ({ coords: segment.map(point => [point.lon, point.lat]), tone: "teal", width: 2.5 })),
    fitPoints: plan.fitPoints, endpoints, ...(plan.reason ? { projectionReason: plan.reason } : {}), metrics, evidence,
    waypoints: view.waypoints.map(point => ({ name: point.name, coordinate: coordinate(point), ...(point.elevation_m !== null ? { elevation: metres(point.elevation_m) } : {}), ...(point.time ? { time: point.time } : {}) })),
  };
}

/** Resolve file and optional background before drawing or building a scriptless export. */
export async function loadTrackDisplay(root: BrainUiRoot, path: string, title?: string, signal?: AbortSignal): Promise<TrackDisplay> {
  const response = await root.request(`${root.apiBase()}/tracks?path=${encodeURIComponent(path)}`, { signal });
  if (!response.ok) throw Error("The staged track is unavailable. The original may have expired.");
  const view = await response.json() as TrackFileView;
  const props = trackMapProps(view, title);
  const plan = planTrack(view);
  if (plan.bbox) {
    try {
      const geo = await root.api.geoCoastline(plan.bbox, { width: 495, signal });
      const paths = geometryPaths(geo);
      if (paths.length || geo.land.length) props.background = { paths, ...(geo.land.length ? { land: { rings: geo.land } } : {}), attribution: geo.attribution };
    } catch { if (signal?.aborted) throw Error("Track loading cancelled."); }
  }
  return { view, props };
}
