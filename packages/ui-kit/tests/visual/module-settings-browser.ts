/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const moduleSettingsScreenshot: BrowserCommand<[string], void> = async (ctx, name) => {
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid screenshot name");
  const directory = resolve("../../.impeccable/review");
  await mkdir(directory, { recursive: true });
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  await element.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Test frame is not an HTML element");
    element.style.transform = "none";
    element.style.transformOrigin = "top left";
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).transform !== "none") parent.style.transform = "none";
      parent.style.overflow = "visible";
    }
  });
  await frame.locator("iframe[data-module-settings]").screenshot({ path: resolve(directory, `${name}.png`) });
};
declare module "vitest/browser" {
  interface BrowserCommands { moduleSettingsScreenshot(name: string): Promise<void>; }
}
