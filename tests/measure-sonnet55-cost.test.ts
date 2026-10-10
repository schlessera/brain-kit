import { expect, test } from "bun:test";
import { priceSonnet55Usage } from "../scripts/measure-sonnet55-cost.ts";

const review = {
  modelUsage: { "claude-sonnet-5-5": { inputTokens: 2, outputTokens: 2028, cacheReadInputTokens: 0, cacheCreationInputTokens: 14838 } },
  usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 14838 } },
};

test("raw review usage has an independently calculated exact official price", () => {
  const price = priceSonnet55Usage(review);
  // 2 fresh tokens at $2/M, 14,838 one-hour writes at $4/M, 2,028 outputs at $10/M.
  expect(price.lowerUsd).toBeCloseTo(0.079636, 12);
  expect(price.upperUsd).toBeCloseTo(0.079636, 12);
  expect(price.unknownCacheTokens).toBe(0);
});

test("missing TTL produces an interval and conservatively prices every write at one hour", () => {
  const price = priceSonnet55Usage({ modelUsage: review.modelUsage });
  expect(price.lowerUsd).toBeCloseTo(0.057379, 12);
  expect(price.upperUsd).toBeCloseTo(0.079636, 12);
  expect(price.unknownCacheTokens).toBe(14838);
});

test("mixed TTL and cache-read prices use each independent official rate", () => {
  const price = priceSonnet55Usage({
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 1000 } },
    usage: { cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 400 } },
  });
  // 100 input at $2/M, 200 output at $10/M, 500 reads at $0.10/M, 300 5m at $2.50/M, 400 1h at $4/M,
  // and 300 writes of unknown TTL priced at $2.50/M (lower) or $4/M (upper).
  expect(price.lowerUsd).toBeCloseTo(0.00535, 12);
  expect(price.upperUsd).toBeCloseTo(0.0058, 12);
  expect(price.unknownCacheTokens).toBe(300);
});

test("cache reads price at Sonnet 5.5's $0.10/M, not the $0.20/M the 2026-10-07 table showed", () => {
  // 100 input at $2/M, 10 output at $10/M and 100,000 cache reads at $0.10/M, with no writes.
  // At $0.20/M the same usage would cost $0.0203 (#1239).
  const price = priceSonnet55Usage({
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 0 } },
  });
  expect(price.lowerUsd).toBeCloseTo(0.0103, 12);
  expect(price.upperUsd).toBeCloseTo(0.0103, 12);
  expect(price.unknownCacheTokens).toBe(0);
});

test("missing, malformed and unknown auxiliary usage cannot read as zero", () => {
  expect(() => priceSonnet55Usage({})).toThrow("Missing model usage");
  expect(() => priceSonnet55Usage({ modelUsage: { "claude-sonnet-5-5": { ...review.modelUsage["claude-sonnet-5-5"], outputTokens: NaN } } })).toThrow("Missing or invalid usage");
  expect(() => priceSonnet55Usage({ modelUsage: { ...review.modelUsage, "claude-haiku-4-5": review.modelUsage["claude-sonnet-5-5"] } })).toThrow("Unpriced auxiliary model");
  expect(() => priceSonnet55Usage({ ...review, usage: { cache_creation: { ephemeral_1h_input_tokens: 14839 } } })).toThrow("exceed aggregate");
});
