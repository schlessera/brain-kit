// Generic, backend-agnostic tool renderer — the fallback tier where unknown
// tools (a new backend, pi's curated tools) still render decently. It sniffs
// the tool's input/output SHAPE rather than its name, reusing the same view
// components the Claude pack uses.

import type { RendererPack, ToolRenderer, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { FileText } from "lucide-react";
import type { ToolCall } from "../../../stores/chat-store.js";
import {
  getOutputMeta,
  EditDiffView,
  WriteFileView,
  BashCommandView,
  KeyValueView,
  ClampedPre,
  FileRowsView,
  splitGrepRow,
} from "../tool-views.js";

const asToolCall = (tool: ToolCallView) => tool as unknown as ToolCall;

function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Input rendered by input SHAPE: diff, written file, terminal command, else key/value. */
function GenericInput({ tool }: { tool: ToolCallView }) {
  const t = asToolCall(tool);
  const input = t.input ?? {};
  if (str(input.old_string) && str(input.new_string)) {
    return <EditDiffView tool={t} />;
  }
  if ((str(input.file_path) || str(input.path)) && str(input.content)) {
    // WriteFileView reads `file_path`; alias `path` so `{path, content}` tools render too.
    const aliased = str(input.file_path)
      ? t
      : ({ ...t, input: { ...input, file_path: input.path } } as ToolCall);
    return <WriteFileView tool={aliased} />;
  }
  if (str(input.command) || str(input.cmd)) {
    const aliased = str(input.command)
      ? t
      : ({ ...t, input: { ...input, command: input.cmd } } as ToolCall);
    return <BashCommandView tool={aliased} />;
  }
  return <KeyValueView tool={t} />;
}

/** Output rendered by output SHAPE: error, `path:line:` rows, else clamped text. */
function GenericOutput({ tool }: { tool: ToolCallView }) {
  const t = asToolCall(tool);
  if (!t.output) return null;
  if (t.isError) return <ClampedPre text={t.output} isError />;
  if (looksLikeFileRows(t.output)) return <FileRowsView output={t.output} />;
  return <ClampedPre text={t.output} />;
}

/** True when most non-empty lines look like ripgrep-style `path:line:content`. */
function looksLikeFileRows(output: string): boolean {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (lines.length === 0) return false;
  const matches = lines.filter((l) => splitGrepRow(l) !== null).length;
  return matches >= Math.ceil(lines.length / 2);
}

/**
 * The catch-all renderer. Registered as a low-scoring predicate so it applies
 * to any tool no more specific renderer claimed, and exported for the timeline
 * to use as an explicit fallback.
 */
export const GENERIC_RENDERER: ToolRenderer = {
  match: () => 0.1,
  icon: FileText,
  meta: (tool) => getOutputMeta(asToolCall(tool)),
  Input: GenericInput,
  Output: GenericOutput,
};

export const genericToolPack: RendererPack = {
  renderers: [GENERIC_RENDERER],
};
