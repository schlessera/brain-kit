/** Sonnet 5.5 API-price equivalent from usage, independent of SDK fallback prices.
 * This prices tokens; it is not a subscription billing receipt.
 */

/**
 * Sonnet 5.5 Standard list rates in USD per million tokens, verified
 * 2026-10-10 at https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
 * and https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing.
 * Cache reads are 0.05x input. On 2026-10-07 the model table still showed
 * $0.20/M for reads while the caching section said $0.10/M (#1239). Amounts
 * stored before this change used $0.20/M; they are historical diagnostics,
 * not current list prices, and are not recomputed.
 */
export const SONNET55_USD_PER_MTOK = { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 } as const;
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
  const r = SONNET55_USD_PER_MTOK;
  const known = (input * r.input + output * r.output + read * r.cacheRead + fiveMinutes * r.cacheWrite5m + oneHour * r.cacheWrite1h) / 1_000_000;
  return { lowerUsd: known + unknownCacheTokens * r.cacheWrite5m / 1_000_000,
    upperUsd: known + unknownCacheTokens * r.cacheWrite1h / 1_000_000, unknownCacheTokens };
}
