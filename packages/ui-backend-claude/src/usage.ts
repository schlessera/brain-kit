import type { ModelUsage, TurnUsage } from "@schlessera/brain-ui-sdk/server";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/server";

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
