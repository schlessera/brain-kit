/**
 * Runtime policy test — launches REAL Chrome. Unit-testing the
 * shouldAllowRequest predicate is not enough: the WebSocket bypass (rendered
 * HTML reaching ws:// endpoints because request interception cannot see the
 * handshake) was invisible to a predicate test and only showed up here.
 *
 * Whether this file runs is a DECISION, not a side effect of what the machine
 * happens to have installed. `BRAIN_REQUIRE_CHROME=1` — which CI sets — turns
 * a missing Chrome into a failed test file. Without it a missing Chrome skips
 * the file and says so on stderr, because a green run that silently exercised
 * none of this is the failure mode `describe.skipIf` was always going to
 * produce (#66).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { createRenderer } from "../src/renderer";

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const chromePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
const hasChrome = Boolean(chromePath);

if (!hasChrome && process.env.BRAIN_REQUIRE_CHROME === "1") {
  // Thrown at module scope so bun reports the FILE as failing: an image that
  // stops shipping Chrome must break the build, not quietly narrow it.
  throw new Error(
    "BRAIN_REQUIRE_CHROME=1, but no Chrome/Chromium executable was found. " +
      `Looked at: ${CHROME_CANDIDATES.filter(Boolean).join(", ")}. ` +
      "Install google-chrome-stable or point PUPPETEER_EXECUTABLE_PATH at a binary."
  );
}
if (!hasChrome) {
  console.warn(
    "\n*** SKIPPING the puppeteer runtime tests — no Chrome/Chromium found. ***\n" +
      "*** The renderer's isolation posture is NOT covered by this run.     ***\n"
  );
}

/**
 * Wide enough that a slow cold launch is reported as a number rather than
 * converted into a timeout. Nothing asserts against it; see the warm-up.
 */
const WARMUP_BUDGET_MS = 120_000;

const renderers: Array<{ shutdown(): Promise<void> }> = [];
afterAll(async () => {
  for (const r of renderers) await r.shutdown().catch(() => {});
});

function renderer(opts: Parameters<typeof createRenderer>[0] = {}) {
  // 20s is ~10x the warm cost of the slowest render below. It is a bound on a
  // RENDER, which is why the process's first Chrome launch is paid in the
  // warm-up instead of here.
  const r = createRenderer({ renderTimeoutMs: 20_000, ...opts });
  renderers.push(r);
  return r;
}

/**
 * The first Chrome launch in a process is not a render, and charging it to a
 * render budget is what made this file fail intermittently at exactly
 * `renderTimeoutMs` (#66). Measured on ubuntu-latest across six CI runs, the
 * first test took 1.3s, 1.4s, 1.4s, 6.8s, 10.7s and then >20s — while every
 * launch after it, in the same job and each in its own browser, stayed
 * between 0.4s and 2.3s. That spread is the one-time cost of faulting a cold
 * Chrome off a shared disk, not a property of any render.
 *
 * So pay it once, here, outside every assertion, and print what it cost so a
 * CI log records the launch time on that runner rather than leaving it to be
 * inferred from a failure.
 */
beforeAll(async () => {
  if (!hasChrome) return;
  const warm = createRenderer({ renderTimeoutMs: WARMUP_BUDGET_MS });
  const startedAt = Date.now();
  try {
    await warm.renderPng({ html: "<html><body>warm-up</body></html>" });
    console.log(
      `[renderer] cold Chrome launch + first render: ${Date.now() - startedAt}ms ` +
        `(${chromePath})`
    );
  } finally {
    await warm.shutdown();
  }
}, WARMUP_BUDGET_MS + 30_000);

describe.skipIf(!hasChrome)("renderer runtime policy", () => {
  test("renders a PNG (real Buffer) and a PDF", async () => {
    const r = renderer();
    const png = await r.renderPng({ html: "<html><body><h1>hi</h1></body></html>" });
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    const pdf = await r.renderPdf({ html: "<html><body><h1>hi</h1></body></html>" });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 60_000);

  test("scripts do not execute by default, so no channel (incl. WebSocket) can open", async () => {
    // A live local listener the page would reach if scripts ran. Any request
    // — HTTP or WS upgrade — flips `touched`.
    let touched = false;
    const server = Bun.serve({
      port: 0,
      fetch(_req, srv) {
        touched = true;
        if (srv.upgrade(_req)) return undefined;
        return new Response("ok");
      },
      websocket: {
        open() {
          touched = true;
        },
        message() {},
      },
    });
    const url = `http://127.0.0.1:${server.port}/probe`;
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;

    try {
      const r = renderer();
      const html = `<html><body><h1>x</h1>
        <img src="${url}.png">
        <script>
          fetch(${JSON.stringify(url)});
          new WebSocket(${JSON.stringify(wsUrl)});
          document.title = "scripts-ran";
        </script>
      </body></html>`;
      const png = await r.renderPng({ html });
      expect(Buffer.isBuffer(png)).toBe(true);
      // Give any in-flight connection a beat to land before asserting.
      await new Promise((res) => setTimeout(res, 500));
      expect(touched).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("a wedged page hits the budget and frees its slot for the next render", async () => {
    // Scripts must be ON to wedge the page; this is the opt-in path.
    const r = renderer({ renderTimeoutMs: 2_000, allowScripts: true });
    await expect(
      r.renderPng({ html: "<html><body><script>while(true){}</script></body></html>" })
    ).rejects.toThrow(/budget/);

    const png = await r.renderPng({ html: "<html><body>ok</body></html>" });
    expect(Buffer.isBuffer(png)).toBe(true);
  }, 60_000);

  test("an over-wide viewport is clamped instead of allocating unbounded", async () => {
    const r = renderer();
    const png = await r.renderPng({
      html: "<html><body><div style='width:200px'>x</div></body></html>",
      width: 10_000_000,
    });
    expect(Buffer.isBuffer(png)).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasChrome)("renderer hardening regressions", () => {
  test("an allowHosts entry does NOT open the non-interceptable channels", async () => {
    let touched = false;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        touched = true;
        if (srv.upgrade(req)) return undefined;
        return new Response("ok");
      },
      websocket: { open() { touched = true; }, message() {} },
    });
    try {
      // An allowlist for some OTHER host must not blackhole-exempt this one.
      const r = renderer({ allowHosts: ["example.com"], allowScripts: true });
      const html = `<html><head>
          <link rel="prerender" href="http://127.0.0.1:${server.port}/pre">
          <link rel="preconnect" href="http://127.0.0.1:${server.port}">
        </head><body><h1>x</h1>
        <iframe src="http://127.0.0.1:${server.port}/frame"></iframe>
        <script>
          new WebSocket("ws://127.0.0.1:${server.port}/ws");
          window.open("http://127.0.0.1:${server.port}/popup");
          fetch("http://127.0.0.1:${server.port}/f");
        </script>
      </body></html>`;
      await r.renderPng({ html });
      await new Promise((res) => setTimeout(res, 500));
      expect(touched).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("a degenerate body renders instead of throwing a raw Chrome error", async () => {
    const r = renderer();
    const png = await r.renderPng({
      html: "<html><body style='height:0;width:0'></body></html>",
    });
    expect(Buffer.isBuffer(png)).toBe(true);
  }, 60_000);

  test("an enormous body is clamped, not allocated in full", async () => {
    const r = renderer();
    const png = await r.renderPng({
      html: "<html><body><div style='width:50000px;height:50000px'>x</div></body></html>",
    });
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.byteLength).toBeLessThan(40_000_000);
  }, 60_000);

  test("shutdown is terminal — a later render is refused, not silently relaunched", async () => {
    const r = createRenderer({ renderTimeoutMs: 20_000 });
    await r.renderPng({ html: "<html><body>ok</body></html>" });
    await r.shutdown();
    await expect(r.renderPng({ html: "<html><body>again</body></html>" })).rejects.toThrow(
      /shut down/
    );
  }, 60_000);

  // GAP: browser-crash recovery (the "disconnected" handler) is not covered —
  // the Browser handle is private to createRenderer, so a test would need an
  // injection seam. The handler is one line and verified by inspection.
});
