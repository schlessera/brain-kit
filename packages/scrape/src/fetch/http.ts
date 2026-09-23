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
import { RateLimiter, hostOf } from "../politeness/rate-limit.js";
import { RobotsCache, RobotsDisallowedError } from "../politeness/robots.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
/** Cap on how long a `Retry-After` may park a request. */
const MAX_RETRY_AFTER_MS = 60_000;

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
   * Falls back to the requested URL when the platform does not report one,
   * which is the case on the proxy path.
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
 * not captured on this path — `-w` gives us the status and nothing else — so a
 * proxied 429 backs off on the exponential schedule rather than on
 * `Retry-After`.
 */
async function fetchThroughProxy(
  url: string,
  proxy: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  const args = [
    "curl",
    "-s",
    "-w",
    "\n%{http_code}",
    "-x",
    proxy,
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-L",
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
  const status = Number.parseInt(lines.pop()?.trim() || "0", 10);
  return { status, body: lines.join("\n") };
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
   * Returns nothing; throws `RobotsDisallowedError` when the URL is off
   * limits. `Crawl-delay` is folded in as a floor here rather than at the
   * limiter, because it is a property of the site's rules and not of the
   * caller's configuration.
   */
  private async clearToFetch(url: string, opts: FetchOptions): Promise<void> {
    let crawlDelayMs: number | undefined;
    const userAgent = opts.userAgent ?? this.userAgent;

    if (this.respectRobots) {
      const rules = await this.robots.forUrl(url);
      if (!opts.allowDisallowed && !rules.isAllowed(url, userAgent)) {
        throw new RobotsDisallowedError(url, userAgent);
      }
      crawlDelayMs = rules.crawlDelayMs(userAgent);
    }

    // Each delay is checked on its own before they are combined, so an
    // unusable caller value cannot take the site's Crawl-delay down with it.
    const callerDelayMs = Number.isFinite(opts.delayMs) ? (opts.delayMs as number) : 0;
    await this.rateLimiter.acquire(hostOf(url), Math.max(callerDelayMs, crawlDelayMs ?? 0));
  }

  /**
   * GET with retries. Retries 429 and 5xx, honouring `Retry-After` when the
   * response carried one; a 4xx other than 429 is returned as-is, because
   * retrying it will not change the answer.
   */
  async get(url: string, opts: FetchOptions = {}): Promise<Response> {
    await this.clearToFetch(url, opts);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const headers: Record<string, string> = {
      "User-Agent": opts.userAgent ?? this.userAgent,
      Accept: "application/json, text/html, application/xml, */*",
      ...opts.headers,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
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
          });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(url, {
            headers,
            signal: controller.signal,
            redirect: "follow",
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
