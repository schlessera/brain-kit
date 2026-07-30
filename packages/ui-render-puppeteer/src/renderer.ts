/**
 * Server-side HTML → PNG/PDF rendering on headless Chrome, isolated for what
 * it is: a renderer for CALLER-SUPPLIED HTML running next to personal data.
 *
 * Security posture (why this is its own optional package):
 * - JavaScript is DISABLED by default. Request interception cannot see
 *   WebSocket handshakes, so with JS on, rendered HTML could SSRF into any
 *   ws:// endpoint reachable from the host. Share cards are static — callers
 *   that truly need scripts must opt in via `allowScripts` and accept that
 *   the ws channel opens up.
 * - Network is DENIED by default: request interception allows only data: and
 *   about:blank, and (unless `allowRequest` is provided) DNS resolution is
 *   disabled outright via --host-resolver-rules. Inline everything.
 * - Every render is bounded by a wall-clock budget (browser launch and page
 *   creation included) and a concurrency cap with a bounded queue.
 * - The browser is launched lazily and closed after an idle period; a render
 *   in flight always cancels a pending idle close.
 * - The Chromium sandbox stays ON by default. Containers that lack the
 *   privileges for it must opt in with `noSandbox: true` (weaker: a renderer
 *   exploit then lands on the host user).
 */
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { existsSync } from "node:fs";

import { Semaphore } from "./semaphore";

const CHROME_PATH_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const MIN_VIEWPORT_WIDTH = 320;
const MAX_VIEWPORT_WIDTH = 4096;
/** Cap on captured page height — bounds the screenshot allocation. */
const MAX_CAPTURE_HEIGHT = 16_384;

function resolveChromePath(explicit?: string): string {
  for (const p of [explicit, ...CHROME_PATH_CANDIDATES]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    "No Chrome/Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH or install google-chrome-stable."
  );
}

/**
 * Default network policy: only navigation-free, network-free content loads.
 * `data:` (inline assets) and `about:blank` (the setContent document) are the
 * whole allowlist; everything else — http(s), ws(s), file:, blob: — is denied.
 * (WebSocket handshakes bypass interception entirely, which is why script
 * execution is separately disabled by default.)
 */
export function shouldAllowRequest(url: string): boolean {
  return url.startsWith("data:") || url === "about:blank";
}

export interface RendererOptions {
  /** Chrome executable. Default: PUPPETEER_EXECUTABLE_PATH / BRAIN_UI_CHROME_PATH / well-known paths. */
  executablePath?: string;
  /** Per-render wall-clock budget (ms), browser launch included. Default 30_000. */
  renderTimeoutMs?: number;
  /** Max renders in flight; further calls queue (bounded). Default 2. */
  maxConcurrent?: number;
  /** Max renders WAITING behind the concurrency cap before "renderer busy". Default 16. */
  maxQueue?: number;
  /** Close the browser after this long without a render (ms). Default 5 min. */
  idleTimeoutMs?: number;
  /**
   * Escape hatch for callers that must load remote assets. Return true to let
   * a request through. Combined with (not replacing) the data:/about:blank
   * allowlist. Providing this also re-enables DNS resolution in the browser.
   * Default: nothing extra is allowed and DNS is disabled.
   */
  allowRequest?: (url: string) => boolean;
  /**
   * Execute the document's JavaScript. DANGEROUS with untrusted HTML: request
   * interception does not cover WebSocket handshakes, so scripts can reach
   * ws:// endpoints. Default false.
   */
  allowScripts?: boolean;
  /**
   * Launch Chrome WITHOUT its sandbox. Required in most containers (no
   * user-namespace privileges) but strictly weaker — opt-in. Default false.
   */
  noSandbox?: boolean;
}

export interface RenderOptions {
  html: string;
  /** Viewport width for layout (px), clamped to [320, 4096]. Default 768. */
  width?: number;
}

export interface Renderer {
  renderPng(opts: RenderOptions): Promise<Buffer>;
  renderPdf(opts: RenderOptions): Promise<Buffer>;
  shutdown(): Promise<void>;
}

export function createRenderer(options: RendererOptions = {}): Renderer {
  const renderTimeoutMs = options.renderTimeoutMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const semaphore = new Semaphore(options.maxConcurrent ?? 2, options.maxQueue ?? 16);
  const noSandbox = options.noSandbox ?? false;
  const allowScripts = options.allowScripts ?? false;

  let browserPromise: Promise<Browser> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
      const executablePath = resolveChromePath(options.executablePath);
      const launched = puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
          // Without an allowRequest escape hatch nothing may touch the
          // network — kill DNS at the browser level as a second layer that
          // also covers channels interception can't see (WebSockets).
          ...(options.allowRequest ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND']),
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
      browserPromise = launched;
      launched.catch(() => {
        if (browserPromise === launched) browserPromise = null;
      });
      return launched;
    }
    return browserPromise;
  }

  function scheduleIdleClose(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (inFlight > 0) return; // a live render re-schedules when it finishes
    idleTimer = setTimeout(async () => {
      const p = browserPromise;
      browserPromise = null;
      idleTimer = null;
      if (p) {
        try {
          const b = await p;
          await b.close();
        } catch {
          // ignore
        }
      }
    }, idleTimeoutMs);
  }

  function onRequest(request: HTTPRequest): void {
    const url = request.url();
    if (shouldAllowRequest(url) || options.allowRequest?.(url)) {
      void request.continue();
    } else {
      void request.abort("blockedbyclient");
    }
  }

  function clampWidth(width: number | undefined): number {
    const w = width ?? 768;
    return Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.floor(w)));
  }

  async function withPage<T>(
    opts: RenderOptions,
    produce: (page: Page) => Promise<T>
  ): Promise<T> {
    const release = await semaphore.acquire();
    // A render is now committed: cancel any pending idle close so the browser
    // can't be torn down underneath it.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    inFlight++;
    let page: Page | null = null;
    try {
      // The budget covers EVERYTHING — browser launch and newPage included —
      // so a wedged launch can't hold a semaphore slot for puppeteer's own
      // 180s protocol timeout.
      const budget = new Promise<never>((_r, reject) => {
        const t = setTimeout(
          () => reject(new Error(`Render exceeded ${renderTimeoutMs}ms budget`)),
          renderTimeoutMs
        );
        (t as { unref?: () => void }).unref?.();
      });
      return await Promise.race([
        (async () => {
          const browser = await getBrowser();
          page = await browser.newPage();
          await page.setJavaScriptEnabled(allowScripts);
          await page.setRequestInterception(true);
          page.on("request", onRequest);
          page.setDefaultTimeout(renderTimeoutMs);
          await page.setViewport({
            width: clampWidth(opts.width),
            height: 1024,
            deviceScaleFactor: 2,
          });
          await page.setContent(opts.html, { waitUntil: "load" });
          return produce(page);
        })(),
        budget,
      ]);
    } finally {
      if (page) await (page as Page).close().catch(() => {});
      inFlight--;
      scheduleIdleClose();
      release();
    }
  }

  return {
    renderPng(opts: RenderOptions): Promise<Buffer> {
      return withPage(opts, async (page) => {
        const bodyHandle = await page.$("body");
        const box = bodyHandle ? await bodyHandle.boundingBox() : null;
        const clip = box
          ? {
              x: box.x,
              y: box.y,
              width: Math.ceil(box.width),
              height: Math.min(MAX_CAPTURE_HEIGHT, Math.ceil(box.height)),
            }
          : undefined;
        const shot = await page.screenshot({
          type: "png",
          fullPage: !clip,
          clip,
          omitBackground: false,
        });
        // puppeteer 25 returns Uint8Array — honor the Buffer contract for real.
        return Buffer.from(shot);
      });
    },

    renderPdf(opts: RenderOptions): Promise<Buffer> {
      return withPage(opts, async (page) => {
        const pdf = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "16mm", bottom: "16mm", left: "16mm", right: "16mm" },
        });
        return Buffer.from(pdf);
      });
    },

    async shutdown(): Promise<void> {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      const p = browserPromise;
      browserPromise = null;
      if (p) {
        try {
          const b = await p;
          await b.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
