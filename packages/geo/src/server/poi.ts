import { z } from "zod";
import type { GeoConfig } from "../config.js";
import { nearestTrackPoint } from "../spatial.js";
import { distanceM, EARTH_RADIUS_M, normalizeTrack, routePoint, type ParsedTrack } from "../track.js";
import { GeoReplyError, GeoTransport, type GeoError } from "./io.js";
import { overpassElements, queryOverpass, type OverpassResult } from "./overpass.js";

type Coordinate = {lat: number; lon: number};
export type PoiQuery = ({near: Coordinate; alongTrack?: never} | {alongTrack: ParsedTrack; near?: never}) & {
  /** All tags must match; true means the tag is present. Values are exact, not regular expressions. */
  tags: Record<string, string | true>;
  radiusM: number;
};
export interface PointOfInterest {
  osm: {type: "node" | "way" | "relation"; id: number};
  name: string | null;
  point: Coordinate;
  position: "node" | "bounding_box_center";
  tags: Record<string, string>;
  openingHours: {value: string | null; interpreted: false};
  distance: {value: number | null; unit: "m"; to: "query_point" | "retained_track"; position: "representative_point"};
  unknown: {field: string; reason: string}[];
}
export interface PoiResult extends OverpassResult<PointOfInterest[]> {
  query: {kind: "near" | "along_track"; radiusM: number; tags: Record<string, string | true>; sections: number; points: number} | null;
  track: {partial: boolean; counts: ParsedTrack["counts"]; omissions: ParsedTrack["omissions"]} | null;
  counts: {input: number; retained: number; omitted: number};
  truncated: boolean;
  method: {selection: "overpass_around_geometry"; distance: "great_circle_representative_point"; earthRadiusM: number;
    maxRadiusM: number; maxPoints: number; maxSections: number; maxQueryBytes: number; maxResults: number; maxSpanDegrees: number};
}
const limits = {maxRadiusM: 5_000, maxPoints: 2_000, maxSections: 100, maxQueryBytes: 65_536, maxResults: 1_000, maxSpanDegrees: 5};
const tagText = z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const tagSchema = z.record(tagText, z.union([tagText, z.literal(true)]));
const elementSchema = z.object({type: z.enum(["node", "way", "relation"]), id: z.number().int().positive(),
  lat: z.number().optional(), lon: z.number().optional(), center: z.object({lat: z.number(), lon: z.number()}).optional(),
  tags: z.record(z.string().max(200), z.string().max(2_000))});

function decodePois(raw: unknown, near: Coordinate | null, track: ParsedTrack | null): {
  items: PointOfInterest[]; input: number; omitted: number; truncated: boolean;
} {
  const data = {elements: overpassElements(raw)};
  if (data.elements.length > limits.maxResults + 1) throw new GeoReplyError({code: "response_limit", message: "Overpass exceeded the bounded element count."});
  const items: PointOfInterest[] = [], seen = new Set<string>();
  let omitted = 0;
  for (const rawElement of data.elements.slice(0, limits.maxResults)) {
    try {
      const element = elementSchema.parse(rawElement);
      if (Object.keys(element.tags).length > 100) throw new Error("Too many tags.");
      const coordinate = element.type === "node" ? {lat: element.lat!, lon: element.lon!} : element.center;
      if (!coordinate) throw new Error("Missing representative point.");
      const point = routePoint(coordinate.lat, coordinate.lon), key = `${element.type}/${element.id}`;
      if (seen.has(key)) { omitted++; continue; }
      seen.add(key);
      const unknown: PointOfInterest["unknown"] = [];
      const openingHours = element.tags.opening_hours?.trim() ? element.tags.opening_hours : null;
      if (openingHours === null) unknown.push({field: "openingHours", reason: "not_mapped"});
      const distance = near ? distanceM(routePoint(near.lat, near.lon), point) : nearestTrackPoint(track!, point, 0).distance.value;
      if (distance === null) unknown.push({field: "distance", reason: "track_distance_undefined"});
      items.push({osm: {type: element.type, id: element.id}, name: element.tags.name?.trim() ? element.tags.name : null,
        point: {lat: point.lat, lon: point.lon}, position: element.type === "node" ? "node" : "bounding_box_center", tags: {...element.tags},
        openingHours: {value: openingHours, interpreted: false},
        distance: {value: distance, unit: "m", to: near ? "query_point" : "retained_track", position: "representative_point"}, unknown});
    } catch { omitted++; }
  }
  const truncated = data.elements.length > limits.maxResults;
  if (!items.length && omitted) throw new Error("No usable POI in a nonempty response.");
  return {items, input: data.elements.length, omitted: omitted + (truncated ? 1 : 0), truncated};
}

/** Bounded exact tag queries preserve every retained section without bridging omissions. */
export async function findPois(config: GeoConfig, transport: GeoTransport, input: PoiQuery): Promise<PoiResult> {
  const method: PoiResult["method"] = {selection: "overpass_around_geometry", distance: "great_circle_representative_point", earthRadiusM: EARTH_RADIUS_M, ...limits};
  const base = {query: null, track: null, counts: {input: 0, retained: 0, omitted: 0}, truncated: false, method};
  const failed = (error: GeoError): PoiResult => ({...base, status: "error", value: null, source: null, error, warnings: [], attribution: [], attempts: []});
  let near: Coordinate | null = null, track: ParsedTrack | null = null, tags: PoiQuery["tags"], radius: number, sections: Coordinate[][];
  try {
    if (!input || (!!input.near === !!input.alongTrack)) throw new Error("Specify exactly one of near or alongTrack.");
    radius = z.number().finite().min(1).max(limits.maxRadiusM).parse(input.radiusM);
    tags = tagSchema.parse(input.tags);
    if (!Object.keys(tags).length || Object.keys(tags).length > 10) throw new Error("POI queries need 1–10 exact tag filters.");
    tags = Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (input.near) {
      const point = routePoint(input.near.lat, input.near.lon); near = {lat: point.lat, lon: point.lon}; sections = [[near]];
    } else {
      // Validate/copy current retained geometry without changing its original recovery metadata.
      const original = input.alongTrack!;
      const normalized = normalizeTrack(original.segments);
      if (normalized.partial || !normalized.counts.retained) throw new Error("alongTrack needs valid retained geometry from the shared parser.");
      track = {...normalized, partial: original.partial, counts: {...original.counts}, omissions: original.omissions.map(p => ({...p, reasons: [...p.reasons]}))};
      sections = track.segments.filter(section => section.length);
    }
    const points = sections.flat();
    if (points.length > limits.maxPoints || sections.length > limits.maxSections) throw new Error("POI track queries exceed 2,000 points or 100 sections; no geometry is silently simplified.");
    const latitudeMargin = radius / EARTH_RADIUS_M * 180 / Math.PI;
    const minLat = Math.min(...points.map(p => p.lat)) - latitudeMargin, maxLat = Math.max(...points.map(p => p.lat)) + latitudeMargin;
    const longitudeMargin = latitudeMargin / Math.cos(Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI / 180);
    const longitudeSpan = Math.max(...points.map(p => p.lon)) - Math.min(...points.map(p => p.lon)) + 2 * longitudeMargin;
    if (minLat <= -90 || maxLat >= 90 || maxLat - minLat > limits.maxSpanDegrees || longitudeSpan > limits.maxSpanDegrees) {
      throw new Error("POI spatial query exceeds the 5-degree budget (including radius), or crosses a pole/date line; valid source coordinates remain unchanged.");
    }
  } catch (error) { return failed({code: "input", message: error instanceof Error ? error.message : "Invalid POI query."}); }
  const filters = Object.entries(tags).map(([key, value]) => `[${JSON.stringify(key)}${value === true ? "" : "=" + JSON.stringify(value)}]`).join("");
  const query = `[out:json][timeout:${Math.max(1, Math.ceil(config.timeoutMs / 1_000))}][maxsize:33554432];(${sections.map(section =>
    `nwr${filters}(around:${radius},${section.map(point => `${point.lat},${point.lon}`).join(",")});`).join("")});out center ${limits.maxResults + 1};`;
  const record: PoiResult["query"] = {kind: near ? "near" : "along_track", radiusM: radius, tags, sections: sections.length, points: sections.reduce((n, s) => n + s.length, 0)};
  if (Buffer.byteLength(query, "utf8") > limits.maxQueryBytes) return {...failed({code: "input", message: "POI query exceeds 64 KiB."}), query: record};
  const result = await queryOverpass(config, transport, query, raw => decodePois(raw, near, track));
  const metadata = {query: record, track: track ? {partial: track.partial, counts: {...track.counts}, omissions: track.omissions} : null, method};
  if (result.error) return {...result, ...base, ...metadata, value: null};
  const value = result.value!;
  return {...result, ...metadata, status: track?.partial || value.omitted ? "partial" : value.items.length ? "ok" : "no_match", value: value.items,
    counts: {input: value.input, retained: value.items.length, omitted: value.omitted}, truncated: value.truncated,
    warnings: [...result.warnings, "Mapped opening hours are raw, unverified text; current open/closed status is unknown.",
      "Way/relation centers are representative bounding-box centers, which can lie outside the requested radius; selection uses the object's geometry.",
      ...(track?.partial ? ["Recovered track query covers retained sections only; all omission gaps remain excluded."] : []),
      ...(value.omitted ? [`${value.omitted} response element(s) omitted; available results are partial.`] : []),
      ...(value.truncated ? ["POI result cap reached; more matching objects may exist."] : [])]};
}
