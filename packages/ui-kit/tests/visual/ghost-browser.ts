/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

/** Chromium evaluates the real media queries: no matchMedia stub, no class. */
export const ghostMedia: BrowserCommand<["reduce" | "no-preference", "screen" | "print"]> = async (ctx, reducedMotion, media) => {
  await ctx.page.emulateMedia({ reducedMotion, media });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    ghostMedia(reducedMotion: "reduce" | "no-preference", media: "screen" | "print"): Promise<void>;
  }
}
