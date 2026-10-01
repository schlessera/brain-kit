/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Keep Vitest's portrait iframe at full painted scale when capturing a long card. */
export const formViewport: BrowserCommand<
  [number, number],
  { width: number; height: number }
> = async (ctx, width, height) => {
  const before = ctx.page.viewportSize();
  if (!before) throw new Error("Browser viewport is unavailable");
  await ctx.page.setViewportSize({ width: width + 100, height: height + 120 });
  return before;
};
/** Read the stylesheet the React consumer actually ships, without Storybook's CSS. */
export const formConsumerStyles: BrowserCommand<[], string> = async () =>
  readFile(resolve("../ui-react/dist/styles.css"), "utf8");

declare module "vitest/browser" {
  interface BrowserCommands {
    formViewport(
      width: number,
      height: number,
    ): Promise<{ width: number; height: number }>;
    formConsumerStyles(): Promise<string>;
  }
}
