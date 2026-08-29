import type { GeoCoords } from "../protocol.js";

/**
 * Reverse geocoding via OpenStreetMap's Nominatim. Turns a raw lat/long fix
 * into a human-readable place so the model sees "Kreuzberg, Berlin, Germany"
 * instead of bare coordinates.
 *
 * Configuration is INJECTED, not read from the environment: each backend owns
 * its env chokepoint and passes the resolved values in, so this module stays
 * pure and shareable.
 *
 * Nominatim's usage policy caps us at 1 request/second and requires an
 * identifying User-Agent (https://operations.osmfoundation.org/policies/nominatim/).
 * A single user tapping a location tool stays well under that, and the small
 * coord-rounded cache below collapses repeat lookups from the same spot.
 * Every failure path degrades gracefully to `null` — the caller still returns
 * the raw coordinates, so a Nominatim outage never breaks the tool.
 */

const REQUEST_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ReverseGeocodeConfig {
  /** false skips the network call entirely (offline / privacy opt-out). */
  enabled: boolean;
  /** Nominatim endpoint base URL. */
  url: string;
  /** Identifying User-Agent (Nominatim usage-policy requirement). */
  userAgent: string;
}

export interface ReverseGeocodeResult {
  /** Full formatted address from Nominatim. */
  displayName: string;
  /** Concise "area, city, country" line, best-effort. */
  summary: string;
  /** Structured address components (city, road, country, …). */
  address: Record<string, string>;
}

interface CacheEntry {
  result: ReverseGeocodeResult | null;
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** ~11 m of precision — enough to reuse a fix from the same building. */
function cacheKey(coords: GeoCoords): string {
  return `${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}`;
}

export async function reverseGeocode(
  coords: GeoCoords,
  config: ReverseGeocodeConfig
): Promise<ReverseGeocodeResult | null> {
  if (!config.enabled) return null;

  const key = cacheKey(coords);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await fetchReverseGeocode(coords, config);
  cache.set(key, { result, at: Date.now() });
  return result;
}

async function fetchReverseGeocode(
  coords: GeoCoords,
  config: ReverseGeocodeConfig
): Promise<ReverseGeocodeResult | null> {
  try {
    const url = new URL(`${config.url}/reverse`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(coords.latitude));
    url.searchParams.set("lon", String(coords.longitude));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "16");

    const res = await fetch(url, {
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string>;
      error?: string;
    };
    if (data.error) return null;

    const address = data.address ?? {};
    return {
      displayName: data.display_name ?? "",
      summary: buildSummary(address) || data.display_name || "",
      address,
    };
  } catch {
    // Network error, timeout, malformed JSON — fall back to raw coords.
    return null;
  }
}

/** Pick the most useful "area, city, country" components Nominatim returns. */
function buildSummary(a: Record<string, string>): string {
  const city =
    a.city || a.town || a.village || a.municipality || a.county || a.state;
  const area = a.suburb || a.neighbourhood || a.city_district || a.road;
  const country = a.country;
  return [area, city, country].filter(Boolean).join(", ");
}
