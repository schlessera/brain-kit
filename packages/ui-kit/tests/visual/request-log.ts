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

/**
 * Every request URL recorded since `startRequestLog`.
 * `settle` opens a fresh, empty child document and waits for its native network
 * idle, then the page's (which includes child frames). A fresh navigation is
 * essential: a previously reached load state can return immediately. The child
 * fetches a fresh same-origin URL; every request still reaches real Vite.
 * This observes work initiated before the call, not arbitrary future timers.
 */
export const requestLog: BrowserCommand<[options?: { settle: boolean }], string[]> = async (ctx, options) => {
  if (options?.settle) {
    const url = new URL(ctx.page.url());
    url.searchParams.set("request-log-boundary", crypto.randomUUID());
    const probeUrl = url.href;
    const id = `request-log-${crypto.randomUUID()}`;
    try {
      const attached = ctx.page.waitForEvent("frameattached");
      await ctx.page.evaluate(({ id, probeUrl }) => {
        const frame = document.createElement("iframe");
        frame.id = id;
        frame.hidden = true;
        frame.srcdoc = `<!doctype html><title>Request log boundary</title><script>
          fetch(${JSON.stringify(probeUrl)}, { cache: "no-store" })
            .then(response => { if (!response.ok) throw new Error("Boundary fetch failed"); return response.arrayBuffer(); })
            .then(() => document.documentElement.dataset.complete = "true");
        </script>`;
        document.body.append(frame);
      }, { id, probeUrl });
      const frame = await attached;
      await frame.waitForURL("about:srcdoc", { waitUntil: "networkidle" });
      await frame.waitForFunction(() => document.documentElement.dataset.complete === "true");
      await ctx.page.waitForLoadState("networkidle");
    } finally {
      await ctx.page.evaluate(id => document.getElementById(id)?.remove(), id);
    }
  }
  return [...(logs.get(ctx.page) ?? [])];
};
