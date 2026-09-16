/**
 * The payload schemas are the D3 contract's client half: a component is typed
 * `z.infer<contract["payload"]>`, so a schema that has drifted from the
 * interface the handler returns produces a component typed for data that never
 * arrives. `satisfies z.ZodType<T>` alone does not catch that — it only proves
 * assignability — so each payload is compared in both directions here.
 */

import type {
  ASK_USER_PAYLOAD_SCHEMA,
  AskUserPayload,
  IMAGE_MASK_PAYLOAD_SCHEMA,
  ImageMaskPayload,
  LOCATION_PAYLOAD_SCHEMA,
  LocationPayload,
  ToolPayload,
} from "../src/tool-contracts/index.js";
import type {
  ASK_USER_CONTRACT,
  GET_CURRENT_LOCATION_CONTRACT,
  REQUEST_IMAGE_MASK_CONTRACT,
} from "../src/tool-contracts/bridge.js";
import type { Assert, Equal, SchemaEqualsProtocol } from "./type-equality.js";

type AskUserPayloadMatches = Assert<
  SchemaEqualsProtocol<typeof ASK_USER_PAYLOAD_SCHEMA, AskUserPayload>
>;
type LocationPayloadMatches = Assert<
  SchemaEqualsProtocol<typeof LOCATION_PAYLOAD_SCHEMA, LocationPayload>
>;
type ImageMaskPayloadMatches = Assert<
  SchemaEqualsProtocol<typeof IMAGE_MASK_PAYLOAD_SCHEMA, ImageMaskPayload>
>;

// `ToolPayload<contract>` is what `bind(contract, Component)` hands a
// component. It must resolve to the payload type itself, not to `unknown` or
// to the zod schema — a component typed `unknown` accepts anything and the
// drift the contract exists to catch would compile.
type AskUserToolPayloadResolves = Assert<
  Equal<
    ToolPayload<typeof ASK_USER_CONTRACT>,
    ReturnType<(typeof ASK_USER_PAYLOAD_SCHEMA)["parse"]>
  >
>;
type LocationToolPayloadResolves = Assert<
  Equal<
    ToolPayload<typeof GET_CURRENT_LOCATION_CONTRACT>,
    ReturnType<(typeof LOCATION_PAYLOAD_SCHEMA)["parse"]>
  >
>;
type MaskToolPayloadResolves = Assert<
  Equal<
    ToolPayload<typeof REQUEST_IMAGE_MASK_CONTRACT>,
    ReturnType<(typeof IMAGE_MASK_PAYLOAD_SCHEMA)["parse"]>
  >
>;

export type {
  AskUserPayloadMatches,
  LocationPayloadMatches,
  ImageMaskPayloadMatches,
  AskUserToolPayloadResolves,
  LocationToolPayloadResolves,
  MaskToolPayloadResolves,
};
