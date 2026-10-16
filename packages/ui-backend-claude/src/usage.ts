import type { ModelUsage, TurnUsage } from "@schlessera/brain-ui-sdk/server";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/server";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

/** Messages API deltas are cumulative, not token increments. Count a response
 * once, at message_stop. Block-granularity assistant messages are not receipts.
 * A new message_start clears the tool boundary before any partial output.
 */
export class CompletedResponseUsage {
  private readonly models: Record<string, ModelUsage> = {};
  private readonly seen = new Set<string>();
  private readonly current = new Map<string, { id: string; model: string; usage: ModelUsage; tool: boolean }>();
  private receipt(atToolBoundary: boolean) {
    return Object.keys(this.models).length ? { usage: sumModelUsage(structuredClone(this.models)), atToolBoundary } : undefined;
  }
  snapshot(): TurnUsage | undefined { return this.receipt(false)?.usage; }
  observe(event: StreamEvent, channel = "root"): { usage: TurnUsage; atToolBoundary: boolean } | undefined {
    if (event.type === "message_start") {
      const m = event.message, u = m.usage;
      this.current.set(channel, { id: m.id, model: m.model, tool: false, usage: {
        inputTokens: u.input_tokens, outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      } });
      return this.receipt(false);
    }
    const current = this.current.get(channel);
    if (event.type === "message_delta" && current) {
      // Some runtimes supply updated input/cache counts here too. Never add a
      // cumulative delta to the message_start counts.
      const u = event.usage;
      for (const [source, target] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"],
        ["cache_read_input_tokens", "cacheReadTokens"], ["cache_creation_input_tokens", "cacheCreationTokens"]] as const) {
        const n = u[source];
        if (n != null) current.usage[target] = n;
      }
      current.tool = event.delta.stop_reason === "tool_use";
    }
    if (event.type !== "message_stop" || !current) return undefined;
    const response = current;
    this.current.delete(channel);
    if (this.seen.has(response.id)) return undefined;
    const values = Object.values(response.usage);
    if (!response.id || !response.model || values.length !== 4 || values.some(n => !Number.isSafeInteger(n) || n! < 0)) return this.receipt(false);
    this.seen.add(response.id);
    const total = this.models[response.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const)
      total[key] = total[key]! + response.usage[key]!;
    this.models[response.model] = total;
    return this.receipt(response.tool);
  }
}

/** Build the wire usage block from a result message's accounting. */
export function usageFromResult(msg: {
  usage?: unknown;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
}): TurnUsage | undefined {
  const models = msg.modelUsage;
  if (!models || Object.keys(models).length === 0) return undefined;
  const perModel: Record<string, ModelUsage> = {};
  for (const [model, u] of Object.entries(models)) {
    perModel[model] = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadInputTokens,
      cacheCreationTokens: u.cacheCreationInputTokens,
      costUsd: u.costUSD,
    };
  }
  return sumModelUsage(perModel);
}
