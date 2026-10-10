// pi backend tool-renderer pack. pi's curated tools are lowercase snake_case
// (`bash`, `read_file`, …) with their own input shapes, so they get their own
// backend-scoped renderers instead of riding the shape-sniffing generic tier.
// Views are the same shared components the Claude pack composes; only the
// field mapping differs.

import type {
  RendererPack,
  ToolRenderer,
  ToolCallView,
  ToolSemantics,
} from "@schlessera/brain-ui-sdk/client";
import { SearchResultsOutput } from "../tool-cards/search-results.js";
import type { ToolCall } from "../../../stores/chat-store.js";
import {
  getToolIcon,
  getOutputMeta,
  toRepoRelative,
  EditDiffView,
  WriteFileView,
  BashCommandView,
  KeyValueView,
  ClampedPre,
  FileRowsView,
} from "../tool-views.js";

const asToolCall = (tool: ToolCallView) => tool as unknown as ToolCall;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** pi names its path input `path`; the shared views read `file_path`. */
function withFilePath(tool: ToolCallView): ToolCall {
  const t = asToolCall(tool);
  return str(t.input?.file_path)
    ? t
    : ({ ...t, input: { ...t.input, file_path: t.input?.path } } as ToolCall);
}

function pathSummary(tool: ToolCallView): string | null {
  const path = str(tool.input?.path);
  return path ? toRepoRelative(path) ?? path : null;
}

const writeSemantics: ToolSemantics = {
  writePath: (tool) => str(tool.input?.path) || null,
};

function DefaultOutput({ tool }: { tool: ToolCallView }) {
  if (!tool.output) return null;
  return <ClampedPre text={tool.output} isError={tool.isError} />;
}

const PI_RENDERERS: ToolRenderer[] = [
  {
    match: "bash",
    icon: getToolIcon("Bash"),
    summary: (tool) => str(tool.input?.command) || null,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    semantics: { command: (tool) => str(tool.input?.command) || null },
    Input: ({ tool }) => <BashCommandView tool={asToolCall(tool)} />,
    Output: DefaultOutput,
  },
  {
    match: "read_file",
    icon: getToolIcon("Read"),
    summary: pathSummary,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    Input: ({ tool }) => <KeyValueView tool={asToolCall(tool)} />,
    Output: DefaultOutput,
  },
  {
    match: "write_file",
    icon: getToolIcon("Write"),
    summary: pathSummary,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    touchedFile: (tool) => str(tool.input?.path) || null,
    semantics: writeSemantics,
    Input: ({ tool }) => <WriteFileView tool={withFilePath(tool)} />,
    Output: DefaultOutput,
  },
  {
    match: "edit_file",
    icon: getToolIcon("Edit"),
    summary: pathSummary,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    touchedFile: (tool) => str(tool.input?.path) || null,
    semantics: writeSemantics,
    Input: ({ tool }) => <EditDiffView tool={withFilePath(tool)} />,
    Output: DefaultOutput,
  },
  {
    match: "grep",
    icon: getToolIcon("Grep"),
    summary: (tool) => {
      const pattern = str(tool.input?.pattern);
      if (!pattern) return null;
      const path = str(tool.input?.path);
      return path ? `${pattern} in ${toRepoRelative(path) ?? path}` : pattern;
    },
    meta: (tool) => {
      const t = asToolCall(tool);
      if (t.output && !t.isError && t.output.trim() !== "No matches.") {
        const rows = t.output.split("\n").filter(Boolean).length;
        return `${rows} match${rows === 1 ? "" : "es"}`;
      }
      return getOutputMeta(t);
    },
    Input: ({ tool }) => <KeyValueView tool={asToolCall(tool)} />,
    Output: ({ tool }) =>
      tool.output && !tool.isError ? (
        <FileRowsView output={tool.output} />
      ) : (
        <DefaultOutput tool={tool} />
      ),
  },
  {
    match: "brain_search",
    icon: getToolIcon("Grep"),
    summary: (tool) => str(tool.input?.query) || null,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    Input: ({ tool }) => <KeyValueView tool={asToolCall(tool)} />,
    Output: SearchResultsOutput,
  },
  {
    match: "brain_context",
    icon: getToolIcon("Read"),
    summary: (tool) => str(tool.input?.query) || null,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    Input: ({ tool }) => <KeyValueView tool={asToolCall(tool)} />,
    Output: DefaultOutput,
  },
  {
    match: "brain_add",
    icon: getToolIcon("Write"),
    summary: (tool) => str(tool.input?.title) || str(tool.input?.type) || null,
    meta: (tool) => getOutputMeta(asToolCall(tool)),
    Input: ({ tool }) => <KeyValueView tool={asToolCall(tool)} />,
    Output: DefaultOutput,
  },
];

export const piToolPack: RendererPack = {
  backend: "pi",
  renderers: PI_RENDERERS,
};
