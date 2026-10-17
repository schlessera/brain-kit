/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Actual focused paint, retained for corner review as well as pixel assertions. */
export const focusCapture: BrowserCommand<[string, string], string> = async (ctx, selector, name) => {
  const directory = resolve(".vitest-attachments/focus-frames");
  await mkdir(directory, { recursive: true });
  const png = await ctx.iframe.locator(selector).screenshot({ path: resolve(directory, `${name}.png`) });
  return png.toString("base64");
};
declare module "vitest/browser" {
  interface BrowserCommands { focusCapture(selector: string, name: string): Promise<string>; }
}
