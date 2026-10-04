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
  const styles = await element.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("Test frame is not an HTML element");
    const styles: Array<string | null> = [];
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      styles.push(node.getAttribute("style"));
    }
    element.style.transform = "none";
    element.style.transformOrigin = "top left";
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).transform !== "none") parent.style.transform = "none";
      parent.style.overflow = "visible";
    }
    return styles;
  });
  try {
    await frame.locator("iframe[data-module-settings]").screenshot({ path: resolve(directory, `${name}.png`) });
  } finally {
    await element.evaluate((element, styles) => {
      if (!(element instanceof HTMLElement)) throw new Error("Test frame is not an HTML element");
      let index = 0;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = styles[index++];
        if (style == null) node.removeAttribute("style");
        else node.setAttribute("style", style);
      }
    }, styles);
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { moduleSettingsScreenshot(name: string): Promise<void>; }
}
