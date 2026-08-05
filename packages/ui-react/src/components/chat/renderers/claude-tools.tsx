// Claude backend tool-renderer pack. These are the previous per-tool switch
// bodies, now expressed as a backend-scoped registry pack. Rendering is
// delegated to the shared switch-based views so output stays byte-identical to
// the pre-registry timeline.

import type { RendererPack, ToolRenderer, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import type { ToolCall } from "../../../stores/chat-store.js";
import { GET_LOCATION_TOOL_NAME } from "../../../lib/tool-names.js";
import {
  getToolIcon,
  getToolSummary,
  getOutputMeta,
  ToolInputView,
  ToolOutputView,
} from "../tool-views.js";

/** Claude tool names with dedicated iconography / summaries. */
const CLAUDE_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Skill",
  "NotebookEdit",
  "LSP",
  GET_LOCATION_TOOL_NAME,
];

// The shared views read brain-ui's richer ToolCall (status, inputJson, timing).
// The timeline passes the full ToolCall at runtime, so widening the neutral
// ToolCallView back to ToolCall here is safe.
const asToolCall = (tool: ToolCallView) => tool as unknown as ToolCall;

function claudeRenderer(name: string): ToolRenderer {
  return {
    match: name,
    icon: getToolIcon(name),
    summary: (tool) => getToolSummary(asToolCall(tool)),
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    Input: ({ tool }) => <ToolInputView tool={asToolCall(tool)} />,
    Output: ({ tool }) => <ToolOutputView tool={asToolCall(tool)} />,
  };
}

export const claudeToolPack: RendererPack = {
  backend: "claude",
  renderers: CLAUDE_TOOL_NAMES.map(claudeRenderer),
};
