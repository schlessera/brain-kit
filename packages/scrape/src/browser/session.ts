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
}

/** What a caller does with one loaded page. */
export interface PageRequest<T> {
  url: string;
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
  /** Load `request.url` and return what `extract` produced. */
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
    launching = (async () => {
      const puppeteer = await loadPuppeteer();
      if (options.browserUrl) {
        browser = await puppeteer.connect({ browserURL: options.browserUrl });
      } else {
        const args = ["--disable-dev-shm-usage"];
        if (options.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
        browser = await puppeteer.launch({
          executablePath: resolveChromePath(options.executablePath),
          headless: true,
          args,
        });
      }
      launching = null;
      return browser;
    })();
    return launching;
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
    try {
      const b = await getBrowser();
      page = await b.newPage();
      if (options.userAgent) await page.setUserAgent(options.userAgent);
      page.setDefaultTimeout(pageBudgetMs);
      page.setDefaultNavigationTimeout(pageBudgetMs);

      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: pageBudgetMs });
      if (request.waitForSelector) {
        await page.waitForSelector(request.waitForSelector, { timeout: pageBudgetMs });
      }
      if (request.settleMs) {
        await new Promise((resolve) => setTimeout(resolve, request.settleMs));
      }
      return (await page.evaluate(request.extract)) as T;
    } finally {
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
