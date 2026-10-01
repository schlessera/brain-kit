import { SaxesParser } from "saxes";
import { z } from "zod";

export const MAX_ROUTE_BYTES = 20 * 1024 * 1024;
const MAX_POINTS = 200_000;
const EARTH_RADIUS_M = 6_371_008.8;
const radians = Math.PI / 180;
const isoTime = z.iso.datetime({ offset: true });
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface RoutePoint {
  lat: number;
  lon: number;
  elevation_m: number | null;
  time: string | null;
}
export interface RouteGeometry { segments: RoutePoint[][]; warnings: string[] }
export interface RouteMetrics {
  distance_km: number;
  ascent_m: number | null;
  altitude_min_m: number | null;
  altitude_max_m: number | null;
  shape: "loop" | "one_way" | "unknown";
  recorded_duration_s: number | null;
  points: number;
  segments: number;
}

export function routePoint(lat: unknown, lon: unknown, elevation: unknown = null, time: unknown = null): RoutePoint {
  const coordinate = (v: unknown, limit: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > limit) {
      throw new Error("Route coordinates must be finite latitude/longitude in their valid ranges.");
    }
    return v;
  };
  return {
    lat: coordinate(lat, 90), lon: coordinate(lon, 180),
    elevation_m: typeof elevation === "number" && Number.isFinite(elevation) ? elevation : null,
    time: typeof time === "string" && isoTime.safeParse(time).success ? new Date(time).toISOString() : null,
  };
}

export type OmissionReason = "latitude_missing_or_invalid" | "longitude_missing_or_invalid"
  | "latitude_out_of_range" | "longitude_out_of_range";
export interface TrackOmission { index: number; reason: OmissionReason; reasons: OmissionReason[] }
export interface ParsedTrack extends RouteGeometry {
  status: "ok" | "partial" | "no_line";
  partial: boolean;
  kind: "track" | "route";
  counts: { input: number; retained: number; omitted: number; segments: number };
  omissions: TrackOmission[];
}
interface PointCollection { segments: RoutePoint[][]; input: number; omissions: TrackOmission[] }

/** One XML reader; recovery is an explicit policy and never relaxes structural guards. */
function readGpx(source: string, recovery: boolean): ParsedTrack {
  if (Buffer.byteLength(source) > MAX_ROUTE_BYTES) throw new Error("Route input exceeds 20 MiB.");
  const parser = new SaxesParser({ xmlns: true });
  const frames: { local: string; uri: string; text: string }[] = [];
  const tracks: PointCollection = { segments: [], input: 0, omissions: [] };
  const routes: PointCollection = { segments: [], input: 0, omissions: [] };
  const warnings = new Set<string>();
  let namespace = "", segment: RoutePoint[] | null = null, point: RoutePoint | null = null, count = 0;
  let collection = tracks;
  let pointFields = new Set<string>();
  const pathIs = (...parts: string[]): boolean => frames.length === parts.length
    && frames.every((frame, i) => frame.local === parts[i] && frame.uri === namespace);
  const number = (v: string | undefined): number | null => v !== undefined && decimalPattern.test(v.trim())
    && Number.isFinite(Number(v)) ? Number(v) : null;
  parser.on("xmldecl", (declaration) => {
    if (declaration.encoding && !/^(utf-8|us-ascii)$/i.test(declaration.encoding)) throw new Error("GPX input must use UTF-8 or ASCII encoding.");
  });
  parser.on("doctype", () => { throw new Error("GPX doctypes/entities are unsupported."); });
  parser.on("opentag", (tag) => {
    frames.push({ local: tag.local, uri: tag.uri, text: "" });
    if (frames.length > 128) throw new Error("GPX nesting exceeds 128 levels.");
    if (frames.length === 1) {
      const version = tag.attributes.version?.value;
      if (tag.local !== "gpx" || (version !== "1.0" && version !== "1.1")
        || !["", `http://www.topografix.com/GPX/${version.replace(".", "/")}`].includes(tag.uri)) {
        throw new Error("Expected GPX 1.0 or 1.1 with a matching namespace.");
      }
      namespace = tag.uri;
    }
    if (pathIs("gpx", "trk", "trkseg") || pathIs("gpx", "rte")) {
      collection = frames.length === 3 ? tracks : routes;
      segment = []; collection.segments.push(segment);
    }
    if (pathIs("gpx", "trk", "trkseg", "trkpt") || pathIs("gpx", "rte", "rtept")) {
      if (++count > MAX_POINTS) throw new Error("Route exceeds 200,000 points.");
      const index = collection.input++;
      const lat = number(tag.attributes.lat?.value), lon = number(tag.attributes.lon?.value);
      pointFields = new Set();
      const reasons: OmissionReason[] = [];
      if (lat === null) reasons.push("latitude_missing_or_invalid");
      else if (Math.abs(lat) > 90) reasons.push("latitude_out_of_range");
      if (lon === null) reasons.push("longitude_missing_or_invalid");
      else if (Math.abs(lon) > 180) reasons.push("longitude_out_of_range");
      if (recovery && reasons.length) {
        collection.omissions.push({ index, reason: reasons[0]!, reasons });
        // A fresh section starts immediately: later good points never bridge this omission.
        segment = []; collection.segments.push(segment); point = null;
      } else {
        point = routePoint(lat, lon); segment!.push(point);
      }
    }
  });
  const text = (value: string): void => { if (frames.length) frames[frames.length - 1]!.text += value; };
  parser.on("text", text); parser.on("cdata", text);
  parser.on("closetag", () => {
    const frame = frames[frames.length - 1]!;
    if (["ele", "time"].includes(frame.local)
      && (pathIs("gpx", "trk", "trkseg", "trkpt", frame.local) || pathIs("gpx", "rte", "rtept", frame.local))) {
      if (pointFields.has(frame.local)) throw new Error(`Duplicate GPX point ${frame.local}.`);
      pointFields.add(frame.local);
      const value = frame.text.trim();
      if (point && frame.local === "ele") {
        point.elevation_m = number(value);
        if (point.elevation_m === null) warnings.add("Invalid elevations are treated as unknown.");
      } else if (point) {
        point.time = routePoint(point.lat, point.lon, null, value).time;
        if (point.time === null) warnings.add("Invalid timestamps are treated as unknown.");
      }
    }
    if (pathIs("gpx", "trk", "trkseg", "trkpt") || pathIs("gpx", "rte", "rtept")) point = null;
    if (pathIs("gpx", "trk", "trkseg") || pathIs("gpx", "rte")) segment = null;
    frames.pop();
  });
  parser.write(source).close();
  const hasLine = (c: PointCollection): boolean => c.segments.some(s => s.length >= 2);
  // Preserve strict travel's track-over-route precedence. With no usable line,
  // recovery keeps the selected source's point/omission evidence instead of throwing.
  const selected = hasLine(tracks) ? tracks : hasLine(routes) ? routes : recovery && tracks.input ? tracks : routes;
  const segments = selected.segments.filter(s => s.length >= (recovery ? 1 : 2));
  if (!recovery && selected.segments.some(s => s.length < 2)) warnings.add("Empty/single-point segments are omitted.");
  if (!recovery && !segments.length) throw new Error("GPX has no track or route segment with at least two points.");
  const partial = selected.omissions.length > 0;
  if (partial) warnings.add(`${selected.omissions.length} invalid point(s) omitted; gaps preserved; values cover usable sections only.`);
  const retained = segments.reduce((n, s) => n + s.length, 0);
  return { segments, warnings: [...warnings], omissions: selected.omissions,
    kind: selected === tracks ? "track" : "route", partial,
    status: !hasLine(selected) ? "no_line" : partial ? "partial" : "ok",
    counts: { input: selected.input, retained, omitted: selected.omissions.length,
      segments: segments.length } };
}

/** Travel-compatible strict parser: invalid coordinates reject and short sections are omitted. */
export function parseGpx(source: string): RouteGeometry {
  const { segments, warnings } = readGpx(source, false);
  return { segments, warnings };
}

/** File-provided geometry with explicit omissions; point evidence survives even without a line. */
export function parseTrackGpx(source: string): ParsedTrack {
  return readGpx(source, true);
}

export function distanceM(a: RoutePoint, b: RoutePoint): number {
  const lat1 = a.lat * radians, lat2 = b.lat * radians;
  const sinLat = Math.sin((lat2 - lat1) / 2), sinLon = Math.sin((b.lon - a.lon) * radians / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
const round = (n: number, digits: number): number => Number(n.toFixed(digits)) || 0;
const lengthM = (segment: RoutePoint[]): number => segment.slice(1).reduce((n, p, i) => n + distanceM(segment[i]!, p), 0);

function interpolate(a: RoutePoint, b: RoutePoint, ratio: number): RoutePoint {
  if (ratio === 0) return { ...a };
  if (ratio === 1) return { ...b };
  const vector = (p: RoutePoint): number[] => [Math.cos(p.lat * radians) * Math.cos(p.lon * radians),
    Math.cos(p.lat * radians) * Math.sin(p.lon * radians), Math.sin(p.lat * radians)];
  const x = vector(a), y = vector(b);
  const angle = distanceM(a, b) / EARTH_RADIUS_M;
  if (Math.PI - angle < 1e-10) throw new Error("Cannot trim an ambiguous antipodal track edge.");
  const blend = (i: number): number => angle < 1e-10 ? x[i]! * (1 - ratio) + y[i]! * ratio
    : (Math.sin((1 - ratio) * angle) * x[i]! + Math.sin(ratio * angle) * y[i]!) / Math.sin(angle);
  const v = [blend(0), blend(1), blend(2)];
  return {
    lat: Math.atan2(v[2]!, Math.hypot(v[0]!, v[1]!)) / radians,
    lon: Math.atan2(v[1]!, v[0]!) / radians,
    elevation_m: a.elevation_m === null || b.elevation_m === null ? null
      : a.elevation_m + (b.elevation_m - a.elevation_m) * ratio,
    time: a.time === null || b.time === null || Date.parse(b.time) < Date.parse(a.time) ? null
      : new Date(Date.parse(a.time) + (Date.parse(b.time) - Date.parse(a.time)) * ratio).toISOString(),
  };
}

/** Trim cumulative segment distance, without joining gaps or copying source metadata. */
export function trimRoute(segments: RoutePoint[][], startM: number, endM: number): RoutePoint[][] {
  if (![startM, endM].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Trim distances must be finite, nonnegative metres.");
  const lengths = segments.map(lengthM), total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Route has no positive track distance.");
  if (startM + endM >= total) throw new Error("Trimming would remove the entire route; no file written.");
  if (startM === 0 && endM === 0) return segments.map((s) => s.map((p) => ({ ...p })));
  const result: RoutePoint[][] = [];
  let offset = 0;
  for (const [index, segment] of segments.entries()) {
    const length = lengths[index]!, lower = Math.max(0, startM - offset), upper = Math.min(length, total - endM - offset);
    offset += length;
    if (upper <= lower) continue;
    const positions = [0];
    for (let i = 1; i < segment.length; i++) positions.push(positions[i - 1]! + distanceM(segment[i - 1]!, segment[i]!));
    const sample = (at: number, last: boolean): RoutePoint => {
      if (at === 0) return { ...segment[0]! };
      if (at === length) return { ...segment[segment.length - 1]! };
      const exact = positions.map((value, i) => value === at ? i : -1).filter((i) => i >= 0);
      if (exact.length) return { ...segment[exact[last ? exact.length - 1 : 0]!]! };
      const i = positions.findIndex((value) => value > at);
      return interpolate(segment[i - 1]!, segment[i]!, (at - positions[i - 1]!) / (positions[i]! - positions[i - 1]!));
    };
    result.push([sample(lower, false), ...segment.filter((_, i) => positions[i]! > lower && positions[i]! < upper).map((p) => ({ ...p })), sample(upper, true)]);
  }
  return result;
}

/** Metrics and GPX share these exact, quantized retained points. */
export function quantizeRoute(segments: RoutePoint[][]): RoutePoint[][] {
  return segments.map((s) => s.map((p) => ({ ...p, lat: round(p.lat, 9), lon: round(p.lon, 9),
    elevation_m: p.elevation_m === null ? null : round(p.elevation_m, 3) })));
}

export function routeMetrics(segments: RoutePoint[][]): RouteMetrics {
  const points = segments.flat(), distance = segments.reduce((n, s) => n + lengthM(s), 0);
  const elevationKnown = points.every((p) => p.elevation_m !== null);
  let ascent = 0, duration = 0;
  let timeKnown = true;
  for (const segment of segments) {
    if (elevationKnown) {
      const elevations = segment.map((p) => p.elevation_m!);
      const smooth = elevations.map((n, i) => i === 0 || i === elevations.length - 1 ? n
        : [elevations[i - 1]!, n, elevations[i + 1]!].sort((a, b) => a - b)[1]!);
      let reference = smooth[0]!;
      for (const n of smooth.slice(1)) if (Math.abs(n - reference) >= 3) {
        ascent += Math.max(0, n - reference); reference = n;
      }
    }
    if (segment.some((p) => p.time === null) || segment.some((p, i) => i > 0 && Date.parse(p.time!) < Date.parse(segment[i - 1]!.time!))) timeKnown = false;
    else duration += (Date.parse(segment[segment.length - 1]!.time!) - Date.parse(segment[0]!.time!)) / 1000;
  }
  const altitudes = points.map((p) => p.elevation_m!);
  const extrema = (maximum: boolean): number => altitudes.reduce((a, b) => maximum ? Math.max(a, b) : Math.min(a, b));
  const closed = segments.length === 1 && distanceM(points[0]!, points[points.length - 1]!) <= Math.min(30, distance * 0.05);
  return { distance_km: round(distance / 1000, 6), ascent_m: elevationKnown && Number.isFinite(ascent) ? round(ascent, 3) : null,
    altitude_min_m: elevationKnown ? extrema(false) : null, altitude_max_m: elevationKnown ? extrema(true) : null,
    shape: segments.length === 1 ? closed ? "loop" : "one_way" : "unknown", recorded_duration_s: timeKnown ? round(duration, 3) : null,
    points: points.length, segments: segments.length };
}

/** A whitelist export: retained points and recomputed bounds, never source fields. */
export function writeGpx(segments: RoutePoint[][]): string {
  const points = segments.flat();
  const decimal = (n: number, digits: number): string => n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: digits });
  const min = (axis: "lat" | "lon"): number => points.reduce((n, p) => Math.min(n, p[axis]), Infinity);
  const max = (axis: "lat" | "lon"): number => points.reduce((n, p) => Math.max(n, p[axis]), -Infinity);
  const body = segments.map((s) => `    <trkseg>\n${s.map((p) => `      <trkpt lat="${decimal(p.lat, 9)}" lon="${decimal(p.lon, 9)}">${p.elevation_m === null ? "" : `<ele>${decimal(p.elevation_m, 3)}</ele>`}${p.time === null ? "" : `<time>${p.time}</time>`}</trkpt>`).join("\n")}\n    </trkseg>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="brain-kit">\n  <metadata><bounds minlat="${decimal(min("lat"), 9)}" minlon="${decimal(min("lon"), 9)}" maxlat="${decimal(max("lat"), 9)}" maxlon="${decimal(max("lon"), 9)}"/></metadata>\n  <trk>\n${body}\n  </trk>\n</gpx>\n`;
}

