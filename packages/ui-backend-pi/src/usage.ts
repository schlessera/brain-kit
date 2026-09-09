import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelUsage, TurnUsage } from "@schlessera/brain-ui-sdk/server";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/server";

import type { PiSessionLike } from "./backend-options.js";

/** Lifetime session cost, or null when the runtime cannot report it. */
export function snapshotCost(session: PiSessionLike): number | null {
  try {
    const cost = session.getSessionStats().cost;
    return Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

/**
 * Turn cost = after - before. Returns undefined (→ omit `costUsd`) when either
 * snapshot is unavailable: the protocol defines 0 as "actually free", so an
 * unknown cost must not be reported as zero.
 */
export function turnCost(
  before: number | null,
  after: number | null
): number | undefined {
  if (before === null || after === null) return undefined;
  return Math.max(0, after - before);
}

/**
 * Sums per-message token usage across one turn. pi delivers a full `Usage`
 * (tokens + cost breakdown) on every assistant message; message_end is the
 * settled value for that message, so summing message_end events yields the
 * turn's tokens. Cost stays with the session-stats diff (`turnCost`) — the
 * authoritative number — while per-model cost sums ride the breakdown.
 */
export interface TurnUsageAccumulator {
  observe(ev: AgentSessionEvent): void;
  /** The wire usage block, or undefined when nothing was observed. */
  toWire(): TurnUsage | undefined;
}

export function createUsageAccumulator(): TurnUsageAccumulator {
  const perModel = new Map<string, ModelUsage>();
  return {
    observe(ev) {
      // turn_end re-delivers the LAST assistant message, which message_end
      // already counted — only message_end accumulates.
      if (ev.type !== "message_end") return;
      // ev is narrowed to the message_end variant ({ message: AgentMessage });
      // the role check narrows AgentMessage to pi-ai's AssistantMessage, whose
      // usage (tokens + cost) and model are required fields — no casts needed.
      const { message } = ev;
      if (!("role" in message) || message.role !== "assistant") return;
      // Runtime tolerance beyond the type: a usage-less assistant message (a
      // custom AgentMessage claiming the role) carries nothing to count.
      const usage: Usage | undefined = message.usage;
      if (!usage) return;
      const entry = perModel.get(message.model) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      entry.inputTokens = (entry.inputTokens ?? 0) + (usage.input ?? 0);
      entry.outputTokens = (entry.outputTokens ?? 0) + (usage.output ?? 0);
      entry.cacheReadTokens = (entry.cacheReadTokens ?? 0) + (usage.cacheRead ?? 0);
      entry.cacheCreationTokens =
        (entry.cacheCreationTokens ?? 0) + (usage.cacheWrite ?? 0);
      if (typeof usage.cost?.total === "number") {
        entry.costUsd = (entry.costUsd ?? 0) + usage.cost.total;
      }
      perModel.set(message.model, entry);
    },
    toWire() {
      if (perModel.size === 0) return undefined;
      const breakdown: Record<string, ModelUsage> = {};
      for (const [model, usage] of perModel) breakdown[model] = usage;
      // Per-model costUsd sums ride the breakdown untouched; sumModelUsage
      // rolls up tokens only, leaving top-level cost to the session-stats diff.
      return sumModelUsage(breakdown);
    },
  };
}
