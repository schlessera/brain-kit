import { SaxesParser } from "saxes";
import { MAX_ROUTE_BYTES } from "./limits.js";
import {
  normalizeTrack, parseTrackGpx, routePoint,
  type NormalizedTrackPoint, type ParsedTrack, type RoutePoint, type TrackOmission,
} from "./track.js";

export type TrackFormat = "gpx" | "kml" | "geojson";
export interface TrackWaypoint extends RoutePoint { name: string }
export interface ImportedTrack {
  format: TrackFormat;
  track: ParsedTrack;
  waypoints: TrackWaypoint[];
  waypointOmissions: TrackOmission[];
  waypointCount: number;
}
const MAX_POINTS = 200_000;
const MAX_DEPTH = 128;
const encoder = new TextEncoder();
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const number = (s: string | undefined): number | null => s !== undefined && decimal.test(s.trim()) && Number.isFinite(Number(s)) ? Number(s) : null;
/** Text is data: bounded, visible, and never markup or instructions. */
function label(value: unknown): string {
  return typeof value === "string" ? Array.from(value.replace(/[\p{Cf}\p{Cc}]/gu, "")).slice(0, 200).join("") : "";
}

interface XmlNode { local: string; uri: string; text: string; attributes: Record<string, string>; children: XmlNode[]; keep: boolean; pointCount: number }
/** Bounded strict XML; no entities, network links, alternate encodings or repairs. */
function xml(source: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined, nodes = 0;
  parser.on("xmldecl", d => { if (d.encoding && !/^(utf-8|us-ascii)$/i.test(d.encoding)) throw Error("Track XML must use UTF-8 or ASCII."); });
  parser.on("doctype", () => { throw Error("Track XML doctypes/entities are unsupported."); });
  parser.on("opentag", tag => {
    if (stack.length >= MAX_DEPTH || ++nodes > MAX_POINTS * 8) throw Error("Track XML exceeds nesting/node limits.");
    const node: XmlNode = { local: tag.local, uri: tag.uri, text: "", attributes: {}, children: [], keep: true, pointCount: 0 };
    for (const attr of Object.values(tag.attributes)) if (!attr.uri) node.attributes[attr.local] = attr.value;
    if (stack.length) {
      const parent = stack.at(-1)!;
      if (root!.local === "gpx") {
        // GPX lines are read by the shared SAX reader. Keep only waypoint fields,
        // so a 200k-point line never materializes a second XML tree.
        const same = tag.uri === root!.uri && stack.every(n => n.uri === root!.uri);
        const path = [...stack.map(n => n.local), tag.local].join("/");
        if (same && ["gpx/wpt", "gpx/rte/rtept", "gpx/trk/trkseg/trkpt"].includes(path) && ++root!.pointCount > MAX_POINTS) throw Error("Track exceeds 200,000 total points.");
        node.keep = same && (path === "gpx/wpt" || /^gpx\/wpt\/(?:name|ele|time)$/.test(path));
      }
      if (node.keep && parent.keep) parent.children.push(node);
    } else root = node;
    stack.push(node);
  });
  const text = (s: string): void => { if (stack.length) stack.at(-1)!.text += s; };
  parser.on("text", text); parser.on("cdata", text);
  parser.on("closetag", () => { stack.pop(); });
  parser.write(source).close();
  if (!root) throw Error("Empty track XML.");
  return root;
}
const children = (n: XmlNode, name: string): XmlNode[] => n.children.filter(c => c.local === name && c.uri === n.uri);
function one(n: XmlNode, name: string): XmlNode | undefined {
  const list = children(n, name);
  if (list.length > 1) throw Error(`Duplicate track XML ${name}.`);
  return list[0];
}
function waypoints(raw: { point: NormalizedTrackPoint; name: string }[]): Pick<ImportedTrack, "waypoints" | "waypointOmissions" | "waypointCount"> {
  // The same coordinate/optional metadata policy as the line; invalid waypoints remain counted.
  const normalized = normalizeTrack(raw.map(w => [w.point]));
  const omitted = new Set(normalized.omissions.map(o => o.index));
  const result: TrackWaypoint[] = [];
  for (const [i, w] of raw.entries()) if (!omitted.has(i)) {
    const p = w.point;
    result.push({ ...routePoint(p.lat, p.lon, p.elevation_m, p.time), name: w.name });
  }
  return { waypoints: result, waypointOmissions: normalized.omissions, waypointCount: raw.length };
}
function gpx(source: string, root: XmlNode): ImportedTrack {
  const track = parseTrackGpx(source); // Shared reader owns GPX lines and recovery; strict travel stays unchanged.
  const raw = children(root, "wpt").map(n => ({ name: label(one(n, "name")?.text), point: {
    lat: number(n.attributes.lat), lon: number(n.attributes.lon),
    elevation_m: number(one(n, "ele")?.text), time: one(n, "time")?.text.trim(),
  } }));
  return { format: "gpx", track, ...waypoints(raw) };
}
function kml(root: XmlNode): ImportedTrack {
  if (root.local !== "kml" || !["", "http://www.opengis.net/kml/2.2"].includes(root.uri)) throw Error("Expected KML 2.2.");
  const sections: NormalizedTrackPoint[][] = [], raw: { point: NormalizedTrackPoint; name: string }[] = [];
  let count = 0, supported = false;
  const coordinates = (n: XmlNode): NormalizedTrackPoint[] => {
    const source = one(n, "coordinates");
    if (!source) throw Error("KML geometry is missing coordinates.");
    const tokens = source.text.trim() ? source.text.trim().split(/\s+/) : [];
    return tokens.map(token => {
      if (++count > MAX_POINTS) throw Error("Track exceeds 200,000 total points.");
      const parts = token.split(",");
      if (parts.length < 2 || parts.length > 3) throw Error("KML positions require longitude,latitude[,altitude].");
      return { lon: number(parts[0]), lat: number(parts[1]), elevation_m: number(parts[2]) };
    });
  };
  const visit = (n: XmlNode, name: string): void => {
    if (n.uri !== root.uri) return;
    if (["NetworkLink", "Model", "Polygon", "LinearRing"].includes(n.local)) throw Error(`Unsupported KML ${n.local}.`);
    if (n.local === "Placemark") name = label(one(n, "name")?.text);
    if (n.local === "LineString") { supported = true; sections.push(coordinates(n)); return; }
    if (n.local === "Point") {
      supported = true; const points = coordinates(n);
      if (points.length !== 1) throw Error("KML Point requires one position.");
      raw.push({ point: points[0]!, name }); return;
    }
    for (const c of n.children) visit(c, name);
  };
  visit(root, "");
  if (!supported) throw Error("KML contains no supported line or waypoint geometry.");
  return { format: "kml", track: normalizeTrack(sections), ...waypoints(raw) };
}
function geojson(source: string): ImportedTrack {
  const value: unknown = JSON.parse(source);
  const sections: NormalizedTrackPoint[][] = [], raw: { point: NormalizedTrackPoint; name: string }[] = [];
  let count = 0, supported = false;
  const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw Error("GeoJSON coordinates/features must be arrays."); return v; };
  const position = (v: unknown): NormalizedTrackPoint => {
    const parts = array(v);
    if (parts.length < 2 || parts.length > 3) throw Error("GeoJSON positions require longitude,latitude[,altitude].");
    if (++count > MAX_POINTS) throw Error("Track exceeds 200,000 total points.");
    return { lon: parts[0], lat: parts[1], elevation_m: parts[2] };
  };
  const geometryTypes = new Set(["LineString", "MultiLineString", "Point", "MultiPoint", "GeometryCollection"]);
  const objectType = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined;
  const geometry = (value: unknown, name: string, depth: number): void => {
    if (!geometryTypes.has(objectType(value) as string)) throw Error("Expected supported GeoJSON geometry, not a Feature wrapper.");
    visit(value, name, depth);
  };
  const visit = (v: unknown, name = "", depth = 0): void => {
    if (depth > MAX_DEPTH) throw Error("GeoJSON nesting exceeds 128 levels.");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Expected a supported GeoJSON object.");
    const n = v as Record<string, unknown>;
    if ("crs" in n) throw Error("Alternate GeoJSON coordinate systems are unsupported.");
    switch (n.type) {
      case "FeatureCollection": for (const f of array(n.features)) {
        if (objectType(f) !== "Feature") throw Error("GeoJSON FeatureCollection members must be Features.");
        visit(f, "", depth + 1);
      } break;
      case "Feature": {
        if (n.properties !== null && (typeof n.properties !== "object" || Array.isArray(n.properties))) throw Error("GeoJSON properties must be an object or null.");
        const props = n.properties as Record<string, unknown> | null;
        geometry(n.geometry, label(props?.name), depth + 1); break;
      }
      case "GeometryCollection": for (const g of array(n.geometries)) geometry(g, name, depth + 1); break;
      case "LineString": supported = true; sections.push(array(n.coordinates).map(position)); break;
      case "MultiLineString": supported = true; for (const s of array(n.coordinates)) sections.push(array(s).map(position)); break;
      case "Point": supported = true; raw.push({ point: position(n.coordinates), name }); break;
      case "MultiPoint": supported = true; for (const p of array(n.coordinates)) raw.push({ point: position(p), name }); break;
      default: throw Error("Supported GeoJSON track geometry is LineString, MultiLineString and waypoint Points.");
    }
  };
  visit(value);
  if (!supported) throw Error("GeoJSON contains no supported line or waypoint geometry.");
  return { format: "geojson", track: normalizeTrack(sections), ...waypoints(raw) };
}

/** Content, never a filename/MIME claim, selects and validates the format. Original bytes are untouched. */
export function parseImportedTrack(source: string): ImportedTrack {
  if (encoder.encode(source).length > MAX_ROUTE_BYTES) throw Error("Track input exceeds 20 MiB.");
  const start = source.trimStart().replace(/^\uFEFF/, "");
  if (start.startsWith("{")) return geojson(start);
  if (!start.startsWith("<")) throw Error("Not a supported GPX, KML or GeoJSON track.");
  const root = xml(start);
  if (root.local === "gpx") return gpx(start, root);
  if (root.local === "kml") return kml(root);
  throw Error("Not a supported GPX, KML or GeoJSON track.");
}
