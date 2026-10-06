export type {
  ToolRenderer,
  ToolCallView,
  ToolSemantics,
  RendererPack,
  ToolRendererRegistry,
} from "./renderers.js";
export { registerToolRenderers } from "./renderers.js";

export type { AsrClient, AsrClientFactory, AsrClientOptions, AsrClientRegistry } from "./asr.js";
export {
  createAsrClientRegistry,
  registerAsrClient,
  createAsrClient,
} from "./asr.js";

export {
  BrainUiClient,
  LIVENESS_IDLE_MS,
  LIVENESS_RESPONSE_MS,
  STALE_SOCKET_CLOSE_CODE,
} from "./ws-client.js";
export type {
  BrainUiClientOptions,
  HelloState,
  LivenessEvent,
  ServerFrameHandlers,
  ConnectionStatus,
  ProtocolError,
  WebSocketClose,
} from "./ws-client.js";

// Tool component contracts (D3): the browser binds renderers and parses tool
// payloads from the same objects the server builds its tool definitions from.
export * from "../tool-contracts/index.js";

export * from "../protocol.js";

// How a `map` block is drawn (#44): a pure plan from its places, so the
// renderer only fetches geometry and hands the kit literal data.
export {
  planPlaces,
} from "../places.js";
export type {
  PlaceFrame,
  PlaceFrameHeight,
  PlaceFramePin,
  PlaceMode,
  PlacePlan,
  PlaceRow,
  UnpinnedReason,
} from "../places.js";
