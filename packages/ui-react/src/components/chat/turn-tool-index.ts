/**
 * Each turn's tool calls, built once per messages array (#4513). Every
 * mounted tool safety indicator and the session safety list read the same
 * index, so a streamed update that replaces the array costs one build, not
 * one per indicator.
 */
import { SHOW_BLOCK_CONTRACT } from "@schlessera/brain-ui-sdk/client";
import type { ChatMessage, ToolCall } from "../../stores/chat-store.js";
import { isAskExchangeTool, isShowBlockTool } from "../../lib/tool-names.js";
import { cachedToolPayload } from "./renderers/payload-cache.js";

interface TurnTools {
  /** The calls drawn as timeline steps, in drawn order: the steps that carry a safety indicator. */
  readonly steps: readonly ToolCall[];
  /** Every call of the turn, drawn or not. */
  readonly calls: readonly ToolCall[];
}

/** The calls a message draws as timeline steps. An ask exchange and an
 * inline block draw no step (`groupParts`, message-bubble.tsx). */
export function timelineSteps(message: ChatMessage): ToolCall[] {
  return message.parts.flatMap((part) => {
    const tool = part.kind === "tool" ? message.toolCalls[part.toolIndex] : undefined;
    return tool && !isAskExchangeTool(tool.name) && !(isShowBlockTool(tool.name) && cachedToolPayload(SHOW_BLOCK_CONTRACT, tool)) ? [tool] : [];
  });
}

const cache = new WeakMap<readonly ChatMessage[], ReadonlyMap<string, TurnTools>>();
let builds = 0;

export function turnToolIndex(messages: readonly ChatMessage[]): ReadonlyMap<string, TurnTools> {
  const cached = cache.get(messages);
  if (cached) return cached;
  builds++;
  const index = new Map<string, { steps: ToolCall[]; calls: ToolCall[] }>();
  for (const message of messages) {
    const turn = message.turnId ?? message.streamTurnId;
    if (!turn || !message.toolCalls.length) continue;
    const entry = index.get(turn) ?? { steps: [], calls: [] };
    entry.steps.push(...timelineSteps(message));
    entry.calls.push(...message.toolCalls);
    index.set(turn, entry);
  }
  cache.set(messages, index);
  return index;
}

/** @internal How many indexes have been built; for tests. */
export function turnToolIndexBuilds(): number {
  return builds;
}
