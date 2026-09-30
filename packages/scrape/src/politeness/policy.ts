import { abortable } from "./abort.js";
import { MAX_DELAY_MS, RateLimiter, hostOf } from "./rate-limit.js";
import { RobotsCache, RobotsDisallowedError } from "./robots.js";

/** Shared HTTP/browser policy; transport-specific override scope stays with the caller. */
export async function clearToFetch(
  url: string,
  policy: { robots: RobotsCache; rateLimiter: RateLimiter; userAgent: string; respectRobots: boolean },
  opts: { userAgent?: string; allowDisallowed?: boolean; delayMs?: number; signal?: AbortSignal },
): Promise<number> {
  opts.signal?.throwIfAborted();
  let crawlDelayMs: number | undefined;
  const userAgent = opts.userAgent ?? policy.userAgent;
  if (policy.respectRobots) {
    const rules = await abortable(policy.robots.forUrl(url), opts.signal);
    if (!opts.allowDisallowed && !rules.isAllowed(url, userAgent)) {
      throw new RobotsDisallowedError(url, userAgent);
    }
    crawlDelayMs = rules.crawlDelayMs(userAgent);
    if (!opts.allowDisallowed && crawlDelayMs !== undefined && !(crawlDelayMs <= MAX_DELAY_MS)) {
      throw new RobotsDisallowedError(url, userAgent, "its Crawl-delay is longer than this client can wait, 2^31 - 1 ms");
    }
    if (crawlDelayMs !== undefined && !(crawlDelayMs <= MAX_DELAY_MS)) crawlDelayMs = undefined;
  }
  const callerDelayMs = Number.isFinite(opts.delayMs) ? (opts.delayMs as number) : 0;
  const delayMs = Math.max(callerDelayMs, crawlDelayMs ?? 0);
  await policy.rateLimiter.acquire(hostOf(url), delayMs, opts.signal);
  return delayMs;
}
