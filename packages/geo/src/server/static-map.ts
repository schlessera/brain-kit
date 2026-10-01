import { routePoint, summarizeTrack, type ParsedTrack, type TrackSource, type TrackSummary } from "../track.js";
import type { BBox, Coord } from "../coastline.js";
import type { GeoAttribution, GeoClient } from "./client.js";
import type { CoastlineServiceResult } from "./coastline.js";
import type { RoutingResult } from "./routing.js";
import { backgroundSvg, mapFonts, mapPath, mapText, mapViewport, MAX_MAP_LAT, textWidth, wrapMapText, xml, type MapTextLine } from "./map-svg.js";

export interface StaticMapTrack { track: ParsedTrack; source: TrackSource; label?: string }
export interface StaticMapPin { lat: number; lon: number; label: string }
export interface StaticMapInput {
  tracks?: StaticMapTrack[];
  pins?: StaticMapPin[];
  /** Already-calculated results; missing routes retain every requested stop/leg. No route request occurs here. */
  routes?: RoutingResult[];
  bbox?: BBox;
  title?: string;
  widthPx?: number;
  /** Concrete prefetched evidence renders without fetching; none explicitly omits background requests. */
  background?: "auto" | "none" | CoastlineServiceResult;
}
export type StaticMapReason = "unsupported_projection" | "background_extent" | "background_unavailable" | "background_omitted"
  | "no_spatial_input" | "unsupported_text" | "render_budget" | "renderer_unavailable";
export interface StaticMapTrackEvidence { index: number; label: string; summary: TrackSummary; omissions: ParsedTrack["omissions"]; visiblePoints: number; croppedPoints: number }
export interface StaticMapPinEvidence extends StaticMapPin { index: number; drawn: boolean; reason: "outside_viewport" | "no_artifact" | null }
export interface StaticMapLegEvidence {
  route: number; index: number; mode: RoutingResult["request"]["mode"];
  from: { lat: number; lon: number }; to: { lat: number; lon: number };
  available: boolean; distanceM: number | null; durationS: number | null;
}
export interface StaticMapScale { value: number; unit: "m"; lengthPx: number; latitude: number; method: "mercator_at_center_latitude" }
export interface StaticMapResult {
  status: "ok" | "partial" | "no_map";
  kind: "geometry" | "track_only" | "none";
  reason: StaticMapReason | null;
  png: Uint8Array | null;
  svg: string | null;
  widthPx: number; heightPx: number | null;
  bounds: BBox | null;
  /** Complete text equivalent: no stop/leg truncation, including absent routes and undrawn pins. */
  text: string;
  title: string;
  tracks: StaticMapTrackEvidence[];
  pins: StaticMapPinEvidence[];
  legs: StaticMapLegEvidence[];
  routes: RoutingResult[];
  background: CoastlineServiceResult | null;
  attribution: GeoAttribution[];
  warnings: string[];
  method: { projection: "spherical_web_mercator"; line: "source_vertices_in_mercator"; latitudeLimit: number;
    scale: StaticMapScale | null; text: "bundled_ibm_plex_glyph_outlines"; gaps: "preserved" };
}
const INK = "#231f1a", MUTED = "#56514b", COLORS = ["#15594c", "#1d5f9c", "#805419", "#68488d"];
const REASONS: Record<StaticMapReason, string> = {
  unsupported_projection: "This projection cannot display the source coordinates; the original geometry is retained.",
  background_extent: "The area exceeds the background service limit; no background query was sent.",
  background_unavailable: "Background geometry is unavailable; source tracks and stops remain available.",
  background_omitted: "Background was intentionally omitted.",
  no_spatial_input: "There are no usable coordinates or bounds to draw.",
  unsupported_text: "The bundled font cannot draw every label; the complete text is retained.",
  render_budget: "The complete drawing and legend exceed the image budget; the complete text is retained.",
  renderer_unavailable: "The local image renderer is unavailable; source and text evidence is retained.",
};
const MAX_PIXELS = 32_000_000, MAX_HEIGHT = 16_384, MAX_SVG_BYTES = 16 * 1024 * 1024;
const coordinate = (p: { lat: number; lon: number }) => `${p.lat}, ${p.lon}`;
const human = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const measure = (value: number | null, unit: string) => value === null ? `unknown ${unit}` : `${Number(value.toFixed(2))} ${unit}`;
const hasGeometry = (result: CoastlineServiceResult | null): boolean => !!result?.value &&
  [result.value.coastline, result.value.land, result.value.roads, result.value.streets].some(lines => lines.some(line => line.length >= 2));
const label = (value: string, max: number): string => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Map labels must be bounded text without controls.");
  return value;
};

function textEvidence(result: StaticMapResult): string {
  const lines = [result.title, result.kind === "geometry" ? "Vector background with source geometry." : result.kind === "none"
    ? "No map image; source and text evidence follows." : "Track-only / plain coordinate surface; no complete background is claimed."];
  if (result.reason) lines.push(REASONS[result.reason]);
  if (result.bounds) lines.push(`Bounds (west, south, east, north): ${result.bounds.join(", ")}.`);
  if (result.method.scale) lines.push(`Scale: ${measure(result.method.scale.value, "m")} at latitude ${result.method.scale.latitude.toFixed(4)} degrees.`);
  for (const track of result.tracks) {
    const s = track.summary;
    lines.push(`Track ${track.index}: ${track.label}; ${s.status}. File: ${s.source.path}; file evidence does not prove travel.`,
      `${s.partial ? "Partial usable sections" : "Usable sections"}: ${s.counts.retained}/${s.counts.input} points, ${s.counts.omitted} omitted, ${s.counts.segments} sections; ${track.croppedPoints} retained vertices outside viewport.`,
      `Distance ${measure(s.measurements.distance.value, "m")}; ascent ${measure(s.measurements.ascent.value, "m")}; descent ${measure(s.measurements.descent.value, "m")}; elapsed ${measure(s.measurements.elapsed.value, "s")}; moving time unknown.`,
      `Start ${s.start ? coordinate(s.start) : "unknown"}; end ${s.end ? coordinate(s.end) : "unknown"}.`,
      ...s.unknown.map(value => `${human(value.field)}: ${human(value.reason)}.`),
      ...track.summary.warnings,
      ...(s.source.recordingClaim ? [`Recording claim (unverified): ${s.source.recordingClaim.text}.`] : []));
    if (track.omissions.length) lines.push(`Omitted source points: ${track.omissions.map(value => `Point ${value.index + 1}: ${value.reasons.join(", ").replaceAll("_", " ")}`).join("; ")}. Original file remains authoritative.`);
  }
  for (const pin of result.pins) lines.push(`Stop ${pin.index}: ${pin.label}. Coordinates ${coordinate(pin)}. ${pin.drawn ? "Drawn" : `Undrawn (${human(pin.reason!)})`}.`);
  for (let index = 0; index < result.routes.length; index++) {
    const route = result.routes[index]!;
    lines.push(`Calculated route ${index + 1}: ${route.request.mode}; ${route.status}.`);
    route.request.points.forEach((point, stop) => lines.push(`Route ${index + 1} stop ${stop + 1}: ${coordinate(point)}.`));
    if (route.source) lines.push(`Routing source ${route.source.endpoint}; dataset ${route.source.dataset.name}; prepared mode ${route.source.dataset.preparedMode}; profile ${route.source.dataset.profile}; verified by ${route.source.dataset.verification}.`,
      `Fetched ${route.source.fetchedAt ?? "unknown"}; fallback ${route.source.fallback.used ? `used (${route.source.fallback.reason})` : "not used"}.`);
    if (route.error) lines.push(`Route error: ${route.error.code}; ${route.error.message}`);
    lines.push(...route.warnings);
  }
  for (const leg of result.legs) lines.push(`Route ${leg.route} leg ${leg.index}: ${coordinate(leg.from)} to ${coordinate(leg.to)}; ${leg.available ? "calculated geometry available" : "route unavailable"}; distance ${measure(leg.distanceM, "m")}; duration ${measure(leg.durationS, "s")}.`);
  if (result.background?.source) lines.push(`Background source ${result.background.source.endpoint}; fetched ${result.background.source.fetchedAt ?? "unknown"}.`);
  if (result.background) {
    result.background.queries.forEach(query => {
      const source = query.result.source;
      lines.push(`Background layer ${query.layer}: ${query.result.status}; ${source?.endpoint ?? "no service source"}; fetched ${source?.fetchedAt ?? "unknown"}; fallback ${source?.fallback.used ? `used (${source.fallback.reason})` : "not used"}.`);
    });
    lines.push(...result.background.warnings);
  }
  lines.push(...result.attribution.map(value => `${value.text} - ${value.url}`), ...result.warnings);
  return lines.join("\n");
}

/** Resolve concrete vector evidence first, then rasterize locally. No browser, raster tiles or navigation. */
export async function staticMap(input: StaticMapInput, client: GeoClient): Promise<StaticMapResult> {
  // Snapshot all supplied evidence before an await; rendering never mutates original geometry or summaries.
  let requestedPoints = (input.pins?.length ?? 0);
  for (const track of input.tracks ?? []) {
    requestedPoints += track.track.omissions.length;
    for (const section of track.track.segments) requestedPoints += section.length;
  }
  for (const route of input.routes ?? []) {
    requestedPoints += route.request.points.length;
    for (const section of route.value?.geometry ?? []) requestedPoints += section.length;
  }
  if (requestedPoints > 200_000) throw new Error("Map input exceeds 200000 source geometry/stop points, including omissions.");
  const snapshot = structuredClone(input);
  const tracks = snapshot.tracks ?? [], pins = snapshot.pins ?? [], routes = snapshot.routes ?? [];
  if (tracks.length > 100 || pins.length > 1_000 || routes.length > 100) throw new Error("Map input exceeds its track/stop/route resource limit.");
  const title = label(snapshot.title ?? "Route and stops", 500), width = snapshot.widthPx ?? 1_024;
  if (!Number.isInteger(width) || width < 320 || width > 2_048) throw new Error("Map width must be an integer from 320 to 2048 pixels.");
  const points: { lat: number; lon: number }[] = [];
  const result: StaticMapResult = { status: "no_map", kind: "none", reason: null, png: null, svg: null, widthPx: width, heightPx: null,
    title, bounds: null, text: "", tracks: [], pins: [], legs: [], routes, background: null, attribution: [], warnings: [],
    method: { projection: "spherical_web_mercator", line: "source_vertices_in_mercator", latitudeLimit: MAX_MAP_LAT, scale: null,
      text: "bundled_ibm_plex_glyph_outlines", gaps: "preserved" } };
  const finishWithoutImage = (reason: StaticMapReason) => {
    result.kind = "none"; result.status = "no_map"; result.reason = reason; result.png = null; result.svg = null; result.heightPx = null;
    result.pins.forEach(pin => { pin.drawn = false; pin.reason = "no_artifact"; }); result.text = textEvidence(result); return result;
  };
  tracks.forEach((item, index) => {
    const summary = summarizeTrack(item.track, item.source);
    label(item.source.path, 4_096); if (item.source.recordingClaim) label(item.source.recordingClaim.text, 2_000);
    const retained = summary.geometry.flat();
    retained.forEach(p => routePoint(p.lat, p.lon));
    if (retained.length !== summary.counts.retained) throw new Error("Map track retained count does not match its geometry.");
    for (const point of retained) points.push(point);
    result.tracks.push({ index: index + 1, label: label(item.label ?? `Track ${index + 1}`, 1_000), summary, omissions: item.track.omissions, visiblePoints: 0, croppedPoints: 0 });
  });
  pins.forEach((pin, index) => {
    routePoint(pin.lat, pin.lon); points.push(pin);
    result.pins.push({ ...pin, label: label(pin.label, 1_000), index: index + 1, drawn: false, reason: "no_artifact" });
  });
  routes.forEach((route, index) => {
    route.request.points.forEach(p => { routePoint(p.lat, p.lon); points.push(p); });
    route.value?.geometry.forEach(section => section.forEach(p => { routePoint(p.lat, p.lon); points.push(p); }));
    for (let leg = 0; leg < route.request.points.length - 1; leg++) {
      const value = route.value?.legs[leg];
      result.legs.push({ route: index + 1, index: leg + 1, mode: route.request.mode,
        from: { ...route.request.points[leg]! }, to: { ...route.request.points[leg + 1]! }, available: !!route.value,
        distanceM: value?.distanceM ?? null, durationS: value?.durationS ?? null });
    }
  });
  const representedStops = new Set(result.pins.map(pin => coordinate(pin)));
  routes.forEach((route, index) => route.request.points.forEach((point, stop) => {
    const key = coordinate(point);
    if (!representedStops.has(key)) {
      result.pins.push({ ...point, label: `Route ${index + 1} stop ${stop + 1}`, index: result.pins.length + 1, drawn: false, reason: "no_artifact" });
      representedStops.add(key);
    }
  }));
  if (points.length > 200_000) throw new Error("Map input exceeds 200000 retained geometry/stop points.");
  if (!points.length && !snapshot.bbox) return finishWithoutImage("no_spatial_input");
  let bounds: BBox;
  if (snapshot.bbox) {
    bounds = [...snapshot.bbox];
    if (bounds.length !== 4) throw new Error("Map bounds need west,south,east,north.");
    routePoint(bounds[1], bounds[0]); routePoint(bounds[3], bounds[2]);
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error("Map bounds must be ordered and nonempty.");
  } else {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const p of points) { west = Math.min(west, p.lon); east = Math.max(east, p.lon); south = Math.min(south, p.lat); north = Math.max(north, p.lat); }
    // Source limits are checked before deriving any viewport; valid polar data stays in the text/source fallback.
    if (south < -MAX_MAP_LAT || north > MAX_MAP_LAT || east - west > 180) return finishWithoutImage("unsupported_projection");
    const lonPad = Math.max(0.0005, (east - west) * 0.04), latPad = Math.max(0.0005, (north - south) * 0.04);
    bounds = [west - lonPad, south - latPad, east + lonPad, north + latPad];
  }
  result.bounds = bounds;
  if (bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -MAX_MAP_LAT || bounds[3] > MAX_MAP_LAT || bounds[2] - bounds[0] > 180
    || points.some(p => Math.abs(p.lat) > MAX_MAP_LAT) || routes.some(route => route.value?.geometry.some(section => section.some((p, i) => i > 0 && Math.abs(p.lon - section[i - 1]!.lon) > 180)))
    || tracks.some(item => item.track.segments.some(section => section.some((p, i) => i > 0 && Math.abs(p.lon - section[i - 1]!.lon) > 180)))) {
    return finishWithoutImage("unsupported_projection");
  }

  const wide = bounds[2] - bounds[0] > 5 || bounds[3] - bounds[1] > 5;
  if (snapshot.background !== "none" && !wide) {
    result.background = typeof snapshot.background === "object" ? snapshot.background : await client.coastline({ bbox: bounds, widthPx: width });
  }
  if (result.background?.value) {
    let vertices = 0, ways = 0;
    for (const layer of [result.background.value.coastline, result.background.value.land, result.background.value.roads, result.background.value.streets]) {
      ways += layer.length;
      if (ways > 10_000) throw new Error("Prefetched map background exceeds its geometry budget.");
      for (const line of layer) {
        vertices += line.length;
        if (vertices > 200_000) throw new Error("Prefetched map background exceeds its geometry budget.");
        for (const [lon, lat] of line) {
          routePoint(lat, lon);
          if (Math.abs(lat) > MAX_MAP_LAT) return finishWithoutImage("unsupported_projection");
        }
      }
    }
  }
  result.kind = hasGeometry(result.background) ? "geometry" : "track_only";
  result.reason = result.kind === "geometry" ? null : wide ? "background_extent" : snapshot.background === "none" ? "background_omitted" : "background_unavailable";
  result.status = result.kind === "geometry" && result.background!.status === "ok" && !result.background!.value!.partial ? "ok" : "partial";
  if (result.tracks.some(track => track.summary.partial) || routes.some(route => route.status !== "ok")) result.status = "partial";
  const attribution = [...(hasGeometry(result.background) ? result.background!.attribution : []), ...routes.flatMap(route => route.value ? route.attribution : [])];
  result.attribution = attribution.filter((value, index) => attribution.findIndex(other => other.text === value.text && other.url === value.url) === index);
  if (result.attribution.some(value => value.url === "https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/")) {
    result.attribution.push({ text: "Graphics: CC BY-SA (FOSSGIS service terms)", url: "https://creativecommons.org/licenses/by-sa/2.0/" });
  }
  result.warnings.push("Drawing connects source vertices in Web Mercator; track measurements use unsimplified great-circle sections.",
    "Scale applies at the viewport center latitude; distortion increases away from that latitude.",
    "S and E identify each retained section's start/end; disconnected sections are never joined.",
    "Combined stop markers show the first stop number and an additional-stop count; the legend names every stop.");

  let fonts: Awaited<ReturnType<typeof mapFonts>>;
  try { fonts = await mapFonts(); } catch { return finishWithoutImage("renderer_unavailable"); }
  const textLines: MapTextLine[] = [];
  let baseline = 44;
  let renderBudget = false;
  const add = (text: string, size = 14, medium = false, ink = INK) => {
    if (renderBudget) return;
    for (const line of wrapMapText(medium ? fonts.medium : fonts.regular, text, size, width - 48)) {
      textLines.push({ text: line, x: 24, baseline, size, medium, ink }); baseline += size * 1.45;
      if (baseline > MAX_HEIGHT || width * baseline > MAX_PIXELS) { renderBudget = true; return; }
    }
  };
  add(title, 25, true);
  add(result.kind === "geometry" ? "Vector geometry - source routes and numbered stops" : "Track-only / plain coordinate surface", 14, false, MUTED);
  const viewport = mapViewport(bounds, width, Math.ceil(baseline + 12));
  result.method.scale = viewport.scale;
  result.tracks.forEach(track => {
    track.visiblePoints = track.summary.geometry.flat().filter(p => viewport.contains(p)).length;
    track.croppedPoints = track.summary.counts.retained - track.visiblePoints;
  });
  result.pins.forEach(pin => { pin.drawn = viewport.contains(pin); pin.reason = pin.drawn ? null : "outside_viewport"; });
  if (result.tracks.some(track => track.croppedPoints > 0) || result.pins.some(pin => !pin.drawn)) {
    result.status = "partial"; result.warnings.push("The explicit viewport crops source geometry/stops; complete coordinates remain in the source/text evidence.");
  }
  baseline = viewport.frame.y + viewport.frame.height + 29;
  add(`Scale at ${viewport.scale.latitude.toFixed(3)} degrees latitude: ${measure(viewport.scale.value, "m")}. North is up.`, 13, false, MUTED);
  baseline += 14; add("Sources, stops and legs", 18, true);
  result.text = textEvidence(result);
  if (result.text.length > 200_000) return finishWithoutImage("render_budget");
  // The entire equivalent, including every absent route leg/undrawn stop, is laid out without ellipsis.
  result.text.split("\n").slice(1).forEach(line => {
    const track = /^Track (\d+):/.exec(line), route = /^Calculated route (\d+):/.exec(line);
    const color = track ? COLORS[(Number(track[1]) - 1) % COLORS.length] : route ? COLORS[(tracks.length + Number(route[1]) - 1) % COLORS.length] : undefined;
    add(line, 14, !!color, color ?? INK);
  });
  const height = Math.ceil(baseline + 20);
  if (renderBudget || height > MAX_HEIGHT || width * height > MAX_PIXELS) return finishWithoutImage("render_budget");
  if (textLines.some(line => [...line.text].some(char => !fonts.regular.hasGlyphForCodePoint(char.codePointAt(0)!)))) return finishWithoutImage("unsupported_text");
  const { frame } = viewport;
  let drawing = `<rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" fill="#ffffff" stroke="#a8a49e"/>`;
  const parts: string[] = [];
  const markers: string[] = [];
  const endpoints: { x: number; y: number; mark: string; color: string }[] = [];
  if (hasGeometry(result.background)) parts.push(backgroundSvg(result.background!.value!, viewport));
  for (let n = 1; n < 5; n++) {
    const lon = bounds[0] + (bounds[2] - bounds[0]) * n / 5, lat = bounds[1] + (bounds[3] - bounds[1]) * n / 5;
    const [x] = viewport.point({ lon, lat: bounds[1] }), [, y] = viewport.point({ lat, lon: bounds[0] });
    parts.push(`<path d="M${x},${frame.y}V${frame.y + frame.height}M${frame.x},${y}H${frame.x + frame.width}" fill="none" stroke="#a6c0bb" stroke-width="0.6"/>`);
  }
  const section = (coords: Coord[], id: string, color: string, calculated: boolean) => {
    if (!coords.length) return;
    if (coords.length === 1) {
      const [x, y] = viewport.point({ lon: coords[0]![0], lat: coords[0]![1] });
      parts.push(`<circle id="${id}-point" cx="${x}" cy="${y}" r="3" fill="${color}"/>`);
      return;
    }
    parts.push(`<path id="${id}" d="${mapPath(coords, viewport)}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"${calculated ? ' stroke-dasharray="8 4"' : ""}/>`);
    for (const [point, mark] of [[coords[0]!, "S"], [coords.at(-1)!, "E"]] as const) {
      const p = { lon: point[0], lat: point[1] }; if (!viewport.contains(p)) continue;
      const [x, y] = viewport.point(p);
      markers.push(`<circle cx="${x}" cy="${y}" r="6" fill="${mark === "S" ? "#ffffff" : color}" stroke="${color}" stroke-width="2"/>`);
      endpoints.push({ x, y, mark, color });
    }
  };
  result.tracks.forEach((track, index) => track.summary.geometry.forEach((line, part) => section(line.map(p => [p.lon, p.lat]), `track-${index + 1}-section-${part + 1}`, COLORS[index % COLORS.length]!, false)));
  routes.forEach((route, index) => route.value?.geometry.forEach((line, part) => section(line.map(p => [p.lon, p.lat]), `route-${index + 1}-section-${part + 1}`, COLORS[(tracks.length + index) % COLORS.length]!, true)));
  const clusters: { x: number; y: number; members: number[] }[] = [];
  for (const pin of result.pins.filter(value => value.drawn)) {
    const [x, y] = viewport.point(pin), existing = clusters.find(cluster => Math.hypot(cluster.x - x, cluster.y - y) < 32);
    if (existing) existing.members.push(pin.index); else clusters.push({ x, y, members: [pin.index] });
  }
  const occupied: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const cluster of clusters) {
    const number = cluster.members.length > 1 ? `${cluster.members[0]}+${cluster.members.length - 1}` : String(cluster.members[0]);
    const size = number.length > 4 ? 10 : 13, advance = textWidth(fonts.medium, number, size), badgeWidth = Math.max(32, advance + 14);
    markers.push(`<rect x="${cluster.x - badgeWidth / 2}" y="${cluster.y - 16}" width="${badgeWidth}" height="32" rx="16" fill="${INK}" stroke="#ffffff" stroke-width="2" data-stops="${cluster.members.join(",")}"/>`);
    markers.push(mapText(fonts.medium, { text: number, x: cluster.x - advance / 2, baseline: cluster.y + 4.5, size, medium: true, ink: "#ffffff" }));
    occupied.push({ left: cluster.x - badgeWidth / 2 - 3, right: cluster.x + badgeWidth / 2 + 3, top: cluster.y - 19, bottom: cluster.y + 19 });
  }
  for (const endpoint of endpoints) {
    const advance = textWidth(fonts.medium, endpoint.mark, 12);
    const candidates = [18, 30, 44].flatMap(offset => [[offset, -offset], [-offset, -offset], [offset, offset], [-offset, offset]]);
    const positions = candidates.map(([dx, dy]) => ({ left: endpoint.x + dx! - advance / 2, right: endpoint.x + dx! + advance / 2,
      top: endpoint.y + dy! - 10, bottom: endpoint.y + dy! + 3 }));
    const position = positions.find(p => p.left >= frame.x && p.right <= frame.x + frame.width && p.top >= frame.y && p.bottom <= frame.y + frame.height
      && occupied.every(other => p.right < other.left || p.left > other.right || p.bottom < other.top || p.top > other.bottom)) ?? positions[0]!;
    occupied.push(position);
    markers.push(mapText(fonts.medium, { text: endpoint.mark, x: position.left, baseline: position.top + 10, size: 12, medium: true, ink: endpoint.color }));
  }
  drawing += `<g clip-path="url(#map-frame)">${parts.join("")}</g>${markers.join("")}`;
  const scaleX = frame.x + 16, scaleY = frame.y + frame.height - 18;
  drawing += `<rect x="${scaleX - 8}" y="${scaleY - 14}" width="${viewport.scale.lengthPx + 16}" height="23" fill="#ffffff"/>`
    + `<path id="map-scale" d="M${scaleX},${scaleY - 5}V${scaleY}H${scaleX + viewport.scale.lengthPx}V${scaleY - 5}" stroke="${INK}" fill="none" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xml(title)}</title><desc>${xml(result.text)}</desc><rect width="100%" height="100%" fill="#ffffff"/><defs><clipPath id="map-frame"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/></clipPath></defs>${drawing}${textLines.map(line => mapText(line.medium ? fonts.medium : fonts.regular, line)).join("")}</svg>`;
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) return finishWithoutImage("render_budget");
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const renderer = new Resvg(svg, { font: { loadSystemFonts: false }, shapeRendering: 2, textRendering: 2, logLevel: "off" });
    if (renderer.imagesToResolve().length) throw new Error("Map rasterization must not resolve external images.");
    const png = renderer.render().asPng();
    if (png.byteLength > 64 * 1024 * 1024) return finishWithoutImage("render_budget");
    result.png = png; result.svg = svg; result.heightPx = height; return result;
  } catch { return finishWithoutImage("renderer_unavailable"); }
}
