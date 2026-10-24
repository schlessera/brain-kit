/**
 * List prices for the brain CLI's relayed provider requests (#1673).
 *
 * Completion tokens use the same Activity pricing table as the agent's own
 * inference. Embeddings are not in either remote catalog, so the built-in
 * embedding model carries one dated row here. Image usage stays unpriced: its
 * token classes have per-modality rates no table here holds, and the CLI's own
 * per-image estimate is not a provider receipt. An unpriced attempt with
 * reported tokens counts toward the unpriced-token stops; an attempt without
 * reported usage is unknown spend, never zero, and never blocks by itself.
 */
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import { priceUsage, type RollupPricing } from "../activity/store.js";

/**
 * Per-token USD input rates by modality, Gemini Developer API standard paid
 * tier, from https://ai.google.dev/gemini-api/docs/pricing as read on
 * 2026-10-23: text $0.20 and image $0.45 per million input tokens. Other
 * modalities (documents, audio, video) have no row and stay unpriced.
 */
export const GEMINI_EMBEDDING_PRICES: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  "gemini-embedding-2": Object.freeze({ TEXT: 0.2 / 1_000_000, IMAGE: 0.45 / 1_000_000 }),
});

export interface PricedProviderAttempt {
  /** List price of this attempt, or null when unknown. */
  costUsd: number | null;
  /** Null when there is no price; true when the rate is a dated or fallback estimate. */
  estimate: boolean | null;
  /** Every token the provider reported for this attempt, or null when it reported none. */
  tokens: number | null;
}

export function priceProviderAttempt(receipt: Pick<ProviderRelayReceipt, "family" | "operation" | "model" | "usage" | "inlineMedia">,
  pricing: RollupPricing): PricedProviderAttempt {
  const usage = receipt.usage;
  const classes = usage ? [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens] : [];
  const tokens = classes.some(value => value !== undefined) ? classes.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  if (!usage || tokens === null || !receipt.model) return { costUsd: null, estimate: null, tokens };
  if (receipt.family === "gemini" && receipt.operation === "embeddings") {
    const rates = GEMINI_EMBEDDING_PRICES[receipt.model.replace(/^models\//, "")];
    if (!rates || usage.outputTokens || usage.cacheReadTokens || usage.cacheCreationTokens) return { costUsd: null, estimate: null, tokens };
    // Split by modality when the provider does; otherwise only a request
    // without inline media is known to be all text.
    const byModality = usage.inputByModality ?? (receipt.inlineMedia ? undefined : { TEXT: usage.inputTokens ?? 0 });
    if (!byModality) return { costUsd: null, estimate: null, tokens };
    let costUsd = 0;
    for (const [modality, count] of Object.entries(byModality)) {
      if (count === 0) continue;
      const rate = rates[modality];
      if (rate === undefined) return { costUsd: null, estimate: null, tokens };
      costUsd += count * rate;
    }
    // A bundled dated rate is an estimate, as the Activity snapshot's rates are.
    return { costUsd, estimate: true, tokens };
  }
  if (receipt.operation !== "completions") return { costUsd: null, estimate: null, tokens };
  const counts = { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0, cacheCreationTokens: usage.cacheCreationTokens ?? 0 };
  // The catalogs key Gemini models with a `gemini/` prefix and Anthropic ones bare.
  const ids = receipt.family === "gemini" ? [`gemini/${receipt.model}`, receipt.model] : [receipt.model];
  for (const id of ids) {
    if (!pricing.resolve(id, "direct")) continue;
    const priced = priceUsage({ [id]: counts }, pricing, "direct");
    return priced ? { costUsd: priced.costUsd, estimate: priced.estimate, tokens } : { costUsd: null, estimate: null, tokens };
  }
  return { costUsd: null, estimate: null, tokens };
}
