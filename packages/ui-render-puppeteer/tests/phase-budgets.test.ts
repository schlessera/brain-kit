import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import { createRenderer, type Renderer, type RendererOptions } from "../src/renderer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Policy proof with doubles only: native Chromium cleanup duration is covered elsewhere.
// A native event-loop turn drains real promise continuations before we inspect state;
// no fixed microtask count is used as an operation-completion signal.
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

type Timer = { at: number; ms: number; callback: () => void; state: "pending" | "fired" | "cleared" };
class Clock {
  now = 0;
  timers: Timer[] = [];
  readonly descriptors = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!,
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!,
  };
  install() {
    Object.defineProperty(globalThis, "setTimeout", { ...this.descriptors.setTimeout,
      value: (callback: () => void, ms: number) => {
        const timer: Timer = { at: this.now + ms, ms, callback, state: "pending" };
        this.timers.push(timer);
        return timer;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", { ...this.descriptors.clearTimeout,
      value: (timer?: Timer) => { if (timer?.state === "pending") timer.state = "cleared"; },
    });
  }
  pending(ms: number) { return this.timers.filter(t => t.state === "pending" && t.ms === ms); }
  async registered(ms: number, count = 1) {
    await turn();
    expect(this.pending(ms).length).toBe(count);
    return this.pending(ms)[count - 1]!;
  }
  async advance(ms: number) {
    const target = this.now + ms;
    await turn();
    for (;;) {
      const next = this.timers.filter(t => t.state === "pending" && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      next.state = "fired";
      next.callback();
      await turn();
    }
    this.now = target;
    await turn();
  }
  restore() {
    Object.defineProperties(globalThis, this.descriptors);
  }
}
let clock: Clock;
beforeEach(() => { clock = new Clock(); clock.install(); });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function outcome<T>(promise: Promise<T>, ms = 400) {
  // The failure ceiling stays real and independent of logical time.
  let timer: ReturnType<typeof setTimeout>;
  const result = Promise.race([
    promise.then(value => ({ status: "ok" as const, value }), error => ({ status: "error" as const, message: String(error) })),
    new Promise<{ status: "pending" }>(resolve => { timer = nativeSetTimeout(() => resolve({ status: "pending" }), ms); }),
  ]).finally(() => nativeClearTimeout(timer));
  return result;
}

async function expire<T>(promise: Promise<T>, ms: number) {
  let settled = false;
  const result = outcome(promise).then(value => { settled = true; return value; });
  const deadline = await clock.registered(ms);
  await clock.advance(ms - 1);
  expect(deadline.state).toBe("pending");
  expect(settled).toBe(false);
  await clock.advance(1);
  expect(deadline.state).toBe("fired");
  return result;
}

class FakePage {
  closes = 0;
  screenshots = 0;
  configured = 0;
  content = async () => {};
  capture = async () => new Uint8Array([1, 2, 3]);
  async close() { this.closes++; }
  async setJavaScriptEnabled() { this.configured++; }
  async setRequestInterception() {}
  on() {}
  setDefaultTimeout() {}
  async setViewport() {}
  async setContent() { await this.content(); }
  async $() { return { boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }; }
  async screenshot() { this.screenshots++; return this.capture(); }
  async pdf() { return this.capture(); }
  asPage() { return this as unknown as Page; }
}
class FakeBrowser {
  closes = 0;
  pages = 0;
  open = async () => new FakePage();
  handlers: Array<() => void> = [];
  once(_event: string, fn: () => void) { this.handlers.push(fn); }
  async newPage() {
    if (this.closes > 0) throw new Error("Using a closed browser");
    this.pages++;
    return (await this.open()).asPage();
  }
  async close() { this.closes++; for (const fn of this.handlers) fn(); }
  asBrowser() { return this as unknown as Browser; }
}

const renderers: Renderer[] = [];
function renderer(options: RendererOptions) {
  const r = createRenderer({ executablePath: "/fake/chrome", idleTimeoutMs: 60_000, ...options });
  renderers.push(r);
  return r;
}
async function dispose() {
  try {
    const shutdown = Promise.all(renderers.splice(0).map(r => r.shutdown()));
    let done = false;
    void shutdown.then(() => { done = true; });
    // Failed assertions may leave acquisition, rendering or cleanup in flight.
    // Drive their actual registered callbacks, without adding a cleanup seam.
    for (let i = 0; !done && i < 20; i++) {
      await turn();
      const next = clock.timers.filter(t => t.state === "pending").sort((a,b) => a.at - b.at)[0];
      if (next) await clock.advance(next.at - clock.now);
    }
    expect(done).toBe(true);
    expect(clock.timers.filter(t => t.state === "pending")).toEqual([]);
    await shutdown;
  } finally {
    // Even a failed cleanup assertion must leave no callable fake timers behind.
    for (const timer of clock.timers) if (timer.state === "pending") timer.state = "cleared";
    clock.restore();
  }
}
afterEach(dispose);
const html = { html: "<p>phase budgets</p>" };

describe("renderer phase budgets", () => {
  test("invalid phase budgets and capacity settings are refused", () => {
    for (const name of ["queueTimeoutMs", "browserTimeoutMs", "renderTimeoutMs"] as const) {
      for (const value of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
        expect(() => createRenderer({ [name]: value })).toThrow(name);
      }
    }
    expect(() => createRenderer({ maxConcurrent: 0 })).toThrow("maxConcurrent");
    expect(() => createRenderer({ maxQueue: -1 })).toThrow("maxQueue");
  });

  test("shutdown racing immediate acquisition cannot start a launch", async () => {
    let launches = 0;
    const r = renderer({ launch: async () => { launches++; return new FakeBrowser().asBrowser(); } });
    const result = outcome(r.renderPng(html));
    await r.shutdown();
    expect(await result).toEqual({ status: "error", message: "Error: Renderer has been shut down" });
    expect(launches).toBe(0);
  });

  test("idle closure waits for active renders and the next call relaunches", async () => {
    const browsers: FakeBrowser[] = [];
    const r = renderer({ idleTimeoutMs: 30, renderTimeoutMs: 200, launch: async () => {
      const browser = new FakeBrowser();
      browser.open = async () => {
        const page = new FakePage();
        page.capture = async () => { await delay(60); return new Uint8Array([1]); };
        return page;
      };
      browsers.push(browser);
      return browser.asBrowser();
    } });
    const first = outcome(r.renderPng(html));
    await clock.registered(60);
    await clock.advance(59);
    expect(browsers[0].closes).toBe(0);
    await clock.advance(1);
    expect((await first).status).toBe("ok");
    expect(browsers[0].closes).toBe(0);
    const idle = await clock.registered(30);
    await clock.advance(29);
    expect(browsers[0].closes).toBe(0);
    await clock.advance(1);
    expect(idle.state).toBe("fired");
    expect(browsers[0].closes).toBe(1);
    const second = outcome(r.renderPng(html));
    await clock.registered(60);
    await clock.advance(60);
    expect((await second).status).toBe("ok");
    const rearmed = await clock.registered(30);
    expect(rearmed).not.toBe(idle);
    // Starting work cancels the previous idle callback and completion rearms it.
    const third = outcome(r.renderPng(html));
    await clock.registered(60);
    expect(rearmed.state).toBe("cleared");
    await clock.advance(60);
    expect((await third).status).toBe("ok");
    await clock.registered(30);
    expect(browsers.length).toBe(2);
    expect(browsers[1].closes).toBe(0);
  });
  test("a slow launch leaves the full rendering allowance available", async () => {
    const browser = new FakeBrowser();
    const page = new FakePage();
    page.capture = async () => { await delay(80); return new Uint8Array([1, 2, 3]); };
    browser.open = async () => page;
    const r = renderer({ browserTimeoutMs: 200, renderTimeoutMs: 120, launch: async () => { await delay(80); return browser.asBrowser(); } });
    const pending = outcome(r.renderPng(html));
    const acquisition = await clock.registered(200);
    await clock.registered(80);
    await clock.advance(80);
    expect(acquisition.state).toBe("cleared");
    const rendering = await clock.registered(120);
    await clock.registered(80);
    await clock.advance(79);
    expect(rendering.state).toBe("pending");
    await clock.advance(1);
    const result = await pending;
    expect(rendering.state).toBe("cleared");
    expect(result.status).toBe("ok");
    expect(page.screenshots).toBe(1);
    expect(page.closes).toBe(1);
    await clock.advance(200);
    expect(page.closes).toBe(1);
    expect(page.screenshots).toBe(1);
  });

  test("queue expiry rejects while the slot is held and removes the expired waiter", async () => {
    const browser = new FakeBrowser();
    const held = deferred<void>();
    const entered = deferred<void>();
    browser.open = async () => {
      const page = new FakePage();
      if (browser.pages === 1) page.content = async () => { entered.resolve(); await held.promise; };
      return page;
    };
    const r = renderer({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 30, renderTimeoutMs: 500, launch: async () => browser.asBrowser() });
    const first = outcome(r.renderPng(html));
    await entered.promise;
    const expired = await expire(r.renderPng(html), 30);
    // This assertion runs before freeing the occupied slot.
    expect(expired).toEqual({ status: "error", message: "Error: Render queue exceeded 30ms budget" });
    const survivor = outcome(r.renderPng(html));
    held.resolve();
    expect((await first).status).toBe("ok");
    expect((await survivor).status).toBe("ok");
    expect(browser.pages).toBe(2);
  });

  test("a never-resolving launch times out and the next render launches again", async () => {
    const browser = new FakeBrowser();
    let launches = 0;
    const r = renderer({ maxConcurrent: 1, browserTimeoutMs: 30, renderTimeoutMs: 100, launch: () => ++launches === 1 ? new Promise<Browser>(() => {}) : Promise.resolve(browser.asBrowser()) });
    expect(await expire(r.renderPng(html), 30)).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 30ms budget" });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect(launches).toBe(2);
    expect(browser.pages).toBe(1);
    expect((await outcome(r.shutdown())).status).toBe("ok");
  });

  test("a never-resolving newPage times out in rendering and frees capacity", async () => {
    const browser = new FakeBrowser();
    browser.open = () => browser.pages === 1 ? new Promise<FakePage>(() => {}) : Promise.resolve(new FakePage());
    const r = renderer({ maxConcurrent: 1, browserTimeoutMs: 200, renderTimeoutMs: 30, launch: async () => browser.asBrowser() });
    expect(await expire(r.renderPng(html), 30)).toEqual({ status: "error", message: "Error: Render exceeded 30ms budget" });
    expect((await outcome(r.renderPdf(html))).status).toBe("ok");
    expect(browser.pages).toBe(2);
  });

  test("an abandoned late launch is closed without opening a page or replacing the recovery browser", async () => {
    const late = deferred<Browser>();
    const abandoned = new FakeBrowser();
    const replacement = new FakeBrowser();
    let launches = 0;
    const r = renderer({ browserTimeoutMs: 30, renderTimeoutMs: 100, launch: () => ++launches === 1 ? late.promise : Promise.resolve(replacement.asBrowser()) });
    expect(await expire(r.renderPng(html), 30)).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 30ms budget" });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    late.resolve(abandoned.asBrowser());
    await turn();
    expect(abandoned.closes).toBe(1);
    expect(abandoned.pages).toBe(0);
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect(launches).toBe(2);
    expect(replacement.closes).toBe(0);
  });

  test("a late page is closed without configuring or capturing it", async () => {
    const late = deferred<FakePage>();
    const browser = new FakeBrowser();
    const page = new FakePage();
    browser.open = () => browser.pages === 1 ? late.promise : Promise.resolve(new FakePage());
    const r = renderer({ maxConcurrent: 1, renderTimeoutMs: 30, launch: async () => browser.asBrowser() });
    expect((await expire(r.renderPng(html), 30)).status).toBe("error");
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    late.resolve(page);
    await turn();
    expect(page.closes).toBe(1);
    expect(page.configured).toBe(0);
    expect(page.screenshots).toBe(0);
  });

  test("one acquisition timeout does not abandon a shared launch needed by a newer waiter", async () => {
    const launched = deferred<Browser>();
    const browser = new FakeBrowser();
    let launches = 0;
    const r = renderer({ maxConcurrent: 2, browserTimeoutMs: 200, renderTimeoutMs: 200, launch: () => { launches++; return launched.promise; } });
    const first = outcome(r.renderPng(html));
    await clock.registered(200);
    await clock.advance(50);
    const second = outcome(r.renderPdf(html));
    const newer = await clock.registered(200, 2);
    await clock.advance(149);
    expect(newer.state).toBe("pending");
    await clock.advance(1);
    expect(newer.state).toBe("pending");
    expect(await first).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 200ms budget" });
    launched.resolve(browser.asBrowser());
    expect((await second).status).toBe("ok");
    expect(newer.state).toBe("cleared");
    await clock.advance(50);
    expect(browser.pages).toBe(1);
    expect(browser.closes).toBe(0);
    expect(launches).toBe(1);
  });

  test("one rendering timeout does not close another active render's browser", async () => {
    const browser = new FakeBrowser();
    const pages: FakePage[] = [];
    browser.open = async () => {
      const page = new FakePage();
      pages.push(page);
      if (browser.pages === 1) page.content = () => new Promise<void>(() => {});
      else page.capture = async () => { await delay(160); return new Uint8Array([1]); };
      return page;
    };
    const r = renderer({ maxConcurrent: 2, renderTimeoutMs: 200, launch: async () => browser.asBrowser() });
    const first = outcome(r.renderPng(html));
    await clock.registered(200);
    await clock.advance(70);
    const second = outcome(r.renderPng(html));
    const newer = await clock.registered(200, 2);
    await clock.registered(160);
    await clock.advance(129);
    expect(pages[0].closes).toBe(0);
    await clock.advance(1);
    expect(newer.state).toBe("pending");
    expect((await first).status).toBe("error");
    await clock.advance(30);
    expect((await second).status).toBe("ok");
    expect(newer.state).toBe("cleared");
    expect(browser.closes).toBe(0);
    expect(pages.map(p => p.closes)).toEqual([1, 1]);
  });

  test("a timed-out content operation cannot later start a capture", async () => {
    const content = deferred<void>();
    const page = new FakePage();
    page.content = () => content.promise;
    const browser = new FakeBrowser();
    browser.open = async () => page;
    const r = renderer({ renderTimeoutMs: 30, launch: async () => browser.asBrowser() });
    expect((await expire(r.renderPng(html), 30)).status).toBe("error");
    content.resolve();
    await turn();
    expect(page.screenshots).toBe(0);
    expect(page.closes).toBe(1);
  });

  test("shutdown rejects queued calls and drains a wedged acquisition within its phase bound", async () => {
    const launched = deferred<Browser>();
    const entered = deferred<void>();
    const browser = new FakeBrowser();
    const r = renderer({ maxConcurrent: 1, browserTimeoutMs: 30, renderTimeoutMs: 100, queueTimeoutMs: 200, launch: () => { entered.resolve(); return launched.promise; } });
    const active = outcome(r.renderPng(html));
    await entered.promise;
    const queued = outcome(r.renderPng(html));
    const stopped = outcome(r.shutdown(), 300);
    expect(await queued).toEqual({ status: "error", message: "Error: Renderer has been shut down" });
    await clock.registered(30);
    await clock.advance(29);
    expect(browser.closes).toBe(0);
    await clock.advance(1);
    expect((await active).status).toBe("error");
    expect((await stopped).status).toBe("ok");
    launched.resolve(browser.asBrowser());
    await turn();
    expect(browser.closes).toBe(1);
    expect(browser.pages).toBe(0);
    expect((await outcome(r.renderPng(html)))).toEqual({ status: "error", message: "Error: Renderer has been shut down" });
  });

  test("shutdown lets an active shared launch/render finish and closes the browser once", async () => {
    const launched = deferred<Browser>();
    const entered = deferred<void>();
    const browser = new FakeBrowser();
    const r = renderer({ browserTimeoutMs: 200, renderTimeoutMs: 100, launch: () => { entered.resolve(); return launched.promise; } });
    const active = outcome(r.renderPng(html));
    await entered.promise;
    const shutdown = r.shutdown();
    launched.resolve(browser.asBrowser());
    expect((await active).status).toBe("ok");
    expect((await outcome(shutdown)).status).toBe("ok");
    expect(browser.pages).toBe(1);
    expect(browser.closes).toBe(1);
    await r.shutdown();
    expect(browser.closes).toBe(1);
  });

  test("a wedged page close cannot retain capacity or block shutdown", async () => {
    const page = new FakePage();
    page.close = () => new Promise<void>(() => {});
    const browser = new FakeBrowser();
    browser.open = async () => page;
    browser.close = () => new Promise<void>(() => {});
    const r = renderer({ maxConcurrent: 1, renderTimeoutMs: 100, launch: async () => browser.asBrowser() });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    const stopped = outcome(r.shutdown(), 2_500);
    let settled = false;
    void stopped.then(() => { settled = true; });
    const cleanup = await clock.registered(2_000);
    await clock.advance(1_999);
    expect(settled).toBe(false);
    expect(cleanup.state).toBe("pending");
    await clock.advance(1);
    expect(cleanup.state).toBe("fired");
    expect((await stopped).status).toBe("ok");
    expect(browser.pages).toBe(2);
  });

  test("failed assertion cleanup drains owned callbacks and restores complete descriptors", async () => {
    const browser = new FakeBrowser();
    browser.close = () => { browser.closes++; return new Promise<void>(() => {}); };
    const r = renderer({ browserTimeoutMs: 30, launch: async () => browser.asBrowser() });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    try {
      throw new Error("synthetic assertion failure");
    } catch (error) {
      expect(String(error)).toContain("synthetic assertion failure");
    } finally {
      await dispose();
    }
    expect(browser.closes).toBe(1);
    expect(clock.timers.some(t => t.ms === 2_000 && t.state === "fired")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(globalThis, "setTimeout")).toEqual(clock.descriptors.setTimeout);
    expect(Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")).toEqual(clock.descriptors.clearTimeout);
  });
});
