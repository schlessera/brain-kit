/**
 * Browser commands that record every request the page makes, read from
 * Playwright on the Node side (#43).
 *
 * A request made on the reader's behalf is the thing the link card must never
 * do, and nothing inside the page can observe that completely: Resource
 * Timing misses a request that failed, and a spy on `fetch` misses an `<img>`,
 * a prefetch or a navigation. Playwright's `request` event sees them all,
 * because it sits on the browser's network stack rather than inside the page.
 *
 * Registered on the `visual` project in `vitest.config.ts`; typed for tests by
 * the `BrowserCommands` augmentation in `link-card.visual.tsx`.
 */
/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";

const logs = new WeakMap<object, string[]>();

/** Starts (or restarts) recording this page's requests. */
export const startRequestLog: BrowserCommand<[]> = async (ctx) => {
  const page = ctx.page;
  const existing = logs.get(page);
  if (existing) {
    existing.length = 0;
    return;
  }
  const log: string[] = [];
  logs.set(page, log);
  // The whole browser context, not the one page: opening a link in a new tab
  // is a new page, and its request is the navigation this exists to catch.
  page.context().on("request", (request) => log.push(request.url()));
};

/** Every request URL recorded since `startRequestLog`. */
export const requestLog: BrowserCommand<[], string[]> = async (ctx) => [...(logs.get(ctx.page) ?? [])];
