import type { GeoCoords } from "@schlessera/brain-ui-sdk";

/**
 * Reverse geocoding via OpenStreetMap's Nominatim. Turns a raw lat/long fix
 * into a human-readable place so Claude sees "Kreuzberg, Berlin, Germany"
 * instead of bare coordinates.
 *
 * Nominatim's usage policy caps us at 1 request/second and requires an
 * identifying User-Agent (https://operations.osmfoundation.org/policies/nominatim/).
 * A single user tapping a location tool stays well under that, and the small
 * coord-rounded cache below collapses repeat lookups from the same spot.
 * Every failure path degrades gracefully to `null` — the caller still returns
 * the raw coordinates, so a Nominatim outage never breaks the tool.
 */

const REQUEST_TIMEOUT_MS = 5000;

// Read at call time (not module load) so config and tests can override it.
function nominatimUrl(): string {
  return process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
}
function userAgent(): string {
  return process.env.NOMINATIM_USER_AGENT || "brain-kit-ui/1.0";
}

/**
 * Reverse geocoding is on by default. Set BRAIN_UI_REVERSE_GEOCODE to
 * 0/off/false to skip the Nominatim call entirely — useful offline, air-gapped,
 * or when you'd rather not send coordinates to a third party. The location tool
 * then returns raw coordinates only.
 */
function reverseGeocodeEnabled(): boolean {
  const v = (
    process.env.BRAIN_UI_REVERSE_GEOCODE ?? process.env.BRAIN_UI_REVERSE_GEOCODE
  )?.toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  coords: GeoCoords
): Promise<ReverseGeocodeResult | null> {
  if (!reverseGeocodeEnabled()) return null;

  const key = cacheKey(coords);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await fetchReverseGeocode(coords);
  cache.set(key, { result, at: Date.now() });
  return result;
}

async function fetchReverseGeocode(
  coords: GeoCoords
): Promise<ReverseGeocodeResult | null> {
  try {
    const url = new URL(`${nominatimUrl()}/reverse`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(coords.latitude));
    url.searchParams.set("lon", String(coords.longitude));
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "16");

    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
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
