import { z } from "zod";
import { geoConfigSchema, type GeoConfig } from "../config.js";
import { OSM_ATTRIBUTION, detailFor, prepare, prepareLand, toleranceMetres,
  type CoastlineConfig, type CoastlineRequest, type CoastlineResult, type Coord } from "../coastline.js";
import { routePoint } from "../track.js";
import type { GeoResult } from "./client.js";
import { GeoReplyError, GeoTransport, type GeoError } from "./io.js";
import { overpassElements, queryOverpass, type OverpassResult } from "./overpass.js";

export type CoastlineLayer = "coastline" | "roads" | "streets";
export interface CoastlineLayerGeometry {lines: Coord[][]; input: number; omitted: number}
export interface CoastlineServiceResult extends GeoResult<CoastlineResult> {
  /** Each layer retains its own served source, fallback and every transfer attempt. */
  queries: {layer: CoastlineLayer; result: OverpassResult<CoastlineLayerGeometry>}[];
}
const MAJOR_ROADS = '["highway"~"^(motorway|trunk|primary|secondary)$"]';
const MINOR_STREETS = '["highway"~"^(tertiary|unclassified|residential|living_street|pedestrian)$"]';
const empty = (): CoastlineResult => ({coastline: [], roads: [], streets: [], land: [], detail: "coast", partial: false, toleranceM: 0, attribution: OSM_ATTRIBUTION});
const waySchema = z.object({type: z.literal("way"), geometry: z.array(z.object({lat: z.number(), lon: z.number()})).min(2)});

function decodeLines(raw: unknown): CoastlineLayerGeometry {
  const elements = overpassElements(raw), lines: Coord[][] = [];
  if (elements.length > 10_000) throw new GeoReplyError({code: "response_limit", message: "Background reply exceeds 10,000 ways."});
  let points = 0, omitted = 0;
  for (const rawWay of elements) {
    if (typeof rawWay === "object" && rawWay !== null && "geometry" in rawWay && Array.isArray(rawWay.geometry)) points += rawWay.geometry.length;
    if (points > 200_000) throw new GeoReplyError({code: "response_limit", message: "Background reply exceeds 200,000 vertices."});
    try {
      const way = waySchema.parse(rawWay);
      lines.push(way.geometry.map(p => {const point = routePoint(p.lat, p.lon); return [point.lon, point.lat] as Coord;}));
    } catch (error) {
      if (error instanceof GeoReplyError) throw error;
      omitted++;
    }
  }
  if (elements.length && !lines.length) throw new Error("No usable background geometry in a nonempty reply.");
  return {lines, input: elements.length, omitted};
}

/** The existing pure geometry pipeline, with shared cache/admission and layer-level evidence. */
export async function coastlineGeometry(config: GeoConfig, transport: GeoTransport, input: CoastlineRequest): Promise<CoastlineServiceResult> {
  const queries: CoastlineServiceResult["queries"] = [];
  const failed = (error: GeoError): CoastlineServiceResult => ({status: error.code === "disabled" ? "disabled" : "error", value: null,
    source: null, error, warnings: [], attribution: [], queries});
  let request: CoastlineRequest;
  try {
    const bbox = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).parse(input.bbox);
    const [west, south, east, north] = bbox;
    routePoint(south, west); routePoint(north, east);
    if (west >= east || south >= north || east - west > 5 || north - south > 5) throw new Error("Background queries need ordered bounds spanning at most 5 degrees per axis.");
    request = {bbox, widthPx: z.number().finite().positive().max(16_384).parse(input.widthPx),
      detail: input.detail === undefined ? detailFor(bbox, input.widthPx) : z.enum(["coast", "roads", "streets"]).parse(input.detail)};
  } catch { return failed({code: "input", message: "Invalid or oversized background geometry request; source coordinates remain unchanged."}); }
  const [west, south, east, north] = request.bbox;
  const bbox = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  const layers: [CoastlineLayer, string][] = [["coastline", '["natural"="coastline"]'],
    ...(request.detail === "coast" ? [] : [["roads", MAJOR_ROADS]] as [CoastlineLayer, string][]),
    ...(request.detail === "streets" ? [["streets", MINOR_STREETS]] as [CoastlineLayer, string][] : [])];
  const raw: Record<CoastlineLayer, Coord[][]> = {coastline: [], roads: [], streets: []};
  let partial = false, refusal = false, lastError: GeoError | null = null;
  for (const [layer, selector] of layers) {
    if (refusal) break;
    const query = `[out:json][timeout:${Math.max(1, Math.ceil(config.timeoutMs / 1_000))}][maxsize:33554432];way${selector}(${bbox});out geom;`;
    const result = await queryOverpass(config, transport, query, decodeLines);
    if (result.value) {
      raw[layer] = result.value.lines;
      if (result.value.omitted) {partial = true; result.status = "partial"; result.counts = {input: result.value.input, retained: result.value.lines.length, omitted: result.value.omitted};}
    }
    if (result.error) {
      partial = true; lastError = result.error;
      refusal = ["disabled", "configuration", "input", "ineligible", "admission_denied", "admission_timeout", "cache_unavailable"].includes(result.error.code);
    }
    queries.push({layer, result});
  }
  const value: CoastlineResult = {coastline: prepare(raw.coastline, request), roads: prepare(raw.roads, request), streets: prepare(raw.streets, request),
    land: prepareLand(raw.coastline, request, {onLand: [...raw.roads, ...raw.streets]}), detail: request.detail!, partial,
    toleranceM: toleranceMetres(request.bbox, request.widthPx), attribution: OSM_ATTRIBUTION};
  const usable = value.coastline.length || value.roads.length || value.streets.length || value.land.length;
  const success = queries.filter(q => !q.result.error), last = success.at(-1) ?? queries.at(-1);
  const attribution = [...new Map(success.flatMap(q => q.result.attribution).map(a => [a.url, a])).values()];
  return {status: lastError && !usable ? lastError.code === "disabled" ? "disabled" : "error" : partial ? "partial" : usable ? "ok" : "no_match",
    value: lastError && !usable ? null : value, source: last?.result.source ?? null, error: lastError && !usable ? lastError : null, queries, attribution,
    warnings: [...queries.flatMap(q => q.result.warnings), ...(partial ? ["Background geometry is partial; missing or refused layers were not fabricated."] : [])]};
}

/** SDK-compatible result-or-empty wrapper; canonical configuration can be injected additively. */
export async function fetchCoastline(request: CoastlineRequest, config: CoastlineConfig): Promise<CoastlineResult> {
  if (!config.enabled) return empty();
  try {
    const canonical = geoConfigSchema.parse(config.geo ?? {userAgent: config.userAgent, timeoutMs: config.timeoutMs ?? 8_000,
      overpass: {enabled: config.enabled, endpoints: [config.url]}});
    const result = await coastlineGeometry(canonical, new GeoTransport(canonical, {fetchImpl: config.fetchImpl, admissionDir: config.admissionDir}), request);
    return result.value ?? {...empty(), detail: request.detail ?? detailFor(request.bbox, request.widthPx), partial: result.status !== "disabled",
      toleranceM: toleranceMetres(request.bbox, request.widthPx)};
  } catch { return {...empty(), partial: true}; }
}
