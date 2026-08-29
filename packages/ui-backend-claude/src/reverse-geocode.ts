import type { GeoCoords } from "@schlessera/brain-ui-sdk";
import {
  reverseGeocode as sharedReverseGeocode,
  type ReverseGeocodeResult,
} from "@schlessera/brain-ui-sdk/server";

import { resolveEnv } from "./config/env.js";

/**
 * Reverse geocoding for the location tool. The implementation (Nominatim
 * call, cache, graceful degradation) is shared in
 * `@schlessera/brain-ui-sdk/server`; this adapter binds it to THIS package's
 * env chokepoint (BRAIN_UI_REVERSE_GEOCODE, NOMINATIM_URL,
 * NOMINATIM_USER_AGENT), resolved at call time so config and tests can
 * override it.
 */
export type { ReverseGeocodeResult } from "@schlessera/brain-ui-sdk/server";

export async function reverseGeocode(
  coords: GeoCoords
): Promise<ReverseGeocodeResult | null> {
  const env = resolveEnv();
  return sharedReverseGeocode(coords, {
    enabled: env.reverseGeocodeEnabled,
    url: env.nominatimUrl,
    userAgent: env.nominatimUserAgent,
  });
}
