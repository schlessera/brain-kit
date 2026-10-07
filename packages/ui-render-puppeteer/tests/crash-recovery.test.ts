/**
 * Browser crash recovery — the five lines that decide whether a renderer
 * survives a dead Chrome or fails every render until the process restarts.
 *
 * ROADMAP carried this as "verified by inspection only" because
 * `puppeteer.launch` was hardcoded, so exercising it meant starting real
 * Chrome and killing it. The `launch` option makes the browser injectable, and
 * a fake one can be crashed on demand and deterministically.
 *
 * This is a lifecycle test, not an isolation test. The isolation posture is
 * still only provable against real Chrome — see the package header and
 * AGENTS.md — and nothing here should be read as covering it.
 */
import { describe, expect, test } from "bun:test";

import { createRenderer, type LaunchArgs } from "../src/renderer.js";

/** The slice of puppeteer's Browser the renderer actually touches. */
class FakeBrowser {
  private readonly handlers = new Map<string, Array<() => void>>();
  closed = false;
  pagesOpened = 0;

  once(event: string, fn: () => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }

  /** Test helper: what Chrome dying looks like from puppeteer's side. */
  disconnectedHandlers() {
    return [...(this.handlers.get("disconnected") ?? [])];
  }

  crash() {
    for (const fn of this.handlers.get("disconnected") ?? []) fn();
    this.handlers.delete("disconnected");
  }

  async newPage() {
    this.pagesOpened++;
    return {
      close: async () => {},
      setJavaScriptEnabled: async () => {},
      setRequestInterception: async () => {},
      on: () => {},
      setDefaultTimeout: () => {},
      setViewport: async () => {},
      setContent: async () => {},
      // The renderer measures the body to clip the screenshot.
      $: async () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }),
      screenshot: async () => new Uint8Array([1, 2, 3]),
      pdf: async () => new Uint8Array([4, 5, 6]),
    };
  }

  async close() {
    this.closed = true;
  }
}

/** A launcher that records every launch and can be told to fail. */
function launcher() {
  const browsers: FakeBrowser[] = [];
  let failNext: Error | null = null;
  const launch = async (_args: LaunchArgs): Promise<never> => {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    const browser = new FakeBrowser();
    browsers.push(browser);
    return browser as unknown as never;
  };
  return {
    browsers,
    launch: launch as never,
    failOnce(err: Error) {
      failNext = err;
    },
    get count() {
      return browsers.length;
    },
  };
}

function renderer(l: ReturnType<typeof launcher>) {
  return createRenderer({
    launch: l.launch,
    executablePath: "/fake/chrome",
    // Keep the browser alive across renders so relaunch counts mean what they
    // look like.
    idleTimeoutMs: 60_000,
  });
}

describe("a crashed browser", () => {
  test("is replaced on the next render rather than reused", async () => {
    const l = launcher();
    const r = renderer(l);

    await r.renderPng({ html: "<p>one</p>" });
    expect(l.count).toBe(1);

    // Chrome dies — OOM is the realistic trigger.
    l.browsers[0].crash();

    await r.renderPng({ html: "<p>two</p>" });
    expect(l.count).toBe(2);
    // The dead handle was not reused.
    expect(l.browsers[1].pagesOpened).toBe(1);

    await r.shutdown();
  });

  test("does not brick the renderer permanently", async () => {
    const l = launcher();
    const r = renderer(l);

    await r.renderPng({ html: "<p>x</p>" });
    l.browsers[0].crash();

    // Several renders after the crash all succeed.
    for (let i = 0; i < 3; i++) {
      expect((await r.renderPng({ html: `<p>${i}</p>` })).length).toBeGreaterThan(0);
    }
    await r.shutdown();
  });

  test("a stale crash handler cannot kill the browser that replaced it", async () => {
    // The `currentLaunch === launch` identity guard. Browser A crashes
    // AFTER B is already serving; without the guard A's handler would null the
    // cache and discard a perfectly good B — a self-inflicted relaunch on
    // every crash, forever.
    const l = launcher();
    const r = renderer(l);

    await r.renderPng({ html: "<p>a</p>" });
    const first = l.browsers[0];
    const lateHandlers = first.disconnectedHandlers();
    expect(lateHandlers).toHaveLength(1);
    first.crash();
    await r.renderPng({ html: "<p>b</p>" }); // B launches
    expect(l.count).toBe(2);

    // Replay the consumed `once` callback against B, rather than emitting
    // another event after the fake has already removed every listener.
    for (const handler of lateHandlers) handler();
    await r.renderPng({ html: "<p>c</p>" });
    expect(l.count).toBe(2);

    await r.shutdown();
  });
});

describe("a failed launch", () => {
  test("is not cached, so a transient failure does not poison the renderer", async () => {
    // The sharpest case: a rejected promise left in the cache is returned to
    // every future caller. One momentary failure — Chrome mid-install, a
    // transient OOM — would fail every render for the life of the process.
    const l = launcher();
    const r = renderer(l);

    l.failOnce(new Error("no chrome today"));
    await expect(r.renderPng({ html: "<p>x</p>" })).rejects.toThrow("no chrome today");

    // The very next render recovers.
    expect((await r.renderPng({ html: "<p>y</p>" })).length).toBeGreaterThan(0);
    expect(l.count).toBe(1); // one SUCCESSFUL launch

    await r.shutdown();
  });

  test("repeated failures keep retrying rather than latching", async () => {
    const l = launcher();
    const r = renderer(l);

    for (let i = 0; i < 3; i++) {
      l.failOnce(new Error(`attempt ${i}`));
      await expect(r.renderPng({ html: "<p>x</p>" })).rejects.toThrow(`attempt ${i}`);
    }
    expect((await r.renderPng({ html: "<p>ok</p>" })).length).toBeGreaterThan(0);

    await r.shutdown();
  });
});
