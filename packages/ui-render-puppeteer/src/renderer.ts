/**
 * Server-side HTML → PNG/PDF rendering on headless Chrome, isolated for what
 * it is: a renderer for CALLER-SUPPLIED HTML running next to personal data.
 *
 * Security posture (why this is its own optional package):
 * - Network is DENIED by default. Rendered HTML can request nothing over
 *   http(s)/ws — no SSRF into the host's network, no exfiltration beacons,
 *   no remote assets. Inline everything (data: URIs). Callers who genuinely
 *   need remote assets must pass an explicit `allowRequest` predicate.
 * - Every render is bounded by a timeout and a concurrency cap, so a
 *   pathological document can't wedge the browser or fork-bomb pages.
 * - The browser is launched lazily and closed after an idle period.
 *
 * Chromium sandbox: containers commonly lack the privileges for Chrome's
 * user-namespace sandbox, so `noSandbox` defaults to true. On a host where
 * the sandbox works, pass `noSandbox: false` — content is untrusted HTML and
 * every layer helps.
 */
import puppeteer, { type Browser, type HTTPRequest } from "puppeteer-core";
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
 */
export function shouldAllowRequest(url: string): boolean {
  return url.startsWith("data:") || url === "about:blank";
}

export interface RendererOptions {
  /** Chrome executable. Default: PUPPETEER_EXECUTABLE_PATH / BRAIN_UI_CHROME_PATH / well-known paths. */
  executablePath?: string;
  /** Per-render wall-clock budget (ms). Default 30_000. */
  renderTimeoutMs?: number;
  /** Max renders in flight; further calls queue. Default 2. */
  maxConcurrent?: number;
  /** Close the browser after this long without a render (ms). Default 5 min. */
  idleTimeoutMs?: number;
  /**
   * Escape hatch for callers that must load remote assets. Return true to let
   * a request through. Combined with (not replacing) the data:/about:blank
   * allowlist. Default: nothing extra is allowed.
   */
  allowRequest?: (url: string) => boolean;
  /** Launch Chrome without its sandbox (required in most containers). Default true. */
  noSandbox?: boolean;
}

export interface RenderOptions {
  html: string;
  /** Viewport width for layout (px). Default 768 — good for share-card readability. */
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
  const semaphore = new Semaphore(options.maxConcurrent ?? 2);
  const noSandbox = options.noSandbox ?? true;

  let browserPromise: Promise<Browser> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
      const executablePath = resolveChromePath(options.executablePath);
      const launched = puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
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

  async function withPage<T>(
    opts: RenderOptions,
    produce: (page: Awaited<ReturnType<Browser["newPage"]>>) => Promise<T>
  ): Promise<T> {
    const release = await semaphore.acquire();
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      const budget = new Promise<never>((_r, reject) => {
        setTimeout(
          () => reject(new Error(`Render exceeded ${renderTimeoutMs}ms budget`)),
          renderTimeoutMs
        ).unref?.();
      });
      try {
        await page.setRequestInterception(true);
        page.on("request", onRequest);
        page.setDefaultTimeout(renderTimeoutMs);
        await page.setViewport({
          width: opts.width ?? 768,
          height: 1024,
          deviceScaleFactor: 2,
        });
        return await Promise.race([
          (async () => {
            await page.setContent(opts.html, { waitUntil: "load" });
            return produce(page);
          })(),
          budget,
        ]);
      } finally {
        await page.close().catch(() => {});
        scheduleIdleClose();
      }
    } finally {
      release();
    }
  }

  return {
    renderPng(opts: RenderOptions): Promise<Buffer> {
      return withPage(opts, async (page) => {
        const bodyHandle = await page.$("body");
        const box = bodyHandle ? await bodyHandle.boundingBox() : null;
        const clip = box
          ? { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) }
          : undefined;
        return (await page.screenshot({
          type: "png",
          fullPage: !clip,
          clip,
          omitBackground: false,
        })) as Buffer;
      });
    },

    renderPdf(opts: RenderOptions): Promise<Buffer> {
      return withPage(opts, async (page) => {
        return (await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "16mm", bottom: "16mm", left: "16mm", right: "16mm" },
        })) as Buffer;
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
