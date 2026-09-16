// Claude backend tool-renderer pack. These are the previous per-tool switch
// bodies, now expressed as a backend-scoped registry pack. Rendering is
// delegated to the shared switch-based views so output stays byte-identical to
// the pre-registry timeline.

import type {
  RendererPack,
  ToolRenderer,
  ToolCallView,
  ToolSemantics,
} from "@schlessera/brain-ui-sdk/client";
import type { ToolCall } from "../../../stores/chat-store.js";
import {
  getToolIcon,
  getToolSummary,
  getOutputMeta,
  getTouchedFile,
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
  // `mcp__brain-ui__get_current_location` is deliberately NOT here: it is one
  // of the chat UI's own contract-bound tools (`brain-ui-tools.tsx`), and a
  // backend-scoped entry would beat that global renderer.
];

// The shared views read brain-ui's richer ToolCall (status, inputJson, timing).
// The timeline passes the full ToolCall at runtime, so widening the neutral
// ToolCallView back to ToolCall here is safe.
const asToolCall = (tool: ToolCallView) => tool as unknown as ToolCall;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Backend-neutral meaning of Claude's shell tool, for risk advisories. */
const bashSemantics: ToolSemantics = {
  command: (tool) => str(tool.input?.command) || null,
  unsandboxed: (tool) => Boolean(tool.input?.dangerouslyDisableSandbox),
};

/** Claude's file-writing tools all name their target in the input. */
const writeSemantics: ToolSemantics = {
  writePath: (tool) =>
    str(tool.input?.file_path) || str(tool.input?.notebook_path) || null,
};

/** Per-tool contract extras beyond the shared switch-based views. */
const CLAUDE_TOOL_EXTRAS: Record<string, Partial<ToolRenderer>> = {
  Bash: { semantics: bashSemantics },
  Edit: { semantics: writeSemantics },
  Write: { semantics: writeSemantics },
  NotebookEdit: { semantics: writeSemantics },
  Agent: { subagentRows: true },
};

function claudeRenderer(name: string): ToolRenderer {
  return {
    match: name,
    icon: getToolIcon(name),
    summary: (tool) => getToolSummary(asToolCall(tool)),
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    touchedFile: (tool) => getTouchedFile(asToolCall(tool)),
    Input: ({ tool }) => <ToolInputView tool={asToolCall(tool)} />,
    Output: ({ tool }) => <ToolOutputView tool={asToolCall(tool)} />,
    ...CLAUDE_TOOL_EXTRAS[name],
  };
}

export const claudeToolPack: RendererPack = {
  backend: "claude",
  renderers: CLAUDE_TOOL_NAMES.map(claudeRenderer),
};
