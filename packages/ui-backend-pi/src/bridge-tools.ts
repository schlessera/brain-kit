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
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  SHOW_BLOCK_TOOL_NAME,
  handleAskUser,
  handleGetCurrentLocation,
  handleQueryActivity,
  handleRequestImageMask,
  handleShowBlock,
  piMaskFilename,
  piReportedMaskPath,
  toolInputJsonSchema,
  type ToolContract,
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

/**
 * pi's parameter shape from a contract's input schema. The conversion itself
 * lives in the SDK (`toolInputJsonSchema`) so both backends advertise the same
 * JSON Schema for the same tool; this wrapper only narrows the return type to
 * pi's.
 */
export function toPiParameters(
  schema: z.ZodObject | ToolContract
): ToolDefinition["parameters"] {
  return toolInputJsonSchema(schema) as ToolDefinition["parameters"];
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
      // The editor needs eyes, and this turn declared it has none: opening it
      // would block on a region nobody will paint until the turn budget
      // expires. Checked at execute time because the tool set is built once
      // per session while the posture belongs to the turn.
      if (turn.noGrantSurface) {
        throw new Error(
          "This turn has no way to show anyone an image, so request_image_mask cannot be used in it."
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
      // JSON in `output`, the same convention ask_user and
      // get_current_location follow, so one renderer can parse any payload
      // tool's result. `details` keeps the pre-contract shape for hosts that
      // read it; the pi adapter drops details on the wire either way.
      return textResult(JSON.stringify(payload), {
        maskPath: payload.maskPath,
      });
    },
  } satisfies ToolDefinition;

  const showBlock = {
    name: SHOW_BLOCK_TOOL_NAME,
    label: "Show block",
    description: SHOW_BLOCK_DESCRIPTION,
    parameters: toPiParameters(SHOW_BLOCK_INPUT_SCHEMA),
    async execute(_id: string, input: unknown) {
      // No bridge and no capability: the block is data the model authored,
      // validated here and echoed as the payload the client renders.
      const payload = handleShowBlock(SHOW_BLOCK_INPUT_SCHEMA.parse(input));
      return textResult(JSON.stringify(payload), payload);
    },
  } satisfies ToolDefinition;

  const tools: ToolDefinition[] = [askUser, showBlock];
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
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_INPUT_SCHEMA,
  SHOW_BLOCK_TOOL_NAME,
};
