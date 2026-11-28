/**
 * Fast output rates (#4310). The host's pricing catalogs carry standard
 * rates only, and a fast request costs more, so a fast session's Claude usage
 * is priced from this table or not at all; never at a standard rate.
 *
 * Source: the price table in the pinned Claude Code runtime (CLI 2.1.293,
 * bundled with Agent SDK 0.3.293), which prices a request whose `speed` is
 * `fast` at these per-million-token rates. The 5-minute cache-write rate is
 * used, as for standard rates. Update it with the runtime pin.
 */
import type { PricingRoute } from "@schlessera/brain-ui-sdk/protocol";
import type { PricingRates } from "./model-pricing.js";

const PER_MILLION = 1_000_000;
const rates = (input: number, output: number, cacheWrite: number, cacheRead: number): PricingRates => ({
  input: input / PER_MILLION, output: output / PER_MILLION, cacheWrite: cacheWrite / PER_MILLION, cacheRead: cacheRead / PER_MILLION,
  // Copied from the runtime's table, not read from a live catalog.
  estimate: true, source: "snapshot",
});

export const FAST_OUTPUT_RATES: Readonly<Record<string, PricingRates>> = Object.freeze({
  "claude-opus-5-5": rates(8, 40, 10, 0.4),
  "claude-opus-5": rates(10, 50, 12.5, 1),
  "claude-opus-4-8": rates(10, 50, 12.5, 1),
  "claude-opus-4-7": rates(30, 150, 37.5, 3),
  "claude-opus-4-6": rates(30, 150, 37.5, 3),
});

interface Resolver { resolve(modelId: string, route?: PricingRoute): PricingRates | null }

/**
 * The resolver for a fast session's usage: a Claude model at its fast rate,
 * or unpriced when the table has none, so it never reads as a standard price.
 * Any other provider's model (an independent CLI provider completion) keeps
 * its ordinary rate.
 */
export function fastOutputPricing<T extends Resolver>(base: T): Resolver {
  return {
    resolve(modelId, route) {
      const fast = FAST_OUTPUT_RATES[modelId];
      if (fast) return fast;
      return modelId.startsWith("claude-") ? null : base.resolve(modelId, route);
    },
  };
}

/** The resolver for a run at `speed`. */
export function pricingForSpeed<T extends Resolver>(base: T, speed: "fast" | "standard" | null | undefined): Resolver {
  return speed === "fast" ? fastOutputPricing(base) : base;
}
