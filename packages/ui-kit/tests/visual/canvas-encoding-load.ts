/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

interface EncodingLoad {
  frame: number;
  frames: number;
  workMs: number;
  until: number;
}
type LoadWindow = Window & { __canvasEncodingLoad?: EncodingLoad };

/** Starve native idle encoding while ordinary tasks and the original preview poll still run. */
export const canvasEncodingLoad: BrowserCommand<[boolean], { frames: number; workMs: number }> = async (ctx, enabled) => {
  if (!enabled) {
    const result = await ctx.iframe.locator("body").evaluate(() => {
      const scope = window as LoadWindow;
      const load = scope.__canvasEncodingLoad;
      if (!load) return { frames: 0, workMs: 0 };
      cancelAnimationFrame(load.frame);
      delete scope.__canvasEncodingLoad;
      return { frames: load.frames, workMs: load.workMs };
    });
    await ctx.page.mouse.up();
    return result;
  }

  // A held native input prevents long idle periods. Frame work consumes the
  // short periods; neither the encoder nor its callback is mocked or delayed.
  await ctx.page.mouse.move(1400, 900);
  await ctx.page.mouse.down();
  try {
    await ctx.iframe.locator("body").evaluate(() => {
      const scope = window as LoadWindow;
      const load: EncodingLoad = { frame: 0, frames: 0, workMs: 0, until: performance.now() + 2000 };
      scope.__canvasEncodingLoad = load;
      const frame = () => {
        if (scope.__canvasEncodingLoad !== load || performance.now() >= load.until) return;
        const start = performance.now();
        while (performance.now() - start < 18) { /* Consume this frame's idle budget. */ }
        load.frames++;
        load.workMs += performance.now() - start;
        load.frame = requestAnimationFrame(frame);
      };
      load.frame = requestAnimationFrame(frame);
    });
  } catch (error) {
    await ctx.page.mouse.up();
    throw error;
  }
  return { frames: 0, workMs: 0 };
};

declare module "vitest/browser" {
  interface BrowserCommands {
    canvasEncodingLoad(enabled: boolean): Promise<{ frames: number; workMs: number }>;
  }
}
