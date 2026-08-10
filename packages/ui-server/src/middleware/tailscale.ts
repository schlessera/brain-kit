import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * Restrict access to Tailscale VPN clients (CGNAT range 100.64.0.0/10) or
 * localhost.
 *
 * SECURITY: header trust is OFF by default. An exposed port lets anyone spoof
 * `x-forwarded-for`, so the real socket address is used unless `TRUST_PROXY=1`
 * — set that ONLY when a trusted reverse proxy in front of brain-ui sets the
 * forwarding header.
 */
export interface TailscaleGuardOptions {
  /** Trust x-forwarded-for / x-real-ip. Defaults to `TRUST_PROXY === "1"`. */
  trustProxy?: boolean;
}

export function tailscaleGuard(
  options: TailscaleGuardOptions = {}
): MiddlewareHandler {
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === "1";
  return async (c, next) => {
    if (isTailscaleAllowed(c, trustProxy)) {
      await next();
    } else {
      return c.json({ error: "VPN access required" }, 403);
    }
  };
}

/** True when the request's client IP is a Tailscale or loopback address. */
export function isTailscaleAllowed(c: Context, trustProxy: boolean): boolean {
  const ip = clientIp(c, trustProxy);
  return isTailscaleIp(ip) || isLocalIp(ip);
}

/**
 * The client IP. With `trustProxy`, read the forwarding header a trusted proxy
 * set; otherwise use the real socket address (unspoofable). Returns "" when the
 * source is unavailable (e.g. Hono's `app.request()` has no socket) — callers
 * treat "" as not-allowed.
 *
 * X-Forwarded-For is parsed RIGHT-TO-LEFT: each proxy appends the address it saw,
 * so the rightmost entries are the trusted hops we control and the leftmost is
 * client-controllable. `TRUST_PROXY_HOPS` (default 1) is how many proxies front
 * this app; the client IP is the entry just before them. Taking the leftmost
 * entry (the old behaviour) let a client spoof its address by pre-seeding XFF.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1);
        const ip = parts[Math.max(0, parts.length - hops)];
        if (ip) return ip;
      }
    }
    return c.req.header("x-real-ip") ?? "";
  }
  try {
    return getConnInfo(c).remote.address ?? "";
  } catch {
    return "";
  }
}

function isTailscaleIp(ip: string): boolean {
  // Tailscale CGNAT range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  if (!ip.startsWith("100.")) return false;
  const second = parseInt(ip.split(".")[1], 10);
  return second >= 64 && second <= 127;
}

function isLocalIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}
