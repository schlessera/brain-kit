/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

type ViewportState = { width: number; height: number; reducedMotion: "reduce" | "no-preference" };

/** Outer browser dimensions prevent Vitest scaling the measured story iframe.
 * Width-specific responsive proof uses page.viewport on that iframe as well. */
export const consumerParityViewport: BrowserCommand<[number | null, ViewportState?], ViewportState> = async (ctx, width, restore) => {
  const viewport = ctx.page.viewportSize();
  if (!viewport) throw new Error("Consumer parity requires a native viewport");
  const before: ViewportState = { ...viewport, reducedMotion: await ctx.page.evaluate(() =>
    matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference") };
  const apply = async (state: ViewportState) => {
    const errors: unknown[] = [];
    try { await ctx.page.setViewportSize({ width: state.width, height: state.height }); } catch (error) { errors.push(error); }
    try { await ctx.page.emulateMedia({ reducedMotion: state.reducedMotion }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Consumer outer viewport restoration failed");
  };
  if (width === null) {
    if (!restore) throw new Error("Consumer parity restoration requires captured state");
    await apply(restore);
  } else {
    try { await apply({ width: width + 100, height: 920, reducedMotion: "reduce" }); }
    catch (error) {
      try { await apply(before); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Consumer outer viewport setup and cleanup failed");
      }
      throw error;
    }
  }
  return before;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    consumerParityViewport(width: number | null, restore?: ViewportState): Promise<ViewportState>;
  }
}
