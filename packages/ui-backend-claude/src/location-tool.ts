import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { GeoRequestOptions } from "@schlessera/brain-ui-sdk";
import {
  BRIDGE_TOOL_POSTURE,
  GET_CURRENT_LOCATION_DESCRIPTION,
  GET_CURRENT_LOCATION_INPUT_SCHEMA,
  GET_CURRENT_LOCATION_TOOL_NAME as SHARED_TOOL_NAME,
  handleGetCurrentLocation,
  type BackendBridge,
  type LocationFix,
  type LocationHandlerOptions,
  type ReverseGeocodeConfig,
} from "@schlessera/brain-ui-sdk/server";

import { resolveEnv } from "./config/env.js";

/** Bridges the tool to the host's location provider (`BackendBridge.getLocation`). */
export type LocationHandler = (options?: GeoRequestOptions) => Promise<LocationFix>;

export function resolveLocationReverseGeocodeConfig(): ReverseGeocodeConfig {
  const env = resolveEnv();
  return {
    enabled: env.reverseGeocodeEnabled,
    url: env.nominatimUrl,
    userAgent: env.nominatimUserAgent,
    publicServiceEligible: env.nominatimPublicServiceEligible,
  };
}

export interface LocationToolOptions {
  reverseGeocodeConfig?: ReverseGeocodeConfig;
  reverseGeocode?: LocationHandlerOptions["reverseGeocode"];
}

export function createLocationTool(
  handler: LocationHandler,
  options: LocationToolOptions = {}
) {
  return tool(
    SHARED_TOOL_NAME,
    GET_CURRENT_LOCATION_DESCRIPTION,
    GET_CURRENT_LOCATION_INPUT_SCHEMA.shape,
    async (input) => {
      try {
        const parsed = GET_CURRENT_LOCATION_INPUT_SCHEMA.parse(input);
        const payload = await handleGetCurrentLocation(
          parsed,
          { getLocation: handler } as BackendBridge,
          {
            reverseGeocodeConfig:
              options.reverseGeocodeConfig ??
              resolveLocationReverseGeocodeConfig(),
            ...(options.reverseGeocode
              ? { reverseGeocode: options.reverseGeocode }
              : {}),
          }
        );
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

export { GET_CURRENT_LOCATION_DESCRIPTION, GET_CURRENT_LOCATION_INPUT_SCHEMA };

/** The exact MCP-prefixed tool name Claude sees in the stream. */
export const GET_LOCATION_TOOL_NAME = BRIDGE_TOOL_POSTURE.visibleName(
  SHARED_TOOL_NAME,
  "claude"
);
