/**
 * Tool component contracts — the D3 seam.
 *
 * Importable from both halves of the app: the server builds tool definitions
 * and the system-prompt brief from these, the browser binds renderers and
 * parses payloads from the same objects. Nothing here imports React or a node
 * built-in.
 */

export type {
  ToolAdapter,
  ToolContract,
  ToolComponentContract,
  ToolInput,
  ToolPayload,
} from "./contract.js";
export {
  BRIDGE_MCP_PREFIX,
  defineToolContract,
  defineToolComponentContract,
  parseToolPayload,
  toolBriefLines,
  toolInputJsonSchema,
  visibleToolName,
} from "./contract.js";

export * from "./bridge.js";
