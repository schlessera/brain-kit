/**
 * The robots.txt checker for Apify runs of robots-authorized profiles (#3330).
 *
 * A qualified profile whose site authorization is `robots` may only start when
 * every target URL is allowed by its site's robots.txt, checked by the host
 * before the start request (`sitePermission` in
 * `@schlessera/brain-common/internal/apify`). This is that check, and the one
 * implementation both hosts use: the standalone CLI and MCP process builds it
 * here, and the hosted server loads it from this package when core is
 * installed (maintainer ruling on #3330, recorded in `tests/allowed-edges.ts`).
 *
 * It applies the scraping package's rules rather than a second reading of
 * robots.txt ([scraping politeness](../../../../../docs/decisions/scraping-politeness.md)):
 * one `RobotsCache` per checker, so each origin's robots.txt is fetched once
 * per process; the scrape package's identifying User-Agent for the fetch and
 * the match; and its `"public-only"` address policy, so a robots.txt fetch (and
 * each of its redirect hops) never reaches a private, loopback or link-local
 * address from this host. A 404 or an unreachable robots.txt means no rules,
 * as it does for every scraping client; only a real `Disallow` refuses.
 *
 * Scrape is a hard dependency of core, but it is loaded on the first check,
 * not when the CLI starts: every `brain` command loads this module, and only a
 * robots-authorized run needs the scraping stack.
 */
import type { AddressPolicy, RobotsCache } from "@schlessera/brain-scrape";
import type { ApifySitePermission } from "@schlessera/brain-common/internal/apify";

/** The address policy every robots.txt fetch for an Apify run is held to. */
export const APIFY_ROBOTS_ADDRESS_POLICY: AddressPolicy = "public-only";

/** The User-Agent the robots.txt is fetched with and matched against: the scrape package's own. */
export async function apifyRobotsUserAgent(): Promise<string> {
  return (await import("@schlessera/brain-scrape/internal")).DEFAULT_USER_AGENT;
}

export interface ApifySitePermissionOptions {
  /**
   * @internal Test seam: lets an offline test reach its loopback robots.txt
   * server. Production is always {@link APIFY_ROBOTS_ADDRESS_POLICY}.
   */
  addressPolicy?: AddressPolicy;
}

/** Stop waiting on an abort without abandoning the cache's shared fetch. */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * A robots.txt checker for one process. Resolves true only when the target's
 * robots.txt allows it; rejects when the turn is aborted, which the run
 * service treats as a refusal.
 */
export function createApifySitePermission(options: ApifySitePermissionOptions = {}): ApifySitePermission {
  let robots: Promise<{ cache: RobotsCache; userAgent: string }> | undefined;
  return async (url, signal) => {
    signal?.throwIfAborted();
    robots ??= Promise.all([import("@schlessera/brain-scrape"), apifyRobotsUserAgent()]).then(([{ RobotsCache }, userAgent]) =>
      ({ cache: new RobotsCache({ addressPolicy: options.addressPolicy ?? APIFY_ROBOTS_ADDRESS_POLICY, userAgent }), userAgent }));
    const { cache, userAgent } = await robots;
    const rules = await abortable(cache.forUrl(url), signal);
    return rules.isAllowed(url, userAgent);
  };
}
