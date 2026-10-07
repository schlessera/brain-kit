/**
 * A browser command that grants the page's origin the microphone permission
 * from Playwright's side, the way a user's "Allow" changes it (#1012). The
 * page sees a real permission change; nothing inside the page is stubbed.
 */
/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

export const grantMicrophone: BrowserCommand<[]> = async (ctx) => {
  const origin = new URL(ctx.page.url()).origin;
  await ctx.page.context().grantPermissions(["microphone"], { origin });
};
