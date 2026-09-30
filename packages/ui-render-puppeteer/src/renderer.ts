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
 * - Queue waiting, browser acquisition and page creation/rendering each have
 *   a wall-clock bound, with a concurrency cap and bounded queue.
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
  /** Queue wait budget (ms). Expiry removes the waiter. Default 30_000. */
  queueTimeoutMs?: number;
  /** Browser acquisition budget (ms), including a shared cold launch. Default 60_000. */
  browserTimeoutMs?: number;
  /**
   * Page creation, setup and PNG/PDF production budget (ms). Default 30_000.
   * Previously included queue waiting and browser launch; those now have
   * separate budgets. Maximum request duration is the sum of all three.
   */
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
  const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
  const browserTimeoutMs = options.browserTimeoutMs ?? 60_000;
  const renderTimeoutMs = options.renderTimeoutMs ?? 30_000;
  for (const [name, value] of Object.entries({ queueTimeoutMs, browserTimeoutMs, renderTimeoutMs })) {
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} must be a positive integer within the timer range`);
    }
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const semaphore = new Semaphore(options.maxConcurrent ?? 2, options.maxQueue ?? 16);
  const noSandbox = options.noSandbox ?? false;
  const allowScripts = options.allowScripts ?? false;
  const allowHosts = options.allowHosts ?? [];
  const allowedHostSet = new Set(allowHosts.map((h) => h.toLowerCase()));
  let closed = false;

  interface BrowserLaunch {
    promise: Promise<Browser>;
    browser: Browser | null;
    users: number;
    retired: boolean;
    closing?: Promise<void>;
  }
  let currentLaunch: BrowserLaunch | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let drained: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  async function withinBudget<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function closeBrowser(launch: BrowserLaunch): Promise<void> {
    if (!launch.browser) return Promise.resolve();
    // Multiple shutdowns, stale disconnects and late launch settlement must
    // never close a resource twice. A wedged close cannot hold up shutdown.
    launch.closing ??= withinBudget(
      Promise.resolve().then(() => launch.browser!.close()),
      2_000,
      "Browser cleanup exceeded 2000ms budget"
    ).catch(() => {});
    return launch.closing;
  }

  function retireBrowser(launch: BrowserLaunch): Promise<void> {
    launch.retired = true;
    if (currentLaunch === launch) currentLaunch = null;
    // Pending launches close themselves on late resolution; never await one.
    return closeBrowser(launch);
  }

  function getBrowserLaunch(): BrowserLaunch {
    if (currentLaunch) return currentLaunch;
    const executablePath = options.launch && options.executablePath
      ? options.executablePath
      : resolveChromePath(options.executablePath);
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
    const launch: BrowserLaunch = {
      promise: Promise.resolve().then(() =>
        (options.launch ?? ((a: LaunchArgs) => puppeteer.launch({ ...a, timeout: browserTimeoutMs })))(launchArgs)
      ),
      browser: null,
      users: 0,
      retired: false,
    };
    currentLaunch = launch;
    launch.promise = launch.promise.then((browser) => {
      launch.browser = browser;
      browser.once("disconnected", () => {
        if (currentLaunch === launch) currentLaunch = null;
      });
      if (launch.retired) void closeBrowser(launch);
      return browser;
    }, (error) => {
      if (currentLaunch === launch) currentLaunch = null;
      throw error;
    });
    return launch;
  }

  function scheduleIdleClose(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    // Never re-arm after shutdown, and never hold the process open.
    if (closed || inFlight > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (currentLaunch) void retireBrowser(currentLaunch);
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
    produce: (page: Page, checkActive: () => void) => Promise<T>
  ): Promise<T> {
    if (closed) throw new Error("Renderer has been shut down");
    const release = await semaphore.acquire(queueTimeoutMs);
    // shutdown can race an immediate acquire's promise continuation.
    if (closed) {
      release();
      throw new Error("Renderer has been shut down");
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    inFlight++;
    let launch: BrowserLaunch | null = null;
    let page: Page | null = null;
    let settled = false;
    const checkActive = () => {
      if (settled) throw new Error("Render budget expired");
    };
    try {
      launch = getBrowserLaunch();
      launch.users++;
      const browser = await withinBudget(
        launch.promise,
        browserTimeoutMs,
        `Browser acquisition exceeded ${browserTimeoutMs}ms budget`
      );
      // Browser acquisition has finished: page creation gets the full render
      // allowance. Every continuation checks cancellation before using a page.
      return await withinBudget((async () => {
        const opened = await browser.newPage();
        if (settled) {
          void opened.close().catch(() => {});
          checkActive();
        }
        page = opened;
        await opened.setJavaScriptEnabled(allowScripts);
        checkActive();
        await opened.setRequestInterception(true);
        checkActive();
        opened.on("request", onRequest);
        opened.setDefaultTimeout(renderTimeoutMs);
        await opened.setViewport({
          width: clampWidth(opts.width), height: 1024, deviceScaleFactor: DEVICE_SCALE_FACTOR,
        });
        checkActive();
        await opened.setContent(opts.html, { waitUntil: "load" });
        checkActive();
        return produce(opened, checkActive);
      })(), renderTimeoutMs, `Render exceeded ${renderTimeoutMs}ms budget`);
    } finally {
      settled = true;
      // Page teardown is detached: a wedged close cannot retain capacity.
      const target = page as Page | null;
      if (target) void target.close().catch(() => {});
      if (launch) {
        launch.users--;
        // Last acquisition waiter timed out: detach the launch so another
        // render can recover, and close any browser it returns later. A newer
        // waiter on the same launch keeps it alive.
        if (launch.users === 0 && !launch.browser) void retireBrowser(launch);
      }
      inFlight--;
      release();
      scheduleIdleClose();
      if (inFlight === 0) drained?.();
    }
  }

  return {
    renderPng(opts: RenderOptions): Promise<Buffer> {
      return withPage(opts, async (page, checkActive) => {
        const bodyHandle = await page.$("body");
        checkActive();
        const box = bodyHandle ? await bodyHandle.boundingBox() : null;
        checkActive();
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
        // The document's @page rule owns size and margins: the shell's is A4
        // with no side margins, so its opener bleeds to the page edge, and a
        // footer in its margin boxes. A document with no @page rule of its own
        // (a bare one) gets A4 and these margins instead.
        const pdf = await page.pdf({
          format: "A4",
          preferCSSPageSize: true,
          printBackground: true,
          pageRanges: `1-${MAX_PDF_PAGES}`,
          margin: { top: "16mm", bottom: "16mm", left: "16mm", right: "16mm" },
        });
        return Buffer.from(pdf);
      });
    },

    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        closed = true;
        semaphore.close();
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        // Active renders drain within browserTimeoutMs + renderTimeoutMs.
        // Queued callers are rejected immediately and can never launch.
        if (inFlight > 0) await new Promise<void>((resolve) => { drained = resolve; });
        if (currentLaunch) await retireBrowser(currentLaunch);
      })();
      return shutdownPromise;
    },
  };
}
