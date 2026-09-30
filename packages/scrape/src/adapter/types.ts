/**
 * The site-adapter seam.
 *
 * One interface, one runner, one way in. `module-jobs` grew two: an
 * `adapters/` directory behind a `BaseAdapter` with a `needsBrowser` flag, and
 * a separate `browser-scrape.ts` with its own inline site registry and its own
 * hand-rolled CDP client. One site — builtin — was implemented in both, twice,
 * and only one of the two paths respected the flag that was supposed to
 * distinguish them.
 *
 * So `needsBrowser` is not a hint here. It is the only thing that decides
 * whether an adapter is handed an HTTP client or a browser session, and both
 * arrive through the same `ScrapeContext`.
 *
 * The seam is generic over the item type. `module-jobs` yields job postings; a
 * future module yields whatever it yields. Nothing in this package knows or
 * cares.
 */
import type { BrowserSession } from "../browser/session.js";
import type { FetchOptions, ScrapeClient } from "../fetch/http.js";

/**
 * What every adapter is handed. Constructed once per run by the caller.
 *
 * @experimental Part of the `SiteAdapter` seam.
 */
export interface ScrapeContext {
  /** Polite HTTP: robots.txt, per-host rate limiting, retries. */
  http: ScrapeClient;
  /**
   * Headless Chrome. Present only for adapters that declare `needsBrowser`,
   * and only when the run could actually provide one — an adapter must treat
   * its absence as "skip me", not as a crash.
   */
  browser?: BrowserSession;
  /** Emit a progress line. Silent unless the run is verbose. */
  log(message: string): void;
}

/**
 * Per-run knobs an adapter may consult.
 * @experimental Part of the `SiteAdapter` seam.
 */
export interface AdapterRunOptions {
  /** Only fetch what is new since `cursor`, where the site supports it. */
  incremental?: boolean;
  /** Opaque marker this adapter returned last run. */
  cursor?: string;
  /** Search terms, for adapters whose site is query-driven. */
  queries?: string[];
  /** Proxy URL; adapters pass it to their per-request HTTP options. */
  proxy?: string;
  /** Per-site fetch overrides — headers, delay, User-Agent, robots opt-out. */
  fetch?: FetchOptions;
}

/**
 * A source's readable result, independently of its item count.
 * `empty` requires positive evidence; unreadable responses are `not_run`,
 * readable but unrecognized responses are `unparseable`. Partial rows are `ok`
 * with diagnostics. The adapter derives this from the pages it attempted.
 * @experimental Part of the `SiteAdapter` seam.
 */
export type AdapterStatus = "ok" | "empty" | "unparseable" | "not_run";

/**
 * What one adapter produced.
 *
 * @experimental Part of the `SiteAdapter` seam.
 */
export interface AdapterResult<T> {
  items: T[];
  /** Evidence-derived outcome; no items alone is not evidence of emptiness. */
  status: AdapterStatus;
  /** Marker to hand back next run. Omit when the site has no ordering. */
  cursor?: string;
  /** Non-fatal problems. An adapter reports; it does not decide to abort. */
  errors: string[];
}

/**
 * One site.
 *
 * `id` is what configuration and CLI flags name. `needsBrowser` decides which
 * half of the context is populated; `needsProxy` is advisory, letting a runner
 * skip an adapter it cannot serve rather than watch it fail.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface SiteAdapter<T> {
  readonly id: string;
  readonly name: string;
  readonly needsBrowser: boolean;
  readonly needsProxy: boolean;
  scrape(ctx: ScrapeContext, options: AdapterRunOptions): Promise<AdapterResult<T>>;
}

/** Nonempty success; zero items without empty-state evidence reports a parse failure. */
export function ok<T>(items: T[], cursor?: string): AdapterResult<T> {
  return {
    items, cursor,
    status: items.length > 0 ? "ok" : "unparseable",
    errors: items.length > 0 ? [] : ["No items without confirmed-empty evidence"],
  };
}

/** Convenience for the "caught an exception, return what we have" path. */
export function partial<T>(items: T[], error: unknown, cursor?: string): AdapterResult<T> {
  return {
    items,
    cursor,
    status: items.length > 0 ? "ok" : "not_run",
    errors: [error instanceof Error ? error.message : String(error)],
  };
}
