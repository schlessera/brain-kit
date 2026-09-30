/**
 * Running a set of adapters: build the context once, then take each adapter's
 * `needsBrowser` at its word.
 *
 * The browser is created lazily and only if some selected adapter actually
 * wants one, so an HTTP-only run never launches Chrome — and a run that
 * cannot launch Chrome still completes its HTTP adapters instead of failing
 * whole.
 */
import { createBrowserSession, type BrowserSession, type BrowserSessionOptions } from "../browser/session.js";
import { ScrapeClient, type ScrapeClientOptions } from "../fetch/http.js";
import type { AdapterResult, AdapterRunOptions, ScrapeContext, SiteAdapter } from "./types.js";

export interface RunAdaptersOptions<T> {
  adapters: Array<SiteAdapter<T>>;
  /** Per-adapter run options, keyed by adapter id. */
  optionsFor?(adapter: SiteAdapter<T>): AdapterRunOptions;
  client?: ScrapeClientOptions | ScrapeClient;
  browser?: BrowserSessionOptions | BrowserSession | false;
  verbose?: boolean;
}

/** One adapter's outcome, with the timing a caller wants to log. */
export interface AdapterOutcome<T> extends AdapterResult<T> {
  id: string;
  durationMs: number;
}

function toClient(option: RunAdaptersOptions<never>["client"]): ScrapeClient {
  if (option instanceof ScrapeClient) return option;
  return new ScrapeClient(option ?? {});
}

/**
 * Run every adapter in turn and collect the results.
 *
 * Sequential on purpose: the whole point of the rate limiter is that this
 * process is a good citizen, and running ten adapters concurrently to ten
 * hosts is fine right up until two of them share a host. A caller that knows
 * its adapters hit distinct hosts can drive them itself.
 */
export async function runAdapters<T>(options: RunAdaptersOptions<T>): Promise<Array<AdapterOutcome<T>>> {
  const http = toClient(options.client as RunAdaptersOptions<never>["client"]);
  const log = options.verbose ? (message: string) => console.log(message) : () => {};

  let browser: BrowserSession | undefined;
  let ownBrowser = false;
  const wantsBrowser = options.adapters.some((a) => a.needsBrowser);
  if (wantsBrowser && options.browser !== false) {
    if (options.browser && typeof (options.browser as BrowserSession).load === "function") {
      browser = options.browser as BrowserSession;
    } else {
      try {
        const browserOptions = (options.browser as BrowserSessionOptions) ?? {};
        browser = createBrowserSession({
          ...browserOptions,
          robots: browserOptions.robots ?? http.robots,
          rateLimiter: browserOptions.rateLimiter ?? http.rateLimiter,
          userAgent: browserOptions.userAgent ?? http.userAgent,
        });
        ownBrowser = true;
      } catch (e) {
        // No Chrome, or no puppeteer-core. Browser adapters will skip; the
        // HTTP ones must still run.
        log(`[scrape] no browser available: ${(e as Error).message}`);
      }
    }
  }

  const ctx: ScrapeContext = { http, browser, log };
  const outcomes: Array<AdapterOutcome<T>> = [];

  try {
    for (const adapter of options.adapters) {
      const runOptions = options.optionsFor?.(adapter) ?? {};
      const started = Date.now();

      if (adapter.needsBrowser && !browser) {
        outcomes.push({
          id: adapter.id,
          items: [],
          errors: [`${adapter.name} needs a browser and none is available`],
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (adapter.needsProxy && !runOptions.proxy) {
        outcomes.push({
          id: adapter.id,
          items: [],
          errors: [`${adapter.name} needs a proxy and none was configured`],
          durationMs: Date.now() - started,
        });
        continue;
      }

      try {
        const result = await adapter.scrape(ctx, runOptions);
        outcomes.push({ id: adapter.id, ...result, durationMs: Date.now() - started });
      } catch (e) {
        // One site failing is not the run failing.
        outcomes.push({
          id: adapter.id,
          items: [],
          errors: [e instanceof Error ? e.message : String(e)],
          durationMs: Date.now() - started,
        });
      }
    }
  } finally {
    if (ownBrowser) await browser?.close();
  }

  return outcomes;
}
