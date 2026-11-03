/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Visual-review captures for #3281, written to `.vitest-attachments/status-indicator/`
 * at the repository root. Review artifacts only, never baseline inputs. The
 * whole test frame is captured so the top-layer dialog and the portalled
 * tooltip are included.
 */
export const statusCapture: BrowserCommand<[string]> = async (ctx, name) => {
  const directory = resolve("../../.vitest-attachments/status-indicator");
  await mkdir(directory, { recursive: true });
  const frame = await (await ctx.frame()).frameElement();
  await frame.screenshot({ path: resolve(directory, `${name}.png`), animations: "disabled" });
};

declare module "vitest/browser" {
  interface BrowserCommands { statusCapture(name: string): Promise<void>; }
}
