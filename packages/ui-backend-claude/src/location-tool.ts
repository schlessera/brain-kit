import { tool } from "@anthropic-ai/claude-agent-sdk";
// The SDK uses zod v4 internally, so schema types line up with the SDK's
// `AnyZodRawShape` from a plain `zod` import.
import { z } from "zod";
import type { GeoRequestOptions } from "@brainform/ui-sdk";
import type { LocationFix } from "@brainform/ui-sdk/server";
import { reverseGeocode } from "./reverse-geocode";

/**
 * `get_current_location` — in-process MCP tool exposing the user's physical
 * location to Claude.
 *
 * `navigator.geolocation` only exists in the browser, but the model runs
 * server-side, so this mirrors the ask_user bridge: the handler emits a
 * `location_request` over the wire protocol, the browser reads its geolocation
 * and replies, and the resolved fix is reverse-geocoded here before being
 * handed back to the model as the tool result.
 */

/** Bridges the tool to the host's location provider (`BackendBridge.getLocation`). */
export type LocationHandler = (options?: GeoRequestOptions) => Promise<LocationFix>;

export function createLocationTool(handler: LocationHandler) {
  return tool(
    "get_current_location",
    [
      "Get the user's current geographic location from their browser: latitude/longitude, an accuracy radius in metres, and a human-readable address (reverse-geocoded).",
      "Use when the request depends on where the user physically is — nearby places, local weather or timezone context, distances, 'where am I', or filling in a location the user did not state.",
      "The browser asks the user for permission the first time. If the user denies it, their location is unavailable, or the request times out, this returns an error — don't retry in a loop; tell the user and ask them to share it another way.",
      "Location is approximate (see the accuracy radius). Set highAccuracy=true only when precise positioning genuinely matters (e.g. nearby search); it is slower and uses more battery.",
    ].join("\n"),
    {
      highAccuracy: z
        .boolean()
        .optional()
        .describe(
          "Request the most precise fix available (GPS). Slower and more power-hungry; leave unset for a fast, coarse fix."
        ),
    },
    async (args) => {
      try {
        const result = await handler({
          enableHighAccuracy: args.highAccuracy ?? false,
          timeoutMs: 15000,
          maximumAgeMs: 60000,
        });
        const place = await reverseGeocode(result.coords);
        const payload = {
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                err instanceof Error
                  ? err.message
                  : "get_current_location failed",
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const GET_LOCATION_TOOL_NAME = "mcp__brainform__get_current_location";
