import type { BridgeContext, BridgeSlice } from "./context.js";

/**
 * A bridge tool that wrote into the scratch area prunes it through the
 * host's pass (#310), the way the CLI's own writers prune after a write.
 */
export function createScratch(ctx: Pick<BridgeContext, "host">): Partial<BridgeSlice<"pruneScratch">> {
  const { host } = ctx;
  return host.scratchPrune ? { pruneScratch: host.scratchPrune } : {};
}
