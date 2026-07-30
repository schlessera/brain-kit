/**
 * Runtime policy test — launches REAL Chrome. Unit-testing the
 * shouldAllowRequest predicate is not enough: the WebSocket bypass (rendered
 * HTML reaching ws:// endpoints because request interception cannot see the
 * handshake) was invisible to a predicate test and only showed up here.
 *
 * Skipped when no Chrome/Chromium is installed.
 */
import { afterAll, describe, expect, test } from "bun:test";
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
const hasChrome = CHROME_CANDIDATES.some((p) => p && existsSync(p));

const renderers: Array<{ shutdown(): Promise<void> }> = [];
afterAll(async () => {
  for (const r of renderers) await r.shutdown().catch(() => {});
});

function renderer(opts: Parameters<typeof createRenderer>[0] = {}) {
  const r = createRenderer({ renderTimeoutMs: 20_000, ...opts });
  renderers.push(r);
  return r;
}

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
