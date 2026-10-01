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
  // Detaching resets Chromium to pointer:none. The page owns the session;
  // disabling emulation releases the injected touch input. Vitest disposes
  // this page/context after its final touch cases.
};

declare module "vitest/browser" {
  interface BrowserCommands {
    dictationPointer(touch: boolean): Promise<void>;
  }
}
