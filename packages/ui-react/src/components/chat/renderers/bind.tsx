/**
 * `bind(contract, Component)` — the client half of D3.
 *
 * The contract owns the payload schema; the component is typed
 * `ToolPayload<contract>`, so a component that reads a field the tool stopped
 * sending is a `tsc` error rather than an empty line in a chat log. At runtime
 * the payload is parsed through the same schema, and a result that does not
 * parse falls through to the caller's fallback view instead of throwing: the
 * work already happened and the reader still wants to see it.
 *
 * One contract produces several renderers, because the same tool has a
 * different name on each backend — `mcp__brain-ui__x` on Claude, bare `x` on
 * pi, plus the pre-rename `mcp__brain_ui__x` that old transcripts carry. The
 * timeline resolves on the raw streamed name, so all three are registered
 * globally rather than scoped to one backend.
 */

import type { ComponentType } from "react";
import {
  parseToolPayload,
  visibleToolName,
  type ToolCallView,
  type ToolComponentContract,
  type ToolPayload,
  type ToolRenderer,
} from "@schlessera/brain-ui-sdk/client";

/** Pre-rename MCP server prefix, still present in resumed transcripts. */
const LEGACY_MCP_PREFIX = "mcp__brain_ui__";

/** Every spelling of a contract's tool name that can arrive in the stream. */
export function boundToolNames(contract: ToolComponentContract): string[] {
  return [
    visibleToolName(contract.name, "pi"),
    visibleToolName(contract.name, "claude"),
    `${LEGACY_MCP_PREFIX}${contract.name}`,
  ];
}

export interface BindOptions<Contract extends ToolComponentContract> {
  icon?: ToolRenderer["icon"];
  label?: string;
  /** Collapsed one-liner, from the parsed payload. */
  summary?: (payload: ToolPayload<Contract>, tool: ToolCallView) => string | null;
  /** Secondary metadata line, from the parsed payload. */
  meta?: (payload: ToolPayload<Contract>, tool: ToolCallView) => string | null;
  /** Input view; the contract does not type this, the tool's own input does. */
  Input?: ToolRenderer["Input"];
  /**
   * Rendered when the output is absent, is prose, or fails the payload schema
   * — an errored call, an older server, a tool that answered with a message.
   */
  Fallback?: ComponentType<{ tool: ToolCallView }>;
}

export function bind<Contract extends ToolComponentContract>(
  contract: Contract,
  Component: ComponentType<ToolPayload<Contract>>,
  options: BindOptions<Contract> = {}
): ToolRenderer[] {
  const { Fallback } = options;

  // TS cannot spread an unresolved generic into JSX, so the spread — and only
  // the spread — goes through an untyped alias. The public parameter above is
  // what carries the guarantee: `Component` must accept the contract's payload.
  const Spread = Component as ComponentType<Record<string, unknown>>;

  function Output({ tool }: { tool: ToolCallView }) {
    const payload = parseToolPayload(contract, tool.output);
    if (payload === null) return Fallback ? <Fallback tool={tool} /> : null;
    return <Spread {...(payload as Record<string, unknown>)} />;
  }

  function fromPayload(
    read: ((payload: ToolPayload<Contract>, tool: ToolCallView) => string | null) | undefined
  ): ((tool: ToolCallView) => string | null) | undefined {
    if (!read) return undefined;
    return (tool: ToolCallView) => {
      const payload = parseToolPayload(contract, tool.output);
      return payload === null ? null : read(payload, tool);
    };
  }

  const renderer: Omit<ToolRenderer, "match"> = {
    ...(options.icon ? { icon: options.icon } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.summary ? { summary: fromPayload(options.summary)! } : {}),
    ...(options.meta ? { meta: fromPayload(options.meta)! } : {}),
    ...(options.Input ? { Input: options.Input } : {}),
    Output,
  };

  return boundToolNames(contract).map((match) => ({ match, ...renderer }));
}
