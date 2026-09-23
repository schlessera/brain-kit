/**
 * Per-host request spacing.
 *
 * The version this replaces kept its clock in a module-level `Map` shared by
 * every caller in the process. That is wrong in two ways that only show up
 * later: two independently-configured scrapers silently throttled each other,
 * and a test could not run without inheriting whatever the previous test had
 * left in the map. A limiter is an object you own.
 *
 * Spacing is "time since the last request STARTED", not "since it finished",
 * which is what `Crawl-delay` means. Requests to different hosts never wait on
 * each other.
 */

/** How the limiter measures and waits — injected so tests need no real time. */
export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RateLimiterOptions {
  /** Minimum ms between requests to one host when nothing else applies. */
  defaultDelayMs?: number;
  clock?: RateLimiterClock;
}

export class RateLimiter {
  private readonly lastStart = new Map<string, number>();
  private readonly defaultDelayMs: number;
  private readonly clock: RateLimiterClock;

  constructor(options: RateLimiterOptions = {}) {
    this.defaultDelayMs = options.defaultDelayMs ?? 0;
    this.clock = options.clock ?? realClock;
  }

  /**
   * Claim this host's next slot, then wait until it arrives.
   *
   * `delayMs` overrides the default for this call — that is how a robots.txt
   * `Crawl-delay` raises the floor for one host without reconfiguring the
   * limiter.
   *
   * The slot is reserved BEFORE the wait, so concurrent callers queue behind
   * each other instead of all reading the same `lastStart` and waking
   * together. A caller's delay is measured from the slot reserved before it,
   * which may still be in the future.
   */
  async acquire(host: string, delayMs?: number): Promise<void> {
    const delay = Math.max(delayMs ?? 0, this.defaultDelayMs);
    const now = this.clock.now();
    const last = this.lastStart.get(host);
    if (delay <= 0) {
      // Never pull a slot someone else has reserved back to "now".
      this.lastStart.set(host, last === undefined ? now : Math.max(last, now));
      return;
    }
    const start = last === undefined ? now : Math.max(now, last + delay);
    this.lastStart.set(host, start);
    if (start > now) await this.clock.sleep(start - now);
  }

  /** Forget all recorded timings. */
  reset(): void {
    this.lastStart.clear();
  }
}

/** Hostname of a URL, or the raw string when it will not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
