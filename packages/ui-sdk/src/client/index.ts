export type {
  ToolRenderer,
  ToolCallView,
  ToolSemantics,
  RendererPack,
  ToolRendererRegistry,
} from "./renderers.js";
export {
  createToolRendererRegistry,
  defaultToolRendererRegistry,
  registerToolRenderers,
  resolveToolRenderer,
  resetToolRenderers,
} from "./renderers.js";

export type { AsrClient, AsrClientFactory, AsrClientOptions, AsrClientRegistry } from "./asr.js";
export {
  createAsrClientRegistry,
  defaultAsrClientRegistry,
  registerAsrClient,
  createAsrClient,
  speechUiHints,
  resetAsrClients,
} from "./asr.js";

export {
  BrainUiClient,
  createBrainUiClient,
} from "./ws-client.js";
export type {
  BrainUiClientOptions,
  ServerFrameHandlers,
  ConnectionStatus,
  ProtocolError,
  WebSocketClose,
} from "./ws-client.js";

// Tool component contracts (D3): the browser binds renderers and parses tool
// payloads from the same objects the server builds its tool definitions from.
export * from "../tool-contracts/index.js";

export * from "../protocol.js";
