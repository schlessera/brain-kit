/// <reference types="@vitest/browser-playwright" />
import type { CDPSession } from "playwright";
import type { BrowserCommand } from "vitest/node";

const sessions = new WeakMap<object, CDPSession>();

/** Exercise Chromium's real pointer media queries, rather than mocking matchMedia. */
export const dictationPointer: BrowserCommand<[boolean]> = async (ctx, touch) => {
  let session = sessions.get(ctx.page);
  if (!session) {
    session = await ctx.page.context().newCDPSession(ctx.page);
    sessions.set(ctx.page, session);
  }
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 1 });
  // Disabling emulation releases touch input but does not restore a fine
  // pointer; detaching also leaves pointer:none. The dictation-only project
  // owns this page/session until its provider closes. Never use this command
  // on the shared visual project's page.
};

declare module "vitest/browser" {
  interface BrowserCommands {
    dictationPointer(touch: boolean): Promise<void>;
  }
}
