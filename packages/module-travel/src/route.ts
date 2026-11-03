import { readFileSync, lstatSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { safeResolve, writeFileSafely, WriteRefusedError } from "@schlessera/brain/module";
import { parseHtml, ScrapeClient } from "@schlessera/brain-scrape";
import { MAX_ROUTE_BYTES, parseGpx, quantizeRoute, routeMetrics, routePoint, trimRoute, writeGpx } from "./route-gpx.js";
import type { RouteGeometry, RouteMetrics } from "./route-gpx.js";
import { validateOutputNaming } from "./output-naming.js";
import type { OutputNamingOptions } from "./output-naming.js";

type SourceKind = "local_gpx" | "gpx_url" | "komoot_tour" | "komoot_smarttour";
export interface ImportedRoute extends RouteMetrics {
  source_kind: SourceKind;
  gpx: string;
  trim: { start_m: number; end_m: number };
  warnings: string[];
  date_source: "flag" | "none";
}
function httpUrl(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Expected a valid absolute HTTP(S) route URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Route URLs must use HTTP(S) without embedded credentials.");
  }
  return url;
}
async function limitedBody(response: Response, limit = MAX_ROUTE_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Route response has no body.");
  const chunks: Uint8Array[] = []; let bytes = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 30_000);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (timedOut) throw new Error("Route response body timed out.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Route response exceeds its size limit.");
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

function komootSource(url: URL): { kind: "komoot_tour" | "komoot_smarttour"; id: string } | null {
  if (!["komoot.com", "www.komoot.com"].includes(url.hostname)) return null;
  const match = /^\/(?:[a-z]{2}-[a-z]{2}\/)?(tour|smarttour)\/(e?\d+)(?:\/[^?#]*)?$/i.exec(url.pathname);
  if (!match) throw new Error("Unsupported Komoot URL; use a public tour or smarttour page.");
  return { kind: match[1]!.toLowerCase() === "tour" ? "komoot_tour" : "komoot_smarttour", id: match[2]! };
}

/** Decode the observed JSON string, never execute a site's JavaScript. */
export function parseKomoot(source: string, expectedId: string): RouteGeometry {
  const $ = parseHtml(source); let state: any;
  for (const script of $("script").toArray()) {
    const body = $(script).text(), marker = "kmtBoot.setProps(";
    const position = body.indexOf(marker);
    if (position < 0) continue;
    let start = position + marker.length;
    while (/\s/.test(body[start] ?? "") && start < body.length) start++;
    if (body[start] !== '"') throw new Error("Unsupported Komoot page payload.");
    let end = start + 1;
    for (; end < body.length; end++) {
      if (body[end] === "\\") end++;
      else if (body[end] === '"') break;
    }
    try { state = JSON.parse(JSON.parse(body.slice(start, end + 1))); }
    catch { throw new Error("Malformed Komoot page payload."); }
    break;
  }
  const tour = state?.page?._embedded?.tour;
  if (!tour || String(tour.id) !== expectedId) throw new Error("Komoot page has no matching route geometry; it may be deleted or unsupported.");
  if (tour.status !== "public") throw new Error("Komoot route is not public; private/login-protected routes are unsupported.");
  const coordinates: unknown = tour._embedded?.coordinates?.items;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 200_000) throw new Error("Komoot route has no supported coordinate array.");
  const points = coordinates.map((p) => routePoint(p?.lat, p?.lng, p?.alt));
  return { segments: [points], warnings: ["Metrics describe the geometry exposed by the public Komoot page; its sampling may differ from an exported GPX.",
    "Komoot relative t values are not imported as absolute recorded timestamps."] };
}

export async function importRoute(root: string, source: string, to: string, startM: number, endM: number, options: OutputNamingOptions = {}): Promise<ImportedRoute> {
  const naming = validateOutputNaming(options);
  const canonicalRoot = safeResolve(root, "."), directory = safeResolve(root, to);
  if (!canonicalRoot || !directory) throw new Error("Route output directory escapes the brain root.");
  if (![startM, endM].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Trim distances must be finite, nonnegative metres.");
  if ([startM, endM].some((n) => n > 0 && n < 0.001)) throw new Error("Nonzero trim distances must be at least 1 mm to survive GPX coordinate precision.");
  let geometry: RouteGeometry, kind: SourceKind, name: string;
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
    const url = httpUrl(source);
    if (url.hostname === "outdooractive.com" || url.hostname.endsWith(".outdooractive.com")) {
      throw new Error("Outdooractive routes cannot be fetched: its robots.txt disallows the geometry API and GPX download. Export the GPX from the route page while signed in, then import the local file.");
    }
    const requested = komootSource(url);
    // Public route pages need neither account credentials nor share tokens.
    if (requested) { url.search = ""; url.hash = ""; }
    // A user-supplied URL: scrape holds every hop and the robots.txt fetch to public addresses.
    const response = await new ScrapeClient({ addressPolicy: "public-only" }).get(url.href, { retries: 0 });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Cannot fetch route (HTTP ${response.status}); private, deleted or unavailable sources are unsupported.`); }
    const served = httpUrl(response.url || url.href), final = komootSource(served);
    if (requested && (!final || requested.id !== final.id || requested.kind !== final.kind)) {
      await response.body?.cancel(); throw new Error("Komoot redirected away from the requested route.");
    }
    const body = await limitedBody(response);
    kind = final?.kind ?? "gpx_url";
    geometry = final ? parseKomoot(body, final.id) : parseGpx(body);
    name = final ? `komoot-${final.id}` : basename(served.pathname);
  } else {
    const path = safeResolve(root, source);
    if (!path) throw new Error("Route input path escapes the brain root.");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_ROUTE_BYTES) throw new Error("Route input must be a regular GPX file of at most 20 MiB.");
    geometry = parseGpx(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
    kind = "local_gpx"; name = basename(source);
  }
  const retained = quantizeRoute(trimRoute(geometry.segments, startM, endM));
  const metrics = routeMetrics(retained);
  if (metrics.distance_km === 0) throw new Error("Retained route is shorter than the 1 mm reporting precision; no file written.");
  const gpx = writeGpx(retained);
  const stem = naming.slug === undefined
    ? basename(name, extname(name)).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "route"
    : `${naming.date ? naming.date + "-" : ""}${naming.slug}`;
  const warnings = [...geometry.warnings];
  if (metrics.ascent_m === null) warnings.push("Incomplete elevations: ascent and altitude range remain unknown.");
  if (metrics.recorded_duration_s === null) warnings.push("Incomplete or non-monotonic timestamps: recorded duration remains unknown.");
  if (startM || endM) warnings.push("Trim boundaries interpolate position, elevation and timestamps along each edge.");
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const file = `${stem}${suffix === 1 ? "" : `-${suffix}`}.gpx`;
    if (lstatSync(join(directory, file), { throwIfNoEntry: false })) continue;
    // Requests stay root-relative: `safeResolve` refuses an absolute path (#3422).
    const output = safeResolve(root, join(to, file));
    if (!output || safeResolve(root, to) !== directory) throw new Error("Route output directory changed or escapes the brain root.");
    try { writeFileSafely(output, gpx, { replace: false }); }
    catch (error) { if (error instanceof WriteRefusedError && error.message.startsWith("EEXIST:")) continue; throw error; }
    return { source_kind: kind, gpx: relative(canonicalRoot, output).replaceAll("\\", "/"), ...metrics, trim: { start_m: startM, end_m: endM }, warnings,
      date_source: naming.slug !== undefined && naming.date ? "flag" : "none" };
  }
  throw new Error("No unused route output name remains; existing files were preserved.");
}

export async function runRoute(args: string[], root: string, json: boolean): Promise<number> {
  try {
    let source: string | undefined, to: string | undefined, name: string | undefined, date: string | undefined, start = 0, end = 0;
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--json" || arg === "--human") continue;
      if (["--to", "--trim-start-m", "--trim-end-m", "--name", "--date"].includes(arg)) {
        if (seen.has(arg)) throw new Error(`Duplicate ${arg}.`);
        seen.add(arg); const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
        if (arg === "--to") to = value;
        else if (arg === "--name") name = value;
        else if (arg === "--date") date = value;
        else {
          if (!decimalPattern.test(value)) throw new Error("Trim distances must be finite, nonnegative metres.");
          if (arg === "--trim-start-m") start = Number(value); else end = Number(value);
        }
      } else if (arg.startsWith("-") || source !== undefined) throw new Error(`Unknown route argument: ${arg}`);
      else source = arg;
    }
    if (!source || !to) throw new Error("Usage: brain travel route <url|file> --to <dir> [--name <label>] [--date YYYY-MM-DD] [--trim-start-m N] [--trim-end-m N] [--json]");
    const route = await importRoute(root, source, to, start, end, { name, date });
    if (json) console.log(JSON.stringify({ route }, null, 2));
    else console.log(`${route.gpx}: ${route.distance_km} km, ascent ${route.ascent_m === null ? "unknown" : `${route.ascent_m} m`}, ${route.shape}.\n${route.warnings.join("\n")}`.trim());
    return 0;
  } catch (error) { console.error(`Route import failed: ${(error as Error).message}`); return 1; }
}

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
