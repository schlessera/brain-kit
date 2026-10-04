/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Hold a real mouse press while the browser assertions inspect :active. */
export const buttonPointer: BrowserCommand<["down" | "up"], void> = async (ctx, phase) => {
  if (phase === "down") await ctx.page.mouse.down();
  else await ctx.page.mouse.up();
};

/** Review captures, rather than replacement baselines, of the established palette. */
export const buttonCapture: BrowserCommand<[string], void> = async (ctx, name) => {
  const directory = resolve(".vitest-attachments/button-hover");
  await mkdir(directory, { recursive: true });
  await ctx.iframe.locator("[data-button-gallery]").screenshot({ path: resolve(directory, `${name}.png`) });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    buttonPointer(phase: "down" | "up"): Promise<void>;
    buttonCapture(name: string): Promise<void>;
  }
}
