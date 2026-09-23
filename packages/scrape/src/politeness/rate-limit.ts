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
  /** Per host, settles when the most recently queued caller has been granted. */
  private readonly queue = new Map<string, Promise<void>>();
  private readonly defaultDelayMs: number;
  private readonly clock: RateLimiterClock;

  constructor(options: RateLimiterOptions = {}) {
    this.defaultDelayMs = options.defaultDelayMs ?? 0;
    this.clock = options.clock ?? realClock;
  }

  /**
   * Wait until this host may be hit again, then claim the slot.
   *
   * `delayMs` overrides the default for this call — that is how a robots.txt
   * `Crawl-delay` raises the floor for one host without reconfiguring the
   * limiter.
   *
   * Callers to one host are granted one at a time, in arrival order: each
   * waits for the caller ahead of it to be granted before measuring its own
   * delay. Without that, concurrent callers all read the same `lastStart` and
   * wake together. The delay is measured from the time the previous grant
   * actually happened, and re-checked after every sleep, so a timer that
   * fires late never lets the next caller in early.
   */
  async acquire(host: string, delayMs?: number): Promise<void> {
    const delay = Math.max(delayMs ?? 0, this.defaultDelayMs);
    if (delay <= 0) {
      this.lastStart.set(host, this.clock.now());
      return;
    }

    const ahead = this.queue.get(host);
    let granted!: () => void;
    const mine = new Promise<void>((resolve) => (granted = resolve));
    this.queue.set(host, mine);
    try {
      if (ahead) await ahead;
      for (;;) {
        const last = this.lastStart.get(host);
        if (last === undefined) break;
        const elapsed = this.clock.now() - last;
        if (elapsed >= delay) break;
        await this.clock.sleep(delay - elapsed);
      }
      this.lastStart.set(host, this.clock.now());
    } finally {
      granted();
      if (this.queue.get(host) === mine) this.queue.delete(host);
    }
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
