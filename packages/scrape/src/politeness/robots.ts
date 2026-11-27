/**
 * robots.txt: fetched once per origin, kept for a day (five minutes after a
 * failed fetch), enforced by default.
 *
 * Enforcement is the package's default rather than an opt-in because this is a
 * published library: a consumer who never thinks about robots.txt should get
 * the polite behaviour, and the one who has a reason to override should have
 * to say so per site. `Crawl-delay` is honoured too, which most scrapers that
 * bother parsing robots.txt at all still skip — it is the directive that
 * actually protects the site operator, and ignoring it while quoting
 * compliance is the worst of both.
 *
 * Failure is permissive on purpose. A 404 means "no rules"; a timeout or a 500
 * means the site could not tell us its rules, and treating that as a blanket
 * Disallow would make an unrelated outage look like a policy. Only a real
 * Disallow blocks.
 *
 * The network fetch is bounded: it sends the client's User-Agent, follows at
 * most `maxRedirects` hops one at a time, refuses a body over `maxBytes`, and
 * holds every hop to the cache's address policy. Hitting a bound is a failed
 * fetch, so it is permissive in the same way.
 */
import robotsParser from "robots-parser";

import { DEFAULT_USER_AGENT } from "../config/env.js";
import { checkPublicUrl, fetchUnderPolicy } from "./address.js";
import type { AddressLookup, AddressPolicy } from "./address.js";

/** What a robots.txt fetch concluded, before any URL is tested against it. */
export interface RobotsRules {
  /** True when `isAllowed` may be trusted; false when the fetch failed. */
  loaded: boolean;
  isAllowed(url: string, userAgent: string): boolean;
  /** Crawl-delay in ms for this user agent, or undefined when unset. */
  crawlDelayMs(userAgent: string): number | undefined;
}

/** Rules that permit everything — a 404, or a fetch we could not complete. */
const ALLOW_ALL: RobotsRules = {
  loaded: false,
  isAllowed: () => true,
  crawlDelayMs: () => undefined,
};

function parse(robotsUrl: string, body: string): RobotsRules {
  const parsed = robotsParser(robotsUrl, body);
  return {
    loaded: true,
    isAllowed(url, userAgent) {
      // The library returns undefined when it has no opinion (no matching
      // group, unparseable URL). No opinion means allowed.
      return parsed.isAllowed(url, userAgent) ?? true;
    },
    crawlDelayMs(userAgent) {
      const seconds = parsed.getCrawlDelay(userAgent);
      // May be `Infinity` (written so, or overflowing once in ms): that is the
      // site asking for more spacing than any crawler can give, and it is
      // `ScrapeClient` that decides what to do about it, not this parser.
      return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
    },
  };
}

/** How the cache reaches the network — injected so tests never do. */
export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; body: string }>;

/** Default cap on a robots.txt body: twice the 500 KiB RFC 9309 asks crawlers to parse. */
export const DEFAULT_ROBOTS_MAX_BYTES = 1024 * 1024;
/** Default robots.txt redirect limit: the five hops RFC 9309 asks crawlers to follow. */
export const DEFAULT_ROBOTS_MAX_REDIRECTS = 5;
const ROBOTS_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Read at most `maxBytes` of a body as UTF-8, refusing a longer one. */
async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`robots.txt body exceeds ${maxBytes} bytes`);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

/**
 * The network fetcher a cache uses unless one is injected.
 *
 * It identifies itself with the client's User-Agent, follows redirects one
 * hop at a time (so each hop is held to the address policy) up to a limit,
 * and refuses a body over the size limit. A refusal is a failed fetch, which
 * the cache treats permissively like any other (see the module header).
 */
function networkFetcher(options: Required<Pick<RobotsCacheOptions, "userAgent" | "maxBytes" | "maxRedirects" | "addressPolicy">> & { lookup?: AddressLookup }): RobotsFetcher {
  return async (robotsUrl) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
    try {
      let current = robotsUrl;
      for (let redirects = 0; ; redirects++) {
        const res = await fetchUnderPolicy(current, {
          signal: controller.signal,
          redirect: "manual",
          headers: { "User-Agent": options.userAgent },
        }, options.addressPolicy, options.lookup);
        const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
        if (!location) {
          if (res.status !== 200) {
            await res.body?.cancel().catch(() => {});
            return { status: res.status, body: "" };
          }
          return { status: 200, body: await boundedText(res, options.maxBytes) };
        }
        await res.body?.cancel().catch(() => {});
        if (redirects >= options.maxRedirects) {
          throw new Error(`${robotsUrl} redirected more than ${options.maxRedirects} times`);
        }
        const next = new URL(location, current);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`${current} redirected to unsupported URL ${next.href}`);
        }
        if (next.username || next.password) {
          throw new Error(`${current} redirected to a URL with embedded credentials`);
        }
        current = next.href;
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RobotsCacheOptions {
  /** Replaces the network fetch entirely; the options below then do not apply to it. */
  fetcher?: RobotsFetcher;
  /** Sent with the robots.txt fetch. Defaults to this package's identifying User-Agent. */
  userAgent?: string;
  /** Largest robots.txt body read, in bytes; a longer one counts as a failed fetch. */
  maxBytes?: number;
  /** Redirects followed before the fetch counts as failed. */
  maxRedirects?: number;
  /**
   * Which addresses the robots.txt fetch and each of its redirect hops may
   * reach. Default `"any"`; see `ScrapeClientOptions.addressPolicy`.
   */
  addressPolicy?: AddressPolicy;
  /** Resolver for `"public-only"` checks. Defaults to the system resolver. */
  lookup?: AddressLookup;
  /**
   * How long a definite answer (a 200, empty or not, or a 4xx meaning "no
   * rules") is used before robots.txt is fetched again, in ms. Default 24
   * hours, the most RFC 9309 asks a crawler to keep one.
   */
  maxAgeMs?: number;
  /** How long a failed fetch (a 5xx, a thrown or timed-out fetch, a bound exceeded) is kept, in ms. Default 5 minutes. */
  failureMaxAgeMs?: number;
  /** Origins kept at once; past it the least recently used is dropped. Default 1,000. */
  maxEntries?: number;
  /** Clock for the ages above, in ms. Defaults to `Date.now`; tests inject one. */
  now?: () => number;
}

/** Default lifetime of a definite robots.txt answer: RFC 9309's 24 hours. */
const DEFAULT_ROBOTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Default lifetime of a failed robots.txt fetch. */
const DEFAULT_ROBOTS_FAILURE_MAX_AGE_MS = 5 * 60 * 1000;
/** Default number of origins a cache keeps. */
const DEFAULT_ROBOTS_MAX_ENTRIES = 1000;

interface CachedRules {
  rules: Promise<RobotsRules>;
  /** When the entry stops answering; `Infinity` while its fetch is in flight. */
  expiresAt: number;
}

/**
 * One robots.txt per origin, fetched again once its answer is older than
 * `maxAgeMs` (`failureMaxAgeMs` for a failed fetch), for at most `maxEntries`
 * origins.
 *
 * In-flight fetches are shared: ten concurrent requests to a new host, or to
 * one whose entry just expired, produce one robots.txt fetch, not ten. Owned
 * by the caller, like the rate limiter — no module-level state.
 */
export class RobotsCache {
  /** In least-recently-used order: a hit moves its origin to the end. */
  private readonly rules = new Map<string, CachedRules>();
  private readonly maxAgeMs: number;
  private readonly failureMaxAgeMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly fetcher: RobotsFetcher;
  /** The address policy this cache's own fetches are held to. */
  readonly addressPolicy: AddressPolicy;
  private readonly lookup: AddressLookup | undefined;
  /** An injected fetcher is held to the policy for the URL it is handed; the network one checks every hop itself. */
  private readonly checkBeforeFetch: boolean;

  constructor(options: RobotsCacheOptions = {}) {
    this.addressPolicy = options.addressPolicy ?? "any";
    this.lookup = options.lookup;
    this.checkBeforeFetch = this.addressPolicy === "public-only" && options.fetcher !== undefined;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_ROBOTS_MAX_AGE_MS;
    this.failureMaxAgeMs = options.failureMaxAgeMs ?? DEFAULT_ROBOTS_FAILURE_MAX_AGE_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_ROBOTS_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? networkFetcher({
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      maxBytes: options.maxBytes ?? DEFAULT_ROBOTS_MAX_BYTES,
      maxRedirects: options.maxRedirects ?? DEFAULT_ROBOTS_MAX_REDIRECTS,
      addressPolicy: this.addressPolicy,
      lookup: options.lookup,
    });
  }

  /** Rules for the origin of `url`. Never rejects. */
  async forUrl(url: string): Promise<RobotsRules> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return ALLOW_ALL;
    }

    const cached = this.rules.get(origin);
    this.rules.delete(origin);
    if (cached && this.now() < cached.expiresAt) {
      this.rules.set(origin, cached);
      return cached.rules;
    }

    const entry = { expiresAt: Infinity } as CachedRules;
    entry.rules = this.load(`${origin}/robots.txt`).then(({ rules, definite }) => {
      entry.expiresAt = this.now() + (definite ? this.maxAgeMs : this.failureMaxAgeMs);
      return rules;
    });
    this.rules.set(origin, entry);
    for (const oldest of this.rules.keys()) {
      if (this.rules.size <= this.maxEntries) break;
      this.rules.delete(oldest);
    }
    return entry.rules;
  }

  /** The rules, and whether they are a definite answer or a failed fetch. Never rejects. */
  private async load(robotsUrl: string): Promise<{ rules: RobotsRules; definite: boolean }> {
    try {
      if (this.checkBeforeFetch) await checkPublicUrl(robotsUrl, this.lookup);
      const { status, body } = await this.fetcher(robotsUrl);
      // 404 (no rules) and 5xx (site cannot answer) both mean "no policy we
      // can apply" — see the module header for why that is permissive. Only
      // a 200 or a 4xx is a definite answer worth keeping for `maxAgeMs`.
      const definite = status === 200 || (status >= 400 && status < 500);
      if (status !== 200 || !body.trim()) return { rules: ALLOW_ALL, definite };
      return { rules: parse(robotsUrl, body), definite };
    } catch {
      return { rules: ALLOW_ALL, definite: false };
    }
  }

  reset(): void {
    this.rules.clear();
  }
}

/** Thrown when robots.txt disallows a URL and the caller did not opt out. */
export class RobotsDisallowedError extends Error {
  constructor(
    readonly url: string,
    readonly userAgent: string,
    /** Why, when it is not a `Disallow` line — e.g. an unfollowable Crawl-delay. */
    readonly reason?: string
  ) {
    super(
      `robots.txt disallows ${url} for '${userAgent}'` +
        (reason ? ` (${reason})` : "") +
        `. Set allowDisallowed:true on this site's fetch options if you operate ` +
        `the host or have permission.`
    );
    this.name = "RobotsDisallowedError";
  }
}
