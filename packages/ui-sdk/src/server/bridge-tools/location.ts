import type {
  GetCurrentLocationInput,
  LocationPayload,
} from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";
import {
  reverseGeocode,
  type ReverseGeocodeConfig,
  type ReverseGeocodeResult,
} from "../reverse-geocode.js";

/**
 * Options for `handleGetCurrentLocation`.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export interface LocationHandlerOptions {
  reverseGeocodeConfig: ReverseGeocodeConfig;
  reverseGeocode?: typeof reverseGeocode;
}

/**
 * Run `get_current_location` through the host bridge, with reverse geocoding.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export async function handleGetCurrentLocation(
  input: GetCurrentLocationInput,
  bridge: BackendBridge,
  options: LocationHandlerOptions
): Promise<LocationPayload> {
  if (!bridge.getLocation) {
    throw new Error(
      "The host does not support get_current_location in this session."
    );
  }
  const result = await bridge.getLocation({
    enableHighAccuracy: input.highAccuracy ?? false,
    timeoutMs: 15000,
    maximumAgeMs: 60000,
  });
  const geocode = options.reverseGeocode ?? reverseGeocode;
  const place: ReverseGeocodeResult | null = await geocode(
    result.coords,
    options.reverseGeocodeConfig
  );
  return {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
    accuracyMeters: Math.round(result.coords.accuracy),
    ...(place
      ? {
          place: place.summary,
          address: place.displayName,
          addressComponents: place.address,
        }
      : {
          note: "Reverse geocoding was unavailable; only raw coordinates are known.",
        }),
    retrievedAt: new Date(result.timestamp).toISOString(),
  };
}
