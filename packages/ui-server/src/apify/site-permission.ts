/**
 * The hosted server's robots.txt checker for Apify runs (#3330).
 *
 * The checker lives in core (`createApifySitePermission`,
 * `@schlessera/brain/internal/apify`), which builds it on the scrape
 * package's robots cache, address policy and User-Agent, so the hosted
 * server and a standalone `brain apify` or `brain mcp` process apply one
 * implementation. This package reaches core only as an optional peer (#696),
 * and the maintainer ruling on #3330 gives it no edge of its own to the
 * scrape package. So core is loaded on the first robots-authorized run, not
 * at boot, and a host without core cannot check robots.txt: every such run
 * refuses before anything is started, as it did before this checker existed.
 */
import { ApifySitePermissionUnavailable, type ApifySitePermission } from "@schlessera/brain-common/internal/apify";

/** What this module reads from `@schlessera/brain/internal/apify`, stated structurally so no type names the optional peer. */
interface CoreApify {
  createApifySitePermission(options?: { addressPolicy?: "any" | "public-only" }): ApifySitePermission;
}

export interface CoreSitePermissionOptions {
  /** @internal Test seam: how core is loaded. Default: the optional peer. */
  load?: () => Promise<CoreApify>;
  /** @internal Test seam: passed to core's checker so an offline test can reach its loopback robots.txt server. */
  addressPolicy?: "any" | "public-only";
}

/**
 * A checker that loads core's on first use and keeps it, with its robots
 * cache, for the life of the host. When core cannot be loaded the failure is
 * kept too, so every robots-authorized run refuses rather than one in a
 * while succeeding.
 */
export function coreSitePermission(options: CoreSitePermissionOptions = {}): ApifySitePermission {
  const load = options.load ?? (() => import("@schlessera/brain/internal/apify"));
  let checker: Promise<ApifySitePermission> | undefined;
  return async (url, signal) => {
    checker ??= load().then(core => core.createApifySitePermission(options.addressPolicy ? { addressPolicy: options.addressPolicy } : {}),
      () => { throw new ApifySitePermissionUnavailable("This host cannot check robots.txt: @schlessera/brain is not installed."); });
    return (await checker)(url, signal);
  };
}
