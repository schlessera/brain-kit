/**
 * Browser lifecycle for the scraper: crash recovery, and the guard that keeps
 * a dead handle out of the cache.
 *
 * This session was modelled on `@schlessera/brain-render-puppeteer`'s
 * lifecycle but shipped WITHOUT its recovery: a crashed Chrome left the dead
 * handle cached, and every later `load()` failed against it until the process
 * restarted. Copying the shape without the five lines that matter is exactly
 * the kind of thing an untestable seam hides, so the seam came with it.
 */
import { describe, expect, test } from "bun:test";

import { createBrowserSession } from "../src/browser/session.js";

class FakeBrowser {
  private readonly handlers = new Map<string, Array<() => void>>();
  pagesOpened = 0;
  closed = false;
  live = true;

  once(event: string, fn: () => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }

  /** What Chrome dying looks like from puppeteer's side. */
  crash() {
    this.live = false;
    for (const fn of this.handlers.get("disconnected") ?? []) fn();
    this.handlers.delete("disconnected");
  }

  async newPage() {
    if (!this.live) throw new Error("Session closed. Most likely the page has been closed.");
    this.pagesOpened++;
    return {
      setUserAgent: async () => {},
      setBypassServiceWorker: async () => {},
      setRequestInterception: async () => {},
      on: () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      goto: async () => {},
      waitForSelector: async () => {},
      evaluate: async (fn: () => unknown) => fn(),
      close: async () => {},
    };
  }

  async close() {
    this.closed = true;
  }
}

function launcher() {
  const browsers: FakeBrowser[] = [];
  let failNext: Error | null = null;
  return {
    browsers,
    failOnce(err: Error) {
      failNext = err;
    },
    get count() {
      return browsers.length;
    },
    launch: async () => {
      if (failNext) {
        const err = failNext;
        failNext = null;
        throw err;
      }
      const b = new FakeBrowser();
      browsers.push(b);
      return b;
    },
  };
}

const request = { url: "https://example.com/list", extract: () => ["item"] };

describe("crash recovery", () => {
  test("a crashed browser is replaced on the next load", async () => {
    const l = launcher();
    const session = createBrowserSession({ launch: l.launch, idleCloseMs: 60_000 });

    expect(await session.load(request)).toEqual(["item"]);
    expect(l.count).toBe(1);

    l.browsers[0].crash();

    // Before the fix this threw against the dead handle, forever.
    expect(await session.load(request)).toEqual(["item"]);
    expect(l.count).toBe(2);

    await session.close();
  });

  test("a late crash handler does not discard the browser that replaced it", async () => {
    const l = launcher();
    const session = createBrowserSession({ launch: l.launch, idleCloseMs: 60_000 });

    await session.load(request);
    const first = l.browsers[0];
    first.crash();
    await session.load(request);
    expect(l.count).toBe(2);

    first.crash(); // late, and must be a no-op
    await session.load(request);
    expect(l.count).toBe(2);

    await session.close();
  });
});

describe("a failed launch", () => {
  test("is not cached, so a transient failure does not disable scraping", async () => {
    const l = launcher();
    const session = createBrowserSession({ launch: l.launch, idleCloseMs: 60_000 });

    l.failOnce(new Error("no chrome"));
    await expect(session.load(request)).rejects.toThrow("no chrome");

    expect(await session.load(request)).toEqual(["item"]);
    expect(l.count).toBe(1);

    await session.close();
  });
});

describe("ordinary lifecycle", () => {
  test("one browser serves many loads", async () => {
    const l = launcher();
    const session = createBrowserSession({ launch: l.launch, idleCloseMs: 60_000 });

    for (let i = 0; i < 3; i++) await session.load(request);

    expect(l.count).toBe(1);
    expect(l.browsers[0].pagesOpened).toBe(3);
    await session.close();
  });

  test("close shuts down a browser this session launched", async () => {
    const l = launcher();
    const session = createBrowserSession({ launch: l.launch, idleCloseMs: 60_000 });
    await session.load(request);
    await session.close();
    expect(l.browsers[0].closed).toBe(true);
  });
});
