/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

/**
 * A real mouse click at a frame point. Playwright's locator click waits for
 * an `aria-disabled` control to become enabled, so it can never prove that a
 * disabled chip ignores a click; the mouse has no such precondition.
 */
export const overlayMouse: BrowserCommand<[{ x: number; y: number }]> = async (ctx, point) => {
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const bounds = await element.boundingBox();
  if (!bounds) throw new Error("Overlay test frame has no painted bounds");
  const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Vitest scales its iframe when the viewport is larger than the host.
  const x = point.x * (bounds.width / viewport.width) + bounds.x;
  const y = point.y * (bounds.height / viewport.height) + bounds.y;
  await ctx.page.mouse.click(x, y);
};

declare module "vitest/browser" {
  interface BrowserCommands {
    overlayMouse(point: { x: number; y: number }): Promise<void>;
  }
}
