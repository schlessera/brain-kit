import { expect, test } from "bun:test";
import { chooseThreshold, quality, type QualityRow } from "../scripts/evals/canonical-conflicts/metrics";

test("retrieval misses, abstention and failed receipts retain independent denominators", () => {
  const base: QualityRow = { id: "fixture", split: "held-out", arm: "hybrid", repetition: 0, conflict: "yes", retrieved: true,
    reported: true, abstained: false, failure: null, destructiveEffects: 0, durationMs: 10, calls: 2,
    inputTokens: null, outputTokens: null, apiEquivalentUsd: null, additionalBilledUsd: null };
  const result = quality([base, { ...base, retrieved: false, reported: false, abstained: true },
    { ...base, conflict: "no", reported: true }, { ...base, failure: "Missing physical usage", reported: false }]);
  expect(result.semanticPositives).toBe(2); expect(result.retrievedPositives).toBe(1); expect(result.retrievalRecall).toBe(0.5);
  expect(result.precision).toBe(0.5); expect(result.recall).toBe(0.5); expect(result.failures).toBe(1); expect(result.completeComparison).toBe(false);
});

test("thin tuning admission is null without accepted positive evidence and cannot read held-out rows", () => {
  expect(chooseThreshold([{ split: "tuning", threshold: 0.9, conflict: "no", reported: false, failure: null }])).toBeNull();
  expect(chooseThreshold([{ split: "tuning", threshold: 0.9, conflict: "unknown", reported: true, failure: null }])).toBeNull();
  expect(chooseThreshold([{ split: "tuning", threshold: 0.9, conflict: "yes", reported: true, failure: null }])).toBe(0.9);
  expect(() => chooseThreshold([{ split: "held-out", threshold: 0.7, conflict: "yes", reported: true, failure: null }])).toThrow("Held-out");
});
