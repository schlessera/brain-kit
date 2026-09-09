import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_DESCRIPTION,
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_TOOL_NAME,
  GET_CURRENT_LOCATION_DESCRIPTION,
  GET_CURRENT_LOCATION_INPUT_SCHEMA,
  GET_CURRENT_LOCATION_TOOL_NAME,
  QUERY_ACTIVITY_DESCRIPTION,
  QUERY_ACTIVITY_INPUT_SCHEMA,
  QUERY_ACTIVITY_TOOL_NAME,
  REQUEST_IMAGE_MASK_DESCRIPTION,
  REQUEST_IMAGE_MASK_INPUT_SCHEMA,
  REQUEST_IMAGE_MASK_TOOL_NAME,
  handleAskUser,
  handleGetCurrentLocation,
  handleQueryActivity,
  handleRequestImageMask,
  piMaskFilename,
  piReportedMaskPath,
  type AskUserResult,
  type LocationHandlerOptions,
  type ReverseGeocodeConfig,
} from "@schlessera/brain-ui-sdk/server";
import { z } from "zod";

import { resolveEnv } from "./config/env.js";
import type { TurnContext } from "./turn-context.js";

function textResult(text: string, details: unknown = null) {
  return { content: [{ type: "text" as const, text }], details };
}

export function toPiParameters(schema: z.ZodObject): ToolDefinition["parameters"] {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, {
    io: "input",
  });
  return parameters;
}

export function resolveLocationReverseGeocodeConfig(): ReverseGeocodeConfig {
  const env = resolveEnv();
  return {
    enabled: env.reverseGeocodeEnabled,
    url: env.nominatimUrl,
    userAgent: env.nominatimUserAgent,
  };
}

export interface PiBridgeToolOptions {
  brainPath: string;
  turn: TurnContext;
  capabilities?: {
    location?: boolean;
    activity?: boolean;
    mask?: boolean;
  };
  reverseGeocodeConfig?: ReverseGeocodeConfig;
  reverseGeocode?: LocationHandlerOptions["reverseGeocode"];
}

export function createPiBridgeTools(options: PiBridgeToolOptions): ToolDefinition[] {
  const { brainPath, turn, capabilities } = options;

  const askUser = {
    name: ASK_USER_TOOL_NAME,
    label: "Ask user",
    description: ASK_USER_DESCRIPTION,
    parameters: toPiParameters(ASK_USER_INPUT_SCHEMA),
    async execute(id: string, input: unknown) {
      if (!turn.bridge?.askUser) {
        throw new Error("The host does not support ask_user in this session.");
      }
      const parsed = ASK_USER_INPUT_SCHEMA.parse(input);
      const payload = await handleAskUser(parsed, turn.bridge, id);
      const details: AskUserResult = {
        answers: payload.answers,
        ...(payload.annotations ? { annotations: payload.annotations } : {}),
      };
      return textResult(JSON.stringify(payload), details);
    },
  } satisfies ToolDefinition;

  const getCurrentLocation = {
    name: GET_CURRENT_LOCATION_TOOL_NAME,
    label: "Get location",
    description: GET_CURRENT_LOCATION_DESCRIPTION,
    parameters: toPiParameters(GET_CURRENT_LOCATION_INPUT_SCHEMA),
    async execute(_id: string, input: unknown) {
      if (!turn.bridge?.getLocation) {
        throw new Error(
          "The host does not support get_current_location in this session."
        );
      }
      const parsed = GET_CURRENT_LOCATION_INPUT_SCHEMA.parse(input);
      const payload = await handleGetCurrentLocation(
        parsed,
        turn.bridge,
        {
          reverseGeocodeConfig:
            options.reverseGeocodeConfig ??
            resolveLocationReverseGeocodeConfig(),
          ...(options.reverseGeocode
            ? { reverseGeocode: options.reverseGeocode }
            : {}),
        }
      );
      return textResult(JSON.stringify(payload), payload);
    },
  } satisfies ToolDefinition;

  const queryActivity = {
    name: QUERY_ACTIVITY_TOOL_NAME,
    label: "Query activity",
    description: QUERY_ACTIVITY_DESCRIPTION,
    parameters: toPiParameters(QUERY_ACTIVITY_INPUT_SCHEMA),
    async execute(_id: string, input: unknown) {
      if (!turn.bridge?.queryActivity) {
        throw new Error(
          "The host does not support query_activity in this session."
        );
      }
      const parsed = QUERY_ACTIVITY_INPUT_SCHEMA.parse(input);
      const text = await handleQueryActivity(parsed, turn.bridge);
      return textResult(text, null);
    },
  } satisfies ToolDefinition;

  const requestImageMask = {
    name: REQUEST_IMAGE_MASK_TOOL_NAME,
    label: "Request image mask",
    description: REQUEST_IMAGE_MASK_DESCRIPTION,
    parameters: toPiParameters(REQUEST_IMAGE_MASK_INPUT_SCHEMA),
    async execute(_id: string, input: unknown) {
      if (!turn.bridge?.requestMask) {
        throw new Error(
          "The host does not support request_image_mask in this session."
        );
      }
      const parsed = REQUEST_IMAGE_MASK_INPUT_SCHEMA.parse(input);
      const payload = await handleRequestImageMask(
        parsed,
        turn.bridge,
        {
          brainPath,
          maskFilename: piMaskFilename,
          reportMaskPath: piReportedMaskPath,
        }
      );
      return textResult(`Mask written to ${payload.maskPath}.`, {
        maskPath: payload.maskPath,
      });
    },
  } satisfies ToolDefinition;

  const tools: ToolDefinition[] = [askUser];
  if (capabilities?.location) tools.push(getCurrentLocation);
  if (capabilities?.activity) tools.push(queryActivity);
  if (capabilities?.mask) tools.push(requestImageMask);
  return tools;
}

export {
  ASK_USER_DESCRIPTION,
  ASK_USER_INPUT_SCHEMA,
  ASK_USER_TOOL_NAME,
  GET_CURRENT_LOCATION_DESCRIPTION,
  GET_CURRENT_LOCATION_INPUT_SCHEMA,
  GET_CURRENT_LOCATION_TOOL_NAME,
  QUERY_ACTIVITY_DESCRIPTION,
  QUERY_ACTIVITY_INPUT_SCHEMA,
  QUERY_ACTIVITY_TOOL_NAME,
  REQUEST_IMAGE_MASK_DESCRIPTION,
  REQUEST_IMAGE_MASK_INPUT_SCHEMA,
  REQUEST_IMAGE_MASK_TOOL_NAME,
};
