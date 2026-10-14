/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

/** Outer browser dimensions prevent Vitest scaling the measured story iframe.
 * Width-specific responsive proof uses page.viewport on that iframe as well. */
export const consumerParityViewport: BrowserCommand<[number | null, { width: number; height: number }?], { width: number; height: number }> = async (ctx, width, restore) => {
  const before = ctx.page.viewportSize();
  if (!before) throw new Error("Consumer parity requires a native viewport");
  await ctx.page.setViewportSize(width === null ? restore! : { width: width + 100, height: 920 });
  await ctx.page.emulateMedia({ reducedMotion: width === null ? null : "reduce" });
  return before;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    consumerParityViewport(width: number | null, restore?: { width: number; height: number }): Promise<{ width: number; height: number }>;
  }
}
