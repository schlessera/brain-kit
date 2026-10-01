import type { GeoConfig } from "../config.js";
import type { GeoResult } from "./client.js";
import { GeoTransport, type GeoError } from "./io.js";

export interface OverpassResult<T> extends GeoResult<T> {
  source: (NonNullable<GeoResult<T>["source"]> & {
    fallback: {used: boolean; reason: string | null; primaryEndpoint: string};
  }) | null;
  attempts: {endpoint: string; fromCache: boolean; requestSent: boolean; error: GeoError | null}[];
}

const canFallback = (error: GeoError): boolean => ["timeout", "network", "bad_response", "response_limit"].includes(error.code)
  || error.code === "http" && (error.httpStatus === 408 || (error.httpStatus ?? 0) >= 500);

/** One ordered, bounded query chain; admission refusals never authorize another endpoint. */
export async function queryOverpass<T>(config: GeoConfig, transport: GeoTransport, query: string,
  decode: (raw: unknown) => T): Promise<OverpassResult<T>> {
  const attempts: OverpassResult<T>["attempts"] = [];
  const failed = (error: GeoError): OverpassResult<T> => ({status: error.code === "disabled" ? "disabled" : "error",
    value: null, source: null, error, warnings: [], attribution: [], attempts});
  if (!config.overpass.enabled) return failed({code: "disabled", message: "Overpass queries are disabled."});
  const endpoints = [...new Set(config.overpass.endpoints)];
  if (!endpoints.length) return failed({code: "configuration", message: "Enabled Overpass needs a configured endpoint."});
  let reason: string | null = null;
  for (const [index, endpoint] of endpoints.entries()) {
    const result = await transport.request("overpass", endpoint, endpoint,
      {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({data: query}).toString()}, decode);
    const source: NonNullable<OverpassResult<T>["source"]> = {...result.source, transfer: {data: "query_geometry", sent: result.source.requestSent},
      fallback: {used: index > 0, reason, primaryEndpoint: endpoints[0]!}};
    attempts.push({endpoint, fromCache: source.fromCache, requestSent: source.requestSent, error: result.error});
    const host = new URL(endpoint).hostname.toLowerCase();
    const fossgis = ["overpass-api.de", "gall.openstreetmap.de", "lambert.openstreetmap.de"].includes(host) || host.endsWith(".overpass-api.de");
    const outcome: OverpassResult<T> = {status: result.error ? "error" : "ok", value: result.value, source, error: result.error,
      warnings: index > 0 ? ["Using a configured Overpass fallback after genuine service failure."] : [],
      attribution: result.error ? [] : [{text: "© OpenStreetMap contributors (ODbL)", url: "https://www.openstreetmap.org/copyright"},
        ...(fossgis ? [{text: "Contribute/report an OpenStreetMap error", url: "https://www.openstreetmap.org/fixthemap"},
          {text: "FOSSGIS service terms", url: "https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/"}] : [])], attempts};
    if (!result.error || !canFallback(result.error) || index === endpoints.length - 1) return outcome;
    reason ??= result.error.code;
  }
  throw new Error("Overpass endpoint configuration has no usable entries.");
}
