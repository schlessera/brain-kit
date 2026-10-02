import { GeoClient } from "@schlessera/brain-geo/server";
import type { FetchLike, GeoConfigInput } from "@schlessera/brain-geo";
import type { GeoCoords } from "../protocol.js";

/**
 * Shared validated/cached reverse evidence, or null with raw coordinates left to the caller.
 * Public eligibility is informed responsibility under the Nominatim policy, not a permission grant.
 * Configure an appropriate endpoint where public use is unsuitable.
 */
export interface ReverseGeocodeConfig {
  /** false skips the network call entirely (offline / privacy opt-out). */
  enabled: boolean;
  /** Nominatim endpoint base URL. */
  url: string;
  /** Identifying User-Agent (Nominatim usage-policy requirement). */
  userAgent: string;
  /** Explicit informed eligibility for the public Nominatim service; never inferred from enabled. */
  publicServiceEligible?: boolean;
  /** Canonical service/cache configuration takes precedence; enabled:false still prevents requests. */
  geo?: GeoConfigInput;
  /** Injected runtime uses the same admission/cache path as the concrete client. */
  fetchImpl?: FetchLike;
  admissionDir?: string;
}

export interface ReverseGeocodeResult {
  /** Full formatted address from Nominatim. */
  displayName: string;
  /** Concise "area, city, country" line, best-effort. */
  summary: string;
  /** Structured address components (city, road, country, …). */
  address: Record<string, string>;
}
export async function reverseGeocode(
  coords: GeoCoords,
  config: ReverseGeocodeConfig
): Promise<ReverseGeocodeResult | null> {
  if (!config.enabled) return null;
  try {
    const geo = new GeoClient(
      config.geo ?? {
        userAgent: config.userAgent,
        timeoutMs: 5_000,
        cacheTtlMs: 5 * 60 * 1_000,
        geocoding: {
          enabled: config.enabled,
          url: config.url,
          publicServiceEligible: config.publicServiceEligible ?? false,
        },
      },
      { fetchImpl: config.fetchImpl, admissionDir: config.admissionDir }
    );
    const result = await geo.reverse(coords.latitude, coords.longitude);
    const place = result.value?.[0];
    return place
      ? { displayName: place.displayName, summary: place.summary, address: { ...place.address } }
      : null;
  } catch {
    return null;
  }
}
