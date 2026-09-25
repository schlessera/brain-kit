/**
 * The polite HTTP client every adapter fetches through.
 *
 * This is `module-jobs/src/http.ts` grown up. The retry/backoff/`Retry-After`
 * logic came over as-is because it was already right; what changed is what
 * surrounds it:
 *
 * - the per-host clock is an injected `RateLimiter` instead of a module-level
 *   Map shared by every caller in the process,
 * - robots.txt is fetched, cached and enforced before the request goes out,
 *   with `Crawl-delay` raising the host's rate-limit floor,
 * - the default User-Agent identifies this package instead of impersonating
 *   Chrome.
 *
 * A `ScrapeClient` is an object you construct and own. Two clients against two
 * sites do not throttle each other, and a test constructs one with a fake
 * clock and a fake robots fetcher and touches no network at all.
 */
import { DEFAULT_USER_AGENT } from "../config/env.js";
import { MAX_DELAY_MS, RateLimiter, hostOf } from "../politeness/rate-limit.js";
import { RobotsCache, RobotsDisallowedError } from "../politeness/robots.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
/** Cap on how long a `Retry-After` may park a request. */
const MAX_RETRY_AFTER_MS = 60_000;
/** The fetch standard's redirect limit. */
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ScrapeClientOptions {
  /** Sent on every request, and matched against robots.txt groups. */
  userAgent?: string;
  /** Minimum ms between requests to the same host. */
  defaultDelayMs?: number;
  /** Enforce robots.txt. Default true; see the robots module header. */
  respectRobots?: boolean;
  rateLimiter?: RateLimiter;
  robots?: RobotsCache;
}

export interface FetchOptions {
  /** Proxy URL; forces the curl path (see `fetchThroughProxy`). */
  proxy?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
  /** Minimum ms since the last request to this host, for this call. */
  delayMs?: number;
  /** Override the client's User-Agent for this site. */
  userAgent?: string;
  /**
   * Proceed even when robots.txt disallows the URL. The per-site escape hatch
   * — for a host you operate, or one you have written permission for. It is a
   * per-call decision on purpose: there is no way to set it once and forget
   * which sites it applies to.
   */
  allowDisallowed?: boolean;
}

/** A text body, and the URL the response was actually served from. */
export interface FetchedPage {
  body: string;
  /**
   * Where the body came from, after redirects have been followed.
   *
   * A caller that only reads the body cannot tell a healthy 200 from a domain
   * that now redirects somewhere else entirely and answers 200 there — which
   * is a real failure mode, not a hypothetical: module-jobs had a board whose
   * domain started 301ing to a different job site, and it went on reporting
   * successful, empty scrapes. This is the one thing that distinguishes them.
   *
   * `ScrapeClient` follows redirects itself, so this is the last hop's URL
   * on both the native and the proxy path. Falls back to the requested URL
   * only for a `get` that reports none, such as a test double.
   */
  url: string;
}

/** Parse a `Retry-After` (seconds or HTTP-date) to ms, capped. Null if unusable. */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  let ms: number;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return null;
    ms = date - Date.now();
  }
  if (ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Exponential backoff with jitter, so a fleet of retries does not sync up. */
function backoffMs(base: number, attempt: number): number {
  return base * 2 ** attempt + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch through a proxy by shelling out to curl.
 *
 * Bun's `fetch` ignores `HTTP_PROXY`, and there is no per-request proxy
 * option, so a proxied request has to leave the runtime. Response headers are
 * not captured on this path — `-w` gives us the status and the redirect
 * target and nothing else — so a proxied 429 backs off on the exponential
 * schedule rather than on `Retry-After`.
 *
 * curl does not follow redirects here (no `-L`): `ScrapeClient.get` follows
 * them itself, so each hop is checked against robots.txt and paced. For the
 * same reason `--globoff` is set: without it curl expands `[1-3]` or `{a,b}`
 * in a URL into several requests, none of which robots.txt or the limiter
 * saw.
 */
async function fetchThroughProxy(
  url: string,
  proxy: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; body: string; location: string }> {
  const args = [
    "curl",
    "-s",
    "--globoff",
    "-w",
    "\n%{http_code}\n%{redirect_url}",
    "-x",
    proxy,
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-A",
    headers["User-Agent"] ?? DEFAULT_USER_AGENT,
  ];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "user-agent") continue; // already set via -A
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  const lines = output.split("\n");
  const location = lines.pop()?.trim() ?? "";
  const status = Number.parseInt(lines.pop()?.trim() || "0", 10);
  return { status, body: lines.join("\n"), location };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Report `url` as the response's URL, which a constructed `Response` lacks. */
function servedFrom(response: Response, url: string): Response {
  if (response.url !== url) Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

/**
 * The headers that may travel to an origin the caller did not ask for: the
 * client's own identity and content negotiation, which are all any caller in
 * this repo sets. Anything else may be a credential for the requested site
 * (`Authorization`, `Cookie`, `Proxy-Authorization`, an `X-Api-Key`), and
 * there is no telling which, so it stays behind. An https-to-http downgrade
 * is always a change of origin, so it is covered too.
 */
const CROSS_ORIGIN_HEADERS = new Set(["user-agent", "accept"]);

function forAnotherOrigin(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => CROSS_ORIGIN_HEADERS.has(key.toLowerCase()))
  );
}

export class ScrapeClient {
  private readonly userAgent: string;
  private readonly respectRobots: boolean;
  private readonly rateLimiter: RateLimiter;
  private readonly robots: RobotsCache;

  constructor(options: ScrapeClientOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.respectRobots = options.respectRobots ?? true;
    this.rateLimiter =
      options.rateLimiter ?? new RateLimiter({ defaultDelayMs: options.defaultDelayMs });
    this.robots = options.robots ?? new RobotsCache();
  }

  /**
   * Check robots.txt and wait out the host's rate limit.
   *
   * Returns the delay it acquired the limiter with, so a retry of the same
   * URL is paced the same way without fetching robots.txt again; throws
   * `RobotsDisallowedError` when the URL is off limits. `Crawl-delay` is
   * folded in as a floor here rather than at the limiter, because it is a
   * property of the site's rules and not of the caller's configuration.
   */
  private async clearToFetch(url: string, opts: FetchOptions): Promise<number> {
    let crawlDelayMs: number | undefined;
    const userAgent = opts.userAgent ?? this.userAgent;

    if (this.respectRobots) {
      const rules = await this.robots.forUrl(url);
      if (!opts.allowDisallowed && !rules.isAllowed(url, userAgent)) {
        throw new RobotsDisallowedError(url, userAgent);
      }
      crawlDelayMs = rules.crawlDelayMs(userAgent);
      // A Crawl-delay longer than any wait a crawler can make is the site
      // asking not to be crawled at this pace at all. Honouring the intent
      // means not fetching, not ignoring the line (see
      // docs/decisions/scraping-politeness.md).
      if (!opts.allowDisallowed && crawlDelayMs !== undefined && !(crawlDelayMs <= MAX_DELAY_MS)) {
        throw new RobotsDisallowedError(
          url,
          userAgent,
          `its Crawl-delay is longer than this client can wait, 2^31 - 1 ms`
        );
      }
      // Overridden, an unfollowable Crawl-delay contributes nothing: not a
      // clamped wait of weeks, and not an Infinity that would take the
      // caller's own delay down with it through Math.max.
      if (crawlDelayMs !== undefined && !(crawlDelayMs <= MAX_DELAY_MS)) crawlDelayMs = undefined;
    }

    // Each delay is checked on its own before they are combined, so an
    // unusable caller value cannot take the site's Crawl-delay down with it.
    const callerDelayMs = Number.isFinite(opts.delayMs) ? (opts.delayMs as number) : 0;
    const delayMs = Math.max(callerDelayMs, crawlDelayMs ?? 0);
    await this.rateLimiter.acquire(hostOf(url), delayMs);
    return delayMs;
  }

  /**
   * GET with retries, following redirects one hop at a time.
   *
   * Retries 429 and 5xx, honouring `Retry-After` when the response carried
   * one; a 4xx other than 429 is returned as-is, because retrying it will not
   * change the answer.
   *
   * Every hop goes through `clearToFetch`, so a redirect target is held to
   * its own origin's robots.txt and paced for its own host. `allowDisallowed`
   * covers the origin that was asked for and nothing else: a per-call yes for
   * one site is not a yes for wherever it redirects (see
   * docs/decisions/scraping-politeness.md).
   */
  async get(url: string, opts: FetchOptions = {}): Promise<Response> {
    let headers: Record<string, string> = {
      "User-Agent": opts.userAgent ?? this.userAgent,
      Accept: "application/json, text/html, application/xml, */*",
      ...opts.headers,
    };
    const startOrigin = originOf(url);
    let current = url;

    for (let hops = 0; ; hops++) {
      const crossOrigin = originOf(current) !== startOrigin;
      if (crossOrigin) headers = forAnotherOrigin(headers);
      const response = await this.fetchHop(
        current,
        crossOrigin ? { ...opts, allowDisallowed: false } : opts,
        headers
      );
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      if (!location) return servedFrom(response, current);

      await response.body?.cancel().catch(() => {});
      if (hops === MAX_REDIRECTS) {
        throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
      }
      const next = new URL(location, current);
      // Native fetch would refuse these too; following one by hand must not
      // turn a redirect into a read of a local file.
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`${current} redirected to unsupported URL ${next.href}`);
      }
      current = next.href;
    }
  }

  /** One URL, with its robots.txt check, pacing and retries, not following redirects. */
  private async fetchHop(
    url: string,
    opts: FetchOptions,
    headers: Record<string, string>
  ): Promise<Response> {
    const delayMs = await this.clearToFetch(url, opts);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // A retry is a request to the host like any other: it waits out the
        // same Crawl-delay and per-host spacing as the first attempt did.
        if (attempt > 0) await this.rateLimiter.acquire(hostOf(url), delayMs);
        if (opts.proxy) {
          const result = await fetchThroughProxy(url, opts.proxy, headers, timeoutMs);
          if (result.status === 429 || result.status >= 500) {
            // Record the status, so a final-attempt failure throws something
            // specific instead of a generic "failed after N retries".
            lastError = new Error(
              `HTTP ${result.status} from ${url} (after ${attempt + 1} attempts)`
            );
            if (attempt < retries) {
              await sleep(backoffMs(retryDelayMs, attempt));
              continue;
            }
            break;
          }
          return new Response(result.body, {
            status: result.status,
            statusText: result.status === 200 ? "OK" : `HTTP ${result.status}`,
            headers: result.location ? { location: result.location } : undefined,
          });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(url, {
            headers,
            signal: controller.signal,
            redirect: "manual",
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(
            `HTTP ${response.status} from ${url} (after ${attempt + 1} attempts)`
          );
          if (attempt < retries) {
            const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
            await sleep(retryAfter ?? backoffMs(retryDelayMs, attempt));
            continue;
          }
          break;
        }

        return response;
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries) await sleep(backoffMs(retryDelayMs, attempt));
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url} after ${retries} retries`);
  }

  /** GET and parse JSON, throwing on a non-2xx. */
  async getJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
    const response = await this.get(url, {
      ...opts,
      headers: { Accept: "application/json", ...opts.headers },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * GET a text body and the URL it came from, throwing on a non-2xx.
   *
   * The primitive `getText` delegates to, so a test double that overrides one
   * of them covers both rather than leaving the other reaching the network.
   */
  async getPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
    const response = await this.get(url, opts);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${await response.text()}`);
    }
    return { body: await response.text(), url: response.url || url };
  }

  /** GET and read the body as text, throwing on a non-2xx. */
  async getText(url: string, opts: FetchOptions = {}): Promise<string> {
    return (await this.getPage(url, opts)).body;
  }
}
