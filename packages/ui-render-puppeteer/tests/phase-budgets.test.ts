import { afterEach, describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import { createRenderer, type Renderer, type RendererOptions } from "../src/renderer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function outcome<T>(promise: Promise<T>, ms = 400) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(value => ({ status: "ok" as const, value }), error => ({ status: "error" as const, message: String(error) })),
      new Promise<{ status: "pending" }>(resolve => { timer = setTimeout(() => resolve({ status: "pending" }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
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
afterEach(async () => {
  for (const r of renderers.splice(0)) await outcome(r.shutdown(), 500);
});
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
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect(browsers[0].closes).toBe(0);
    await delay(60);
    expect(browsers[0].closes).toBe(1);
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect(browsers.length).toBe(2);
    expect(browsers[1].closes).toBe(0);
  });
  test("a slow launch leaves the full rendering allowance available", async () => {
    const browser = new FakeBrowser();
    const page = new FakePage();
    page.capture = async () => { await delay(80); return new Uint8Array([1, 2, 3]); };
    browser.open = async () => page;
    const r = renderer({ browserTimeoutMs: 200, renderTimeoutMs: 120, launch: async () => { await delay(80); return browser.asBrowser(); } });
    const result = await outcome(r.renderPng(html));
    expect(result.status).toBe("ok");
    expect(page.screenshots).toBe(1);
    expect(page.closes).toBe(1);
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
    const expired = await outcome(r.renderPng(html), 100);
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
    expect(await outcome(r.renderPng(html))).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 30ms budget" });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    expect(launches).toBe(2);
    expect(browser.pages).toBe(1);
    expect((await outcome(r.shutdown())).status).toBe("ok");
  });

  test("a never-resolving newPage times out in rendering and frees capacity", async () => {
    const browser = new FakeBrowser();
    browser.open = () => browser.pages === 1 ? new Promise<FakePage>(() => {}) : Promise.resolve(new FakePage());
    const r = renderer({ maxConcurrent: 1, browserTimeoutMs: 200, renderTimeoutMs: 30, launch: async () => browser.asBrowser() });
    expect(await outcome(r.renderPng(html))).toEqual({ status: "error", message: "Error: Render exceeded 30ms budget" });
    expect((await outcome(r.renderPdf(html))).status).toBe("ok");
    expect(browser.pages).toBe(2);
  });

  test("an abandoned late launch is closed without opening a page or replacing the recovery browser", async () => {
    const late = deferred<Browser>();
    const abandoned = new FakeBrowser();
    const replacement = new FakeBrowser();
    let launches = 0;
    const r = renderer({ browserTimeoutMs: 30, renderTimeoutMs: 100, launch: () => ++launches === 1 ? late.promise : Promise.resolve(replacement.asBrowser()) });
    expect(await outcome(r.renderPng(html))).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 30ms budget" });
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    late.resolve(abandoned.asBrowser());
    await delay(5);
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
    expect((await outcome(r.renderPng(html))).status).toBe("error");
    expect((await outcome(r.renderPng(html))).status).toBe("ok");
    late.resolve(page);
    await delay(5);
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
    await delay(50);
    const second = outcome(r.renderPdf(html));
    expect(await first).toEqual({ status: "error", message: "Error: Browser acquisition exceeded 200ms budget" });
    launched.resolve(browser.asBrowser());
    expect((await second).status).toBe("ok");
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
    await delay(70);
    const second = outcome(r.renderPng(html));
    expect((await first).status).toBe("error");
    expect((await second).status).toBe("ok");
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
    expect((await outcome(r.renderPng(html))).status).toBe("error");
    content.resolve();
    await delay(5);
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
    expect((await active).status).toBe("error");
    expect((await stopped).status).toBe("ok");
    launched.resolve(browser.asBrowser());
    await delay(5);
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
    expect((await outcome(r.shutdown(), 2_500)).status).toBe("ok");
    expect(browser.pages).toBe(2);
  });
});
