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

/** The fallback text view of a renderer that failed: the text it would copy, never a link. */
function ShownText({ tool, renderer }: { tool: ToolCallView; renderer: ToolRenderer }) {
  if (!tool.output) return null;
  let text: string | null;
  try { text = renderer.copyText!(tool); } catch { text = null; }
  if (text === null) return <p className="text-xs text-muted-foreground">This output can't be shown.</p>;
  return <ClampedPre text={text} isError={tool.isError} linkify={false} />;
}

const shownTextRenderers = new WeakMap<ToolRenderer, ToolRenderer>();

/**
 * What the timeline shows when a renderer throws. A renderer with `copyText`
 * has said how its output may be shown and copied (a Gmail result: hidden
 * characters as markers), so its fallback keeps that text, unlinked, for both,
 * and shows no input. Any other renderer falls back to the generic one.
 * One object per failed renderer, so its Output keeps its identity across
 * renders.
 */
export function fallbackRenderer(failed: ToolRenderer | null): ToolRenderer {
  if (!failed?.copyText) return GENERIC_RENDERER;
  let shown = shownTextRenderers.get(failed);
  if (!shown) {
    shown = {
      match: GENERIC_RENDERER.match,
      icon: GENERIC_RENDERER.icon,
      Output: ({ tool }) => <ShownText tool={tool} renderer={failed} />,
      copyText: (tool) => failed.copyText!(tool),
    };
    shownTextRenderers.set(failed, shown);
  }
  return shown;
}

export const genericToolPack: RendererPack = {
  renderers: [GENERIC_RENDERER],
};
