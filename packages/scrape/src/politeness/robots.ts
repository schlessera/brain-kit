/**
 * robots.txt: fetched once per origin, cached for the process, enforced by
 * default.
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
 */
import robotsParser from "robots-parser";

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
      if (typeof seconds !== "number" || !(seconds > 0)) return undefined;
      // `Infinity`, or a value that overflows once in ms, is a directive no
      // crawler can follow; it is ignored like a negative one, not obeyed by
      // parking the host's queue forever.
      const ms = seconds * 1000;
      return Number.isFinite(ms) ? ms : undefined;
    },
  };
}

/** How the cache reaches the network — injected so tests never do. */
export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; body: string }>;

const defaultFetcher: RobotsFetcher = async (robotsUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(robotsUrl, { signal: controller.signal, redirect: "follow" });
    return { status: res.status, body: res.status === 200 ? await res.text() : "" };
  } finally {
    clearTimeout(timer);
  }
};

export interface RobotsCacheOptions {
  fetcher?: RobotsFetcher;
}

/**
 * One robots.txt per origin, fetched at most once.
 *
 * In-flight fetches are shared: ten concurrent requests to a new host produce
 * one robots.txt fetch, not ten. Owned by the caller, like the rate limiter —
 * no module-level state.
 */
export class RobotsCache {
  private readonly rules = new Map<string, Promise<RobotsRules>>();
  private readonly fetcher: RobotsFetcher;

  constructor(options: RobotsCacheOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher;
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
    if (cached) return cached;

    const pending = this.load(`${origin}/robots.txt`);
    this.rules.set(origin, pending);
    return pending;
  }

  private async load(robotsUrl: string): Promise<RobotsRules> {
    try {
      const { status, body } = await this.fetcher(robotsUrl);
      // 404 (no rules) and 5xx (site cannot answer) both mean "no policy we
      // can apply" — see the module header for why that is permissive.
      if (status !== 200 || !body.trim()) return ALLOW_ALL;
      return parse(robotsUrl, body);
    } catch {
      return ALLOW_ALL;
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
    readonly userAgent: string
  ) {
    super(
      `robots.txt disallows ${url} for '${userAgent}'. ` +
        `Set allowDisallowed:true on this site's fetch options if you operate ` +
        `the host or have permission.`
    );
    this.name = "RobotsDisallowedError";
  }
}
