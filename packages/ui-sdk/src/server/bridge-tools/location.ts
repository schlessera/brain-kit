import { z } from "zod";

import type { BackendBridge } from "../backend.js";
import {
  reverseGeocode,
  type ReverseGeocodeConfig,
  type ReverseGeocodeResult,
} from "../reverse-geocode.js";

export const GET_CURRENT_LOCATION_TOOL_NAME = "get_current_location";

export const GET_CURRENT_LOCATION_DESCRIPTION = [
  "Get the user's current geographic location from their browser: latitude/longitude, an accuracy radius in metres, and a human-readable address (reverse-geocoded).",
  "Use when the request depends on where the user physically is — nearby places, local weather or timezone context, distances, 'where am I', or filling in a location the user did not state.",
  "The browser asks the user for permission the first time. If the user denies it, their location is unavailable, or the request times out, this returns an error — don't retry in a loop; tell the user and ask them to share it another way.",
  "Location is approximate (see the accuracy radius). Set highAccuracy=true only when precise positioning genuinely matters (e.g. nearby search); it is slower and uses more battery.",
].join("\n");

export const GET_CURRENT_LOCATION_INPUT_SCHEMA = z.object({
  highAccuracy: z
    .boolean()
    .optional()
    .describe(
      "Request the most precise fix available (GPS). Slower and more power-hungry; leave unset for a fast, coarse fix."
    ),
});

export type GetCurrentLocationInput = z.infer<
  typeof GET_CURRENT_LOCATION_INPUT_SCHEMA
>;

export interface LocationPayload {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  place?: string;
  address?: string;
  addressComponents?: Record<string, string>;
  note?: string;
  retrievedAt: string;
}

export interface LocationHandlerOptions {
  reverseGeocodeConfig: ReverseGeocodeConfig;
  reverseGeocode?: typeof reverseGeocode;
}

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
