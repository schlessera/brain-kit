/** Sonnet 5.5 API-price equivalent from usage, independent of SDK fallback prices.
 * Rates verified 2026-10-07: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 * This prices tokens; it is not a subscription billing receipt.
 */
export interface Sonnet55Price {
  lowerUsd: number;
  upperUsd: number;
  unknownCacheTokens: number;
}

function tokens(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Missing or invalid usage: ${field}`);
  }
  return value;
}

export function priceSonnet55Usage(result: {
  modelUsage?: Record<string, { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown; cacheCreationInputTokens?: unknown }>;
  usage?: { cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } };
}): Sonnet55Price {
  const models = Object.entries(result.modelUsage ?? {});
  if (!models.length) throw new Error("Missing model usage");
  let input = 0, output = 0, read = 0, creation = 0;
  for (const [model, usage] of models) {
    if (model !== "claude-sonnet-5-5") throw new Error(`Unpriced auxiliary model: ${model}`);
    input += tokens(usage.inputTokens, "inputTokens");
    output += tokens(usage.outputTokens, "outputTokens");
    read += tokens(usage.cacheReadInputTokens, "cacheReadInputTokens");
    creation += tokens(usage.cacheCreationInputTokens, "cacheCreationInputTokens");
  }
  const ttl = result.usage?.cache_creation;
  const fiveMinutes = tokens(ttl?.ephemeral_5m_input_tokens ?? 0, "5m cache creation");
  const oneHour = tokens(ttl?.ephemeral_1h_input_tokens ?? 0, "1h cache creation");
  if (fiveMinutes + oneHour > creation) throw new Error("Cache TTL counts exceed aggregate creation usage");
  const unknownCacheTokens = creation - fiveMinutes - oneHour;
  const known = (input * 2 + output * 10 + read * 0.2 + fiveMinutes * 2.5 + oneHour * 4) / 1_000_000;
  return { lowerUsd: known + unknownCacheTokens * 2.5 / 1_000_000,
    upperUsd: known + unknownCacheTokens * 4 / 1_000_000, unknownCacheTokens };
}
