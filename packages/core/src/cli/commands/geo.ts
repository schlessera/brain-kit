import { basename, dirname, extname, join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { MAX_ROUTE_BYTES } from "@schlessera/brain-geo/internal";
import { nearestTrackPoint, parseTrackGpx, routePoint, summarizeTrack, trackCoverage,
  type NearestTrackPoint, type ParsedTrack, type TrackCoverage, type TrackSummary, type RoutingMode } from "@schlessera/brain-geo";
import { GeoClient, type GeoResult, type GeocodeCandidate, type PoiResult, type RoutingResult,
  type StaticMapInput, type StaticMapPin, type StaticMapResult } from "@schlessera/brain-geo/server";
import { resolveGeoConfig } from "../../lib/geo-config.js";
import { safeResolve, resolveWritable, writeFileSafely } from "../../lib/safe-path.js";
import { assertScratchWritable, isInScratch, isWriteRefusal, pruneScratch, writeScratchFile } from "../../lib/scratch.js";
import { parseArgs, UsageError, type Flags } from "../io.js";
import type { CliContext, CoreCommand } from "../types.js";

export type GeoGeocodeOutput = GeoResult<GeocodeCandidate[]> &
  ({ operation: "geocode"; request: { query: string } } | { operation: "reverse"; request: { lat: number; lon: number } });
export type GeoRouteOutput = RoutingResult & { operation: "route" };
export type GeoPoiOutput = PoiResult & { operation: "poi"; sourceFile: string | null };
export interface GeoTrackOutput extends TrackSummary {
  operation: "track";
  omissions: ParsedTrack["omissions"];
  nearest: NearestTrackPoint | null;
  comparison: { summary: TrackSummary; omissions: ParsedTrack["omissions"]; coverage: TrackCoverage } | null;
}
export type GeoMapOutput = Omit<StaticMapResult, "png" | "svg"> & { operation: "map";
  artifact: { path: string; format: "png"; bytes: number } | null };

const HELP = `brain geo <geocode|route|poi|track|map> — shared geo operations

Coordinates are latitude,longitude in every CLI argument; bounds are
west,south,east,north. Decimal numbers are finite and source coordinates stay intact.

  geocode <query>                 Forward lookup; ambiguity remains visible.
  geocode --reverse <lat,lon>      Reverse lookup; address accuracy stays unknown.
  route <lat,lon>... --mode <car|foot|bike>
                                 Ordered stops through a verified prepared dataset.
  poi --near <lat,lon> | --along <file.gpx>
      --radius-m <metres> --tag <key[=value]>...
                                 Exact AND tags; a bare key means presence.
  track <file.gpx> [--near <lat,lon>] [--compare <file.gpx>]
      [--tolerance-m <metres>] [--sample-spacing-m <metres>]
                                 Recovered usable-section summary. Near/compare
                                 require tolerance; spacing requires compare.
  map [file.gpx...] [--pin <lat,lon,label>]...
      [--point <lat,lon>]... [--mode <car|foot|bike>]
      [--bbox <west,south,east,north>] [--title <text>] [--width <pixels>]
      [--no-background] --out <file.png>
                                 Resolve optional routing/background first, then
                                 rasterize locally. Width 320–2048, default 1024.

Files and output must remain inside the brain, including through symlinks.
Map needs an initialized brain; a chosen --out replaces an existing regular file.
Geo config sets endpoints, identifying User-Agent, eligibility and disposable cache.
Every new service is off by default. No implicit public request or route substitute.

--json emits one document with operation and the full shared result. Track includes
omissions/nullable proximity; map includes artifact {path,format,bytes} or null,
complete source/text/legend and kind/reason, with no embedded PNG/SVG bytes.
--human prints source, unknowns, partial status and applicable attribution.
Exit 0: valid result/fallback; 1: usage/input; 2: service/storage/renderer failure.`;
const OPTIONS: Record<string, string[]> = {
  geocode: ["reverse"], route: ["mode"], poi: ["near", "along", "radius-m", "tag"],
  track: ["near", "compare", "tolerance-m", "sample-spacing-m"],
  map: ["pin", "point", "mode", "bbox", "title", "width", "no-background", "out"],
};
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
function numeric(value: string, name: string): number {
  if (!decimal.test(value.trim()) || !Number.isFinite(Number(value))) throw new UsageError(`${name} needs a finite decimal number.`);
  return Number(value);
}
function point(value: string): { lat: number; lon: number } {
  const parts = value.split(",");
  if (parts.length !== 2) throw new UsageError("Coordinates need latitude,longitude.");
  try { const p = routePoint(numeric(parts[0]!, "Latitude"), numeric(parts[1]!, "Longitude")); return { lat: p.lat, lon: p.lon }; }
  catch (error) { throw new UsageError((error as Error).message); }
}
function option(flags: Flags, name: string, required = false): string | undefined {
  const value = flags[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.length) throw new UsageError(`--${name} requires a value.`);
  return value;
}
function repeated(argv: string[], name: string): string[] {
  const end = argv.indexOf("--"), before = end === -1 ? argv : argv.slice(0, end), values: string[] = [];
  for (let index = 0; index < before.length; index++) if (before[index] === `--${name}`) {
    const value = before[++index];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} requires a value.`);
    values.push(value);
  }
  return values;
}
function mode(flags: Flags): RoutingMode {
  const value = option(flags, "mode", true);
  if (value !== "car" && value !== "foot" && value !== "bike") throw new UsageError("--mode must be car, foot or bike.");
  return value;
}
function usage<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw new UsageError((error as Error).message); }
}
async function readTrack(root: string, path: string): Promise<{ track: ParsedTrack; summary: TrackSummary }> {
  const absolute = safeResolve(root, path);
  if (!absolute) throw new UsageError(`Track path must remain inside the brain: ${path}`);
  const file = Bun.file(absolute);
  if (!await file.exists()) throw new UsageError(`Track file does not exist: ${path}`);
  if (file.size > MAX_ROUTE_BYTES) throw new UsageError("Track input exceeds 20 MiB.");
  const source = await file.text(), track = usage(() => parseTrackGpx(source));
  return { track, summary: summarizeTrack(track, { kind: "file", path: relative(realpathSync(root), absolute).split("\\").join("/") }) };
}
function serviceCode(result: { status: string; error: { code: string } | null }): number {
  if (result.error?.code === "input") return 1;
  return result.status === "error" || result.status === "disabled" ? 2 : 0;
}
const measured = (value: number | null, unit: string) => value === null ? "unknown" : `${value} ${unit}`;
function serviceLines(result: GeoResult<unknown>): string[] {
  const lines = [`Status: ${result.status}`];
  if (result.source) lines.push(`Source: ${result.source.endpoint}; fetched ${result.source.fetchedAt ?? "unknown"}; cache ${result.source.fromCache ? "hit" : "miss"}; age ${measured(result.source.cacheAgeMs, "ms")}; transfer ${result.source.transfer.data} ${result.source.transfer.sent ? "sent" : "not sent"}.`);
  if (result.error) lines.push(`Error: ${result.error.code}; ${result.error.message}`);
  lines.push(...result.warnings, ...result.attribution.map(attribution => `${attribution.text} - ${attribution.url}`));
  return lines;
}
function attemptLines(result: RoutingResult | PoiResult): string[] {
  return result.attempts.map((attempt, index) => `Attempt ${index + 1}: ${attempt.endpoint}; cache ${attempt.fromCache ? "hit" : "miss"}; geometry/coordinates ${attempt.requestSent ? "sent" : "not sent"}; ${attempt.error ? `${attempt.error.code}: ${attempt.error.message}` : "usable reply"}.`);
}
function trackText(result: GeoTrackOutput): string {
  const lines = [`Track: ${result.source.path}; ${result.status}; file evidence does not prove travel.`,
    `Counts: ${result.counts.retained}/${result.counts.input} retained, ${result.counts.omitted} omitted, ${result.counts.segments} usable sections.`];
  for (const [name, value] of Object.entries(result.measurements)) lines.push(`${name === "movingTime" ? "Moving time" : name}: ${measured(value.value, value.unit)}; usable sections.`);
  lines.push(`Distance model: great-circle segments on a ${result.method.earthRadiusM} m sphere; gaps excluded. Elevation: three-point median and 3 m hysteresis; complete data required.`);
  for (const omission of result.omissions) lines.push(`Point ${omission.index + 1} omitted: ${omission.reasons.join(", ")}.`);
  for (const value of result.unknown) lines.push(`${value.field}: ${value.reason}.`);
  lines.push(...result.warnings);
  if (result.nearest) lines.push(`Nearest: ${measured(result.nearest.distance.value, "m")}; tolerance ${result.nearest.method.toleranceM} m; ${result.nearest.status}; ${result.nearest.unknown.join(", ")}.`);
  if (result.comparison) lines.push(`Coverage of this track relative to ${result.comparison.summary.source.path}: ${measured(result.comparison.coverage.ratio, "ratio")}; tolerance ${result.comparison.coverage.method.toleranceM} m; ${result.comparison.coverage.status}; ${result.comparison.coverage.unknown.join(", ")}.`);
  return lines.join("\n");
}
/** Await the complete pipe write before this command resolves, including outside the bin. */
async function emitGeo(json: boolean, data: unknown, human: () => string): Promise<void> {
  const text = (json ? JSON.stringify(data, null, 2) : human()) + "\n";
  await new Promise<void>((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve()));
}

export const geoCommand: CoreCommand = {
  summary: "Geocode, route, find POIs, measure tracks and export static maps",
  helpBlock: HELP,
  async run(argv, cli) {
    const { args, flags } = parseArgs(argv), operation = args.shift();
    if (!operation || !OPTIONS[operation]) throw new UsageError("Use brain geo geocode, route, poi, track or map; see --help.");
    const allowed = new Set(["json", "human", "help", ...OPTIONS[operation]!]);
    for (const flag of Object.keys(flags)) if (!allowed.has(flag)) throw new UsageError(`--${flag} is not an option for geo ${operation}.`);
    const geo = () => new GeoClient(resolveGeoConfig(cli.brain.root, cli.brain.config));
    if (operation === "geocode") {
      const reverse = option(flags, "reverse");
      if (reverse !== undefined && args.length) throw new UsageError("Choose a forward query or --reverse coordinates.");
      if (reverse === undefined && !args.length) throw new UsageError("Geocode needs a query or --reverse coordinates.");
      const query = args.join(" "), coordinates = reverse === undefined ? null : point(reverse);
      const output: GeoGeocodeOutput = coordinates ? { operation: "reverse", request: coordinates, ...await geo().reverse(coordinates.lat, coordinates.lon) }
        : { operation: "geocode", request: { query }, ...await geo().geocode(query) };
      await emitGeo(cli.json, output, () => [...serviceLines(output), ...(output.value ?? []).map(candidate => `${candidate.displayName}: ${candidate.point.lat}, ${candidate.point.lon}; accuracy unknown.`)].join("\n"));
      return serviceCode(output);
    }
    if (operation === "route") {
      const selected = mode(flags), points = args.map(point);
      const output: GeoRouteOutput = { operation: "route", ...await geo().route(points, selected) };
      await emitGeo(cli.json, output, () => { const lines = [...serviceLines(output), ...attemptLines(output), `Calculated ${output.request.mode} route; ${output.request.points.length} requested stops; planning evidence does not prove travel.`];
        if (output.source) lines.push(`Dataset: ${output.source.dataset.name}; prepared ${output.source.dataset.preparedMode}; profile ${output.source.dataset.profile}; fallback ${output.source.fallback.used ? output.source.fallback.reason : "not used"}.`);
        output.request.points.forEach((p, index) => lines.push(`Stop ${index + 1}: ${p.lat}, ${p.lon}.`));
        if (output.value) lines.push(`Distance ${measured(output.value.measurements.distance.value, "m")}; duration ${measured(output.value.measurements.duration.value, "s")} (provider estimate).`);
        for (let index = 0; index < output.request.points.length - 1; index++) lines.push(`Leg ${index + 1}: ${measured(output.value?.legs[index]?.distanceM ?? null, "m")}; ${measured(output.value?.legs[index]?.durationS ?? null, "s")}.`);
        return lines.join("\n"); });
      return serviceCode(output);
    }
    if (operation === "poi") {
      if (args.length) throw new UsageError("POI uses --near or --along, --radius-m and --tag.");
      const near = option(flags, "near"), along = option(flags, "along");
      if ((near === undefined) === (along === undefined)) throw new UsageError("POI needs exactly one of --near or --along.");
      const radiusM = numeric(option(flags, "radius-m", true)!, "Radius"), tags: Record<string, string | true> = {};
      for (const tag of repeated(argv, "tag")) {
        const separator = tag.indexOf("="), key = separator === -1 ? tag : tag.slice(0, separator), value = separator === -1 ? true : tag.slice(separator + 1);
        if (Object.hasOwn(tags, key)) throw new UsageError(`Duplicate tag: ${key}`);
        Object.defineProperty(tags, key, { value, enumerable: true, configurable: true, writable: true });
      }
      const source = along === undefined ? null : await readTrack(cli.brain.root, along);
      const query = source ? { alongTrack: source.track, radiusM, tags } : { near: point(near!), radiusM, tags };
      const output: GeoPoiOutput = { operation: "poi", sourceFile: source?.summary.source.path ?? null, ...await geo().poi(query) };
      await emitGeo(cli.json, output, () => { const lines = [...serviceLines(output), ...attemptLines(output)];
        if (output.query) lines.push(`Radius: ${output.query.radiusM} m; exact tags: ${JSON.stringify(output.query.tags)}.`);
        if (output.sourceFile) lines.push(`Along file: ${output.sourceFile}; ${output.track?.partial ? "partial usable sections" : "usable sections"}.`);
        for (const value of output.value ?? []) lines.push(`${value.name ?? "Unnamed POI"}: ${value.point.lat}, ${value.point.lon}; ${measured(value.distance.value, "m")} to representative point; opening hours ${value.openingHours.value ?? "unknown"} (not interpreted).`);
        return lines.join("\n"); });
      return serviceCode(output);
    }
    if (operation === "track") {
      if (args.length !== 1) throw new UsageError("Track needs one GPX path.");
      const near = option(flags, "near"), compare = option(flags, "compare"), tolerance = option(flags, "tolerance-m"), spacing = option(flags, "sample-spacing-m");
      if ((near || compare) && tolerance === undefined) throw new UsageError("Near/comparison requires --tolerance-m.");
      if (tolerance !== undefined && near === undefined && compare === undefined) throw new UsageError("Tolerance needs --near or --compare.");
      if (spacing !== undefined && compare === undefined) throw new UsageError("Sample spacing requires --compare.");
      const toleranceM = tolerance === undefined ? 0 : numeric(tolerance, "Tolerance"), sampleSpacingM = spacing === undefined ? undefined : numeric(spacing, "Sample spacing");
      const source = await readTrack(cli.brain.root, args[0]!), other = compare === undefined ? null : await readTrack(cli.brain.root, compare);
      const output: GeoTrackOutput = { operation: "track", ...source.summary, omissions: source.track.omissions,
        nearest: near === undefined ? null : usage(() => nearestTrackPoint(source.track, point(near), toleranceM)),
        comparison: other ? { summary: other.summary, omissions: other.track.omissions, coverage: usage(() => trackCoverage(source.track, other.track, { toleranceM, sampleSpacingM })) } : null };
      await emitGeo(cli.json, output, () => trackText(output)); return 0;
    }
    return runMap(args, argv, flags, cli, geo());
  },
};

async function runMap(args: string[], argv: string[], flags: Flags, cli: CliContext, geo: GeoClient): Promise<number> {
  if (cli.brain.configPath === null) throw new UsageError("Map refuses to write in an uninitialized directory; run brain init first.");
  const root = realpathSync(cli.brain.root), out = option(flags, "out", true)!;
  if (extname(out).toLowerCase() !== ".png") throw new UsageError("Map --out must name a PNG file.");
  const absolute = resolveWritable(root, out);
  if (!absolute) throw new UsageError("Map output must remain inside the brain.");
  const scratch = isInScratch(root, out) || isInScratch(root, absolute);
  if (scratch) { try { assertScratchWritable(root, absolute); } catch (error) { if (isWriteRefusal(error)) throw new UsageError((error as Error).message); throw error; } }
  const pins: StaticMapPin[] = repeated(argv, "pin").map(value => {
    const parts = value.split(","); if (parts.length < 3) throw new UsageError("--pin needs latitude,longitude,label.");
    return { ...point(parts.slice(0, 2).join(",")), label: parts.slice(2).join(",") };
  });
  const points = repeated(argv, "point").map(point);
  if (points.length && (points.length < 2 || points.length > 100)) throw new UsageError("Map routing needs 2–100 --point stops.");
  const selected = points.length ? mode(flags) : undefined;
  if (!points.length && flags.mode !== undefined) throw new UsageError("Map --mode needs route --point stops.");
  if (args.length > 100 || pins.length > 1000) throw new UsageError("Map allows at most 100 tracks and 1000 explicit pins.");
  const bounds = option(flags, "bbox"), bbox = bounds === undefined ? undefined : bounds.split(",").map(value => numeric(value, "Bounds"));
  if (bbox && bbox.length !== 4) throw new UsageError("Bounds need west,south,east,north.");
  if (bbox) { usage(() => routePoint(bbox[1]!, bbox[0]!)); usage(() => routePoint(bbox[3]!, bbox[2]!));
    if (bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]!) throw new UsageError("Bounds must be ordered and nonempty."); }
  const width = option(flags, "width"), widthPx = width === undefined ? undefined : numeric(width, "Width"), title = option(flags, "title");
  if (widthPx !== undefined && (!Number.isInteger(widthPx) || widthPx < 320 || widthPx > 2048)) throw new UsageError("Map width must be an integer from 320 to 2048.");
  if (title !== undefined && (title.length > 500 || /[\u0000-\u001f\u007f]/.test(title))) throw new UsageError("Map title must be bounded text without controls.");
  for (const pin of pins) if (pin.label.length > 1000 || /[\u0000-\u001f\u007f]/.test(pin.label)) throw new UsageError("Pin labels must be bounded text without controls.");
  const tracks: NonNullable<StaticMapInput["tracks"]> = [];
  let count = pins.length + points.length;
  for (const path of args) {
    const source = await readTrack(root, path); count += source.track.counts.input;
    if (count > 200000) throw new UsageError("Map input exceeds 200000 source points/stops.");
    tracks.push({ track: source.track, source: source.summary.source, label: basename(path) });
  }
  const routes = selected ? [await geo.route(points, selected)] : [];
  let result: StaticMapResult;
  try { result = await geo.staticMap({ tracks, pins, routes, bbox: bbox as StaticMapInput["bbox"], title, widthPx, background: flags["no-background"] ? "none" : "auto" }); }
  catch (error) { throw new UsageError((error as Error).message); }
  const { png, svg: _svg, ...evidence } = result;
  let artifact: GeoMapOutput["artifact"] = null;
  if (png) {
    const parent = resolveWritable(root, dirname(out));
    if (!parent) throw new UsageError("Map output directory no longer remains inside the brain.");
    const target = join(parent, basename(out));
    try {
      if (scratch || isInScratch(root, out) || isInScratch(root, target)) { writeScratchFile(root, out, png, { replace: true }); pruneScratch(root); }
      else writeFileSafely(target, png);
    } catch (error) { if (isWriteRefusal(error)) throw new UsageError((error as Error).message); throw error; }
    artifact = { path: relative(root, target).split("\\").join("/"), format: "png", bytes: png.byteLength };
  }
  const output: GeoMapOutput = { operation: "map", ...evidence, artifact };
  await emitGeo(cli.json, output, () => `${artifact ? `Map: ${artifact.path} (${artifact.bytes} bytes).` : `Map image unavailable: ${output.reason}.`}\n${output.text}`);
  return result.reason === "renderer_unavailable" ? 2 : 0;
}
