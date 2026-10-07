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

/** Serve a native sandboxed preview request, which browser fetch mocks cannot intercept. */
export const htmlPreviewFixture: BrowserCommand<[string | null, string?], void> = async (ctx, path, html) => {
  await ctx.page.unroute("**/api/files/html?*");
  if (path === null) return;
  if (!html) throw new Error("HTML preview fixture must contain a document");
  const fixtureOrigin = new URL(ctx.page.url()).origin;
  await ctx.page.route("**/api/files/html?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin) { await route.abort(); return; }
    const requested = url.searchParams.get("path");
    await route.fulfill(requested === path
      ? { status: 200, contentType: "text/html", body: html }
      : { status: 404, contentType: "text/plain", body: "Unknown fixture file" });
  });
};

declare module "vitest/browser" {
  interface BrowserCommands {
    htmlPreviewFixture(path: string | null, html?: string): Promise<void>;
    formViewport(
      width: number,
      height: number,
    ): Promise<{ width: number; height: number }>;
    formConsumerStyles(): Promise<string>;
  }
}


const highlightFailures = new WeakMap<object, number>();
/** Deny the actual lazy module so plain-fence coverage observes a load failure. */
export const codeHighlightFailure: BrowserCommand<[boolean], void> = async (ctx, enabled) => {
  await ctx.page.unroute("**/*rehype-highlight*");
  if (!enabled) { highlightFailures.delete(ctx.page); return; }
  highlightFailures.set(ctx.page, 0);
  await ctx.page.route("**/*rehype-highlight*", async route => {
    highlightFailures.set(ctx.page, (highlightFailures.get(ctx.page) ?? 0) + 1);
    await route.abort();
  });
};
export const codeHighlightFailureCount: BrowserCommand<[], number> = async ctx => highlightFailures.get(ctx.page) ?? 0;
declare module "vitest/browser" {
  interface BrowserCommands {
    codeHighlightFailure(enabled: boolean): Promise<void>;
    codeHighlightFailureCount(): Promise<number>;
  }
}
