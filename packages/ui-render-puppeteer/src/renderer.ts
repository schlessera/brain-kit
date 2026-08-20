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

import { resolveEnv } from "./config/env.js";
import { Semaphore } from "./semaphore.js";

const CHROME_PATH_FALLBACKS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const MIN_VIEWPORT_WIDTH = 320;
const MAX_VIEWPORT_WIDTH = 4096;
/** Cap on captured page height (device px) — bounds the screenshot allocation. */
const MAX_CAPTURE_HEIGHT = 16_384;
const DEVICE_SCALE_FACTOR = 2;
/** Cap on PDF pages — an unbounded document would otherwise scale into memory. */
const MAX_PDF_PAGES = 50;

function resolveChromePath(explicit?: string): string {
  // Env candidates are resolved per call, not at import — the process may
  // gain the variables after this module loads.
  const { puppeteerExecutablePath, chromePath } = resolveEnv();
  for (const p of [explicit, puppeteerExecutablePath, chromePath, ...CHROME_PATH_FALLBACKS]) {
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
   * Escape hatch for callers that must load remote assets: an explicit HOST
   * allowlist, not a predicate. The hosts are excluded from the browser's
   * DNS blackhole AND allowed through request interception, so both layers
   * stay in force — a predicate could only ever gate the interceptable
   * channels, and prerender/preconnect/iframe/window.open/WebSocket are not
   * among them. Default: empty, i.e. no host resolves at all.
   */
  allowHosts?: string[];
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
  /**
   * How a browser is launched. Defaults to `puppeteer.launch` with the
   * hardened argument set below.
   *
   * Exists so crash RECOVERY is testable. The five lines that drop a dead
   * browser handle are the difference between "the next render relaunches" and
   * "every render fails until the process restarts", and with `puppeteer.launch`
   * hardcoded the only way to exercise them was to start real Chrome and kill
   * it. A caller that overrides this owns the isolation arguments too — the
   * defaults below are the security posture, not a convenience.
   */
  launch?: (args: LaunchArgs) => Promise<Browser>;
}

/** What the default launcher would have used, handed to an injected one. */
export interface LaunchArgs {
  executablePath: string;
  headless: true;
  args: string[];
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
  const allowHosts = options.allowHosts ?? [];
  const allowedHostSet = new Set(allowHosts.map((h) => h.toLowerCase()));
  let closed = false;

  let browserPromise: Promise<Browser> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
      const executablePath = resolveChromePath(options.executablePath);
      const launchArgs: LaunchArgs = {
        executablePath,
        headless: true,
        args: [
          ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
          // The DNS blackhole is the load-bearing layer: request interception
          // never sees prerender, preconnect, iframes, popups, or WebSocket
          // handshakes. It is ALWAYS installed; an allowHosts entry becomes a
          // narrow EXCLUDE rather than switching the whole rule off.
          `--host-resolver-rules=MAP * ~NOTFOUND${allowHosts
            .map((h) => `, EXCLUDE ${h}`)
            .join("")}`,
          // A popup is a new target with its own (uninstrumented) session.
          "--block-new-web-contents",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      };
      const launched = (options.launch ?? ((a: LaunchArgs) => puppeteer.launch(a)))(launchArgs);
      browserPromise = launched;
      launched
        .then((browser) => {
          // A crashed browser (OOM is the realistic trigger) must not brick
          // the renderer forever — drop the handle so the next render relaunches.
          browser.once("disconnected", () => {
            if (browserPromise === launched) browserPromise = null;
          });
        })
        .catch(() => {
          if (browserPromise === launched) browserPromise = null;
        });
      return launched;
    }
    return browserPromise;
  }

  function scheduleIdleClose(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    // Never re-arm after shutdown, and never hold the process open.
    if (closed || inFlight > 0) return;
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
    (idleTimer as { unref?: () => void }).unref?.();
  }

  function hostAllowed(url: string): boolean {
    if (allowedHostSet.size === 0) return false;
    try {
      return allowedHostSet.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function onRequest(request: HTTPRequest): void {
    let allow = false;
    try {
      const url = request.url();
      allow = shouldAllowRequest(url) || hostAllowed(url);
    } catch {
      allow = false; // fail closed; never leave the request paused
    }
    // These reject routinely when the page is closed mid-flight (every budget
    // timeout does that) — swallow rather than surfacing an unhandled rejection.
    if (allow) void request.continue().catch(() => {});
    else void request.abort("blockedbyclient").catch(() => {});
  }

  function clampWidth(width: number | undefined): number {
    const w = width ?? 768;
    return Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.floor(w)));
  }

  async function withPage<T>(
    opts: RenderOptions,
    produce: (page: Page) => Promise<T>
  ): Promise<T> {
    if (closed) throw new Error("Renderer has been shut down");
    // The budget starts BEFORE the queue wait: end-to-end time is what the
    // caller experiences, and a deep queue could otherwise stall a render for
    // minutes despite a 30s "bound".
    const startedAt = Date.now();
    const release = await semaphore.acquire();
    const remaining = renderTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      release();
      throw new Error(`Render exceeded ${renderTimeoutMs}ms budget while queued`);
    }
    // A render is now committed: cancel any pending idle close so the browser
    // can't be torn down underneath it.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    inFlight++;
    let page: Page | null = null;
    // Set when the budget wins the race: a newPage() that resolves afterwards
    // must close its tab itself, or every timed-out render leaks one.
    let settled = false;
    try {
      // The budget covers EVERYTHING — browser launch and newPage included —
      // so a wedged launch can't hold a semaphore slot for puppeteer's own
      // 180s protocol timeout.
      const budget = new Promise<never>((_r, reject) => {
        const t = setTimeout(
          () => reject(new Error(`Render exceeded ${renderTimeoutMs}ms budget`)),
          remaining
        );
        (t as { unref?: () => void }).unref?.();
      });
      return await Promise.race([
        (async () => {
          const browser = await getBrowser();
          const opened = await browser.newPage();
          if (settled) {
            void opened.close().catch(() => {});
            throw new Error("Render budget expired before the page opened");
          }
          page = opened;
          await page.setJavaScriptEnabled(allowScripts);
          await page.setRequestInterception(true);
          page.on("request", onRequest);
          page.setDefaultTimeout(renderTimeoutMs);
          await page.setViewport({
            width: clampWidth(opts.width),
            height: 1024,
            deviceScaleFactor: DEVICE_SCALE_FACTOR,
          });
          await page.setContent(opts.html, { waitUntil: "load" });
          return produce(page);
        })(),
        budget,
      ]);
    } finally {
      settled = true;
      // Teardown must not hold the slot: a wedged browser can make close()
      // hang for puppeteer's 180s protocol timeout.
      const target = page as Page | null;
      if (target) {
        void Promise.race([
          target.close().catch(() => {}),
          new Promise((r) => setTimeout(r, 2_000)),
        ]);
      }
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
        // Clamp BOTH axes in device pixels: deviceScaleFactor 2 doubles the
        // captured bitmap, and a `width: 50000px` body would otherwise drive
        // a multi-hundred-MB allocation inside Chrome. A degenerate box (a
        // page of only fixed-position elements) falls back to fullPage —
        // Chrome rejects a zero-sized clip outright.
        const maxW = MAX_VIEWPORT_WIDTH / DEVICE_SCALE_FACTOR;
        const maxH = MAX_CAPTURE_HEIGHT / DEVICE_SCALE_FACTOR;
        const clip =
          box && box.width >= 1 && box.height >= 1
            ? {
                x: box.x,
                y: box.y,
                width: Math.min(maxW, Math.ceil(box.width)),
                height: Math.min(maxH, Math.ceil(box.height)),
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
          pageRanges: `1-${MAX_PDF_PAGES}`,
          margin: { top: "16mm", bottom: "16mm", left: "16mm", right: "16mm" },
        });
        return Buffer.from(pdf);
      });
    },

    async shutdown(): Promise<void> {
      // Terminal: later renders are refused rather than silently relaunching
      // a browser nothing owns.
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      // Let in-flight renders finish rather than killing their browser
      // mid-screenshot. They are already bounded by the render budget, so
      // this waits at most that long.
      const deadline = Date.now() + renderTimeoutMs;
      while (inFlight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
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
