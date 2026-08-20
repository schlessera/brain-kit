/**
 * Per-connection inbound frame metering.
 *
 * Frames are already size-, cardinality- and depth-bounded, so the cheap CPU
 * amplification is closed. What was left unmetered is VOLUME: a flood of
 * individually valid frames behind the auth guard. That is a smaller threat
 * than an unauthenticated one — it needs a session — but "the attacker had to
 * log in first" is not a bound.
 *
 * A token bucket rather than a fixed window, because the traffic this protects
 * is bursty by nature and a fixed window punishes the wrong thing. Opening the
 * app fires a handful of frames at once (resume, environment, a first
 * message); an approval storm during a busy turn is a dozen in a second. Both
 * are legitimate and both fit in the burst. What does not fit is a sustained
 * rate no human produces.
 *
 * Inbound traffic is naturally low-rate — deltas flow the other way — so the
 * defaults are generous enough that no real client should ever see one of
 * these, which is the property that makes it safe to turn on by default.
 */

/** Injected so tests need no real time. */
export interface Clock {
  now(): number;
}

const realClock: Clock = { now: () => Date.now() };

export interface RateLimitOptions {
  /** Sustained frames per second. */
  ratePerSecond: number;
  /** Frames absorbable in one burst before the sustained rate applies. */
  burst: number;
  clock?: Clock;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this decision, for reporting. */
  remaining: number;
}

/**
 * One bucket per connection. Not shared, and not keyed by anything
 * user-supplied: a map keyed by session or IP is itself an unbounded
 * allocation an attacker controls, which is the classic way a rate limiter
 * becomes the memory-exhaustion bug it was added to prevent. This lives on the
 * socket and dies with it.
 */
export class FrameRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly clock: Clock;
  /** Frames refused since the connection opened. */
  private rejected = 0;

  constructor(options: RateLimitOptions) {
    this.burst = Math.max(1, options.burst);
    this.ratePerMs = Math.max(0, options.ratePerSecond) / 1000;
    this.clock = options.clock ?? realClock;
    this.tokens = this.burst;
    this.lastRefill = this.clock.now();
  }

  /** Take one token. False means this frame should be refused. */
  take(): RateLimitDecision {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerMs);

    if (this.tokens < 1) {
      this.rejected++;
      return { allowed: false, remaining: 0 };
    }
    this.tokens -= 1;
    return { allowed: true, remaining: Math.floor(this.tokens) };
  }

  /** How many frames this connection has had refused. */
  get rejectedCount(): number {
    return this.rejected;
  }
}
