/**
 * Headless Chrome, for sites that only exist after JavaScript runs.
 *
 * The lifecycle here — lazy launch, idle close, a wall-clock budget per page,
 * a concurrency cap — is the same shape as `@schlessera/brain-render-puppeteer`
 * and was modelled on it deliberately. What is NOT shared is the instance, and
 * that is the point: the renderer's identity is "JavaScript off, network
 * denied", because it renders caller-supplied HTML next to personal data. A
 * scraper is the exact inverse — it needs scripts and it needs the network.
 * Handing both postures to one object would mean one flag away from turning
 * the renderer into an SSRF vector. Two packages, two postures, no flag.
 *
 * What this still refuses:
 *
 * - It never evaluates caller-supplied code as a page script by default. The
 *   `extract` function is serialized by the CALLER, which is a site adapter in
 *   the consuming package — not user input arriving at runtime.
 * - Every page is closed on the way out, including on the failure path. A
 *   leaked page holds a renderer process alive for the life of the browser.
 * - The Chromium sandbox stays ON unless explicitly disabled, which is only
 *   needed when running as root.
 *
 * `puppeteer-core` is an OPTIONAL peer: most consumers scrape HTTP endpoints
 * and should not install a browser driver to do it. Calling into this module
 * without it installed throws a message that says so.
 */
import { existsSync } from "node:fs";
import type { HTTPRequest } from "puppeteer-core";
import { DEFAULT_USER_AGENT } from "../config/env.js";
import { abortable, sleep } from "../politeness/abort.js";
import { clearToFetch } from "../politeness/policy.js";
import { RateLimiter } from "../politeness/rate-limit.js";
import { RobotsCache } from "../politeness/robots.js";

import { Semaphore } from "./semaphore.js";

/** Probed in order when no explicit executable is configured. */
const CHROME_PATH_FALLBACKS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const DEFAULT_PAGE_BUDGET_MS = 45_000;
const DEFAULT_IDLE_CLOSE_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_QUEUE = 100;

export interface BrowserSessionOptions {
  /**
   * Attach to an already-running Chrome at this DevTools endpoint instead of
   * launching one. The session then never closes that browser — it does not
   * own it.
   */
  browserUrl?: string;
  /** Executable to launch. Falls back to the usual distro paths. */
  executablePath?: string;
  /** Launch with --no-sandbox. Required only when running as root. */
  noSandbox?: boolean;
  /** Wall-clock budget for one page, navigation included. */
  pageBudgetMs?: number;
  /** Close an idle browser after this long. Ignored when attached. */
  idleCloseMs?: number;
  /** Pages open at once. */
  concurrency?: number;
  /** Cap on queued page requests before the session refuses more. */
  maxQueue?: number;
  userAgent?: string;
  /** Share the run's HTTP robots cache and per-host scheduling. Defaults are owned by this session. */
  robots?: RobotsCache;
  rateLimiter?: RateLimiter;
  /**
   * How a browser is obtained. Defaults to `puppeteer.launch` (or `connect`
   * when `browserUrl` is set).
   *
   * Injected so crash recovery is testable: the handling that drops a dead
   * browser handle is the difference between "the next page relaunches" and
   * "every scrape fails until the process restarts", and with the puppeteer
   * call hardcoded the only way to exercise it was to start real Chrome and
   * kill it.
   */
  launch?: () => Promise<any>;
}

/** What a caller does with one loaded page. */
export interface PageRequest<T> {
  url: string;
  /**
   * Written site permission or an owned host, for this call's original origin
   * only. Cross-origin navigation is checked normally. Pacing still applies.
   */
  allowDisallowed?: boolean;
  /** CSS selector to await before extracting; skipped when absent. */
  waitForSelector?: string;
  /** Additional settle time after the selector appears. */
  settleMs?: number;
  /**
   * Runs INSIDE the page. Must be self-contained — it is serialized across
   * the CDP boundary, so it closes over nothing from this process.
   */
  extract: () => T;
}

export interface BrowserSession {
  /**
   * Check/pace HTTP(S) main-frame navigation (redirects and later navigation
   * included), then extract. Subresources, child frames and page API calls are
   * outside these checks. The page budget includes policy waits.
   */
  load<T>(request: PageRequest<T>): Promise<T>;
  /** Close the browser if this session launched it. Idempotent. */
  close(): Promise<void>;
}

function resolveChromePath(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Chrome executable not found at ${explicit}`);
    }
    return explicit;
  }
  const found = CHROME_PATH_FALLBACKS.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `No Chrome/Chromium found. Install one, or set SCRAPE_CHROME_PATH ` +
        `(looked in: ${CHROME_PATH_FALLBACKS.join(", ")}).`
    );
  }
  return found;
}

/** Load puppeteer-core, with a message that names the optional peer. */
async function loadPuppeteer() {
  try {
    return (await import("puppeteer-core")).default;
  } catch {
    throw new Error(
      "Browser scraping needs the optional peer 'puppeteer-core'. " +
        "Install it, or use an adapter that does not set needsBrowser."
    );
  }
}

export function createBrowserSession(options: BrowserSessionOptions = {}): BrowserSession {
  const pageBudgetMs = options.pageBudgetMs ?? DEFAULT_PAGE_BUDGET_MS;
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const policy = {
    robots: options.robots ?? new RobotsCache(),
    rateLimiter: options.rateLimiter ?? new RateLimiter(),
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    // HTTP's process/client opt-out does not grant browser site permission.
    respectRobots: true,
  };
  const semaphore = new Semaphore(
    options.concurrency ?? DEFAULT_CONCURRENCY,
    options.maxQueue ?? DEFAULT_MAX_QUEUE
  );
  /** True when we launched the browser and are therefore allowed to kill it. */
  const owned = !options.browserUrl;

  let browser: any | null = null;
  let launching: Promise<any> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;

  async function getBrowser(): Promise<any> {
    if (browser) return browser;
    if (launching) return launching;
    const pending = (async () => {
      if (options.launch) return options.launch();
      const puppeteer = await loadPuppeteer();
      if (options.browserUrl) {
        return puppeteer.connect({ browserURL: options.browserUrl });
      }
      const args = ["--disable-dev-shm-usage"];
      if (options.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
      return puppeteer.launch({
        executablePath: resolveChromePath(options.executablePath),
        headless: true,
        args,
      });
    })();
    launching = pending;

    pending
      .then((launched) => {
        // close() may have abandoned this acquisition while a page's policy
        // budget was expiring. A late result must neither leak nor replace a
        // newer browser. Attached connections are disconnected, never killed.
        if (launching !== pending) {
          if (owned) void launched.close().catch(() => {});
          else void launched.disconnect?.().catch(() => {});
          return;
        }
        browser = launched;
        if (launching === pending) launching = null;
        if (inFlight === 0) scheduleIdleClose();
        // Chrome dying (OOM is the realistic trigger for a scrape over a big
        // listing) must not leave a dead handle cached, or every later load
        // fails against it until the process restarts. Drop it and let the
        // next call relaunch. The identity checks stop a LATE handler from
        // discarding the browser that already replaced this one.
        launched.once?.("disconnected", () => {
          if (browser === launched) browser = null;
          if (launching === pending) launching = null;
        });
      })
      .catch(() => {
        // A rejected promise left in the cache would be handed to every future
        // caller, so one transient failure would disable scraping for the life
        // of the process.
        if (launching === pending) launching = null;
      });

    return pending;
  }

  function cancelIdleClose(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleClose(): void {
    if (!owned) return; // an attached browser is not ours to close
    cancelIdleClose();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight > 0) return; // a load slipped in — leave it alone
      const closing = browser;
      browser = null;
      void closing?.close().catch(() => {});
    }, idleCloseMs);
  }

  async function load<T>(request: PageRequest<T>): Promise<T> {
    const release = await semaphore.acquire();
    cancelIdleClose();
    inFlight++;
    let page: any | null = null;
    const controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error(`Browser page budget exceeded (${pageBudgetMs} ms): ${request.url}`)), pageBudgetMs);
    try {
      const originalOrigin = new URL(request.url).origin;
      const b = await abortable(getBrowser(), signal);
      page = await abortable(b.newPage().then(async (opened: any) => {
        if (signal.aborted) await opened.close().catch(() => {});
        return opened;
      }), signal);
      await abortable(page.setUserAgent(policy.userAgent), signal);
      page.setDefaultTimeout(pageBudgetMs);
      page.setDefaultNavigationTimeout(pageBudgetMs);

      await abortable(page.setBypassServiceWorker(true), signal);
      await abortable(page.setRequestInterception(true), signal);
      page.on("request", async (intercepted: HTTPRequest) => {
        try {
          if (intercepted.isNavigationRequest() && intercepted.frame() === page.mainFrame() && /^https?:/.test(intercepted.url())) {
            await clearToFetch(intercepted.url(), policy, {
              allowDisallowed: request.allowDisallowed === true && new URL(intercepted.url()).origin === originalOrigin,
              signal,
            });
          }
          signal.throwIfAborted();
          if (!intercepted.isInterceptResolutionHandled()) await intercepted.continue();
        } catch (error) {
          // A later navigation can fail while load is awaiting a selector;
          // propagate its diagnostic immediately rather than an empty result.
          controller.abort(error);
          if (!intercepted.isInterceptResolutionHandled()) await intercepted.abort().catch(() => {});
        }
      });
      await abortable(page.goto(request.url, { waitUntil: "domcontentloaded", timeout: pageBudgetMs }), signal);
      if (request.waitForSelector) {
        await abortable(page.waitForSelector(request.waitForSelector, { timeout: pageBudgetMs }), signal);
      }
      if (request.settleMs) {
        await sleep(request.settleMs, signal);
      }
      return (await abortable(page.evaluate(request.extract), signal)) as T;
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error("Browser load finished"));
      // Always, including on the failure path: a leaked page holds a renderer
      // process for the life of the browser.
      if (page) await page.close().catch(() => {});
      inFlight--;
      release();
      if (inFlight === 0) scheduleIdleClose();
    }
  }

  async function close(): Promise<void> {
    cancelIdleClose();
    const closing = browser;
    browser = null;
    launching = null;
    if (!closing) return;
    if (owned) await closing.close().catch(() => {});
    else await closing.disconnect?.().catch(() => {});
  }

  return { load, close };
}
