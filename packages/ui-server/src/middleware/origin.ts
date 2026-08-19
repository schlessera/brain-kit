import type { Context } from "hono";

/**
 * Same-origin enforcement for requests a browser sends without a preflight.
 *
 * Every other state-changing route here reads `application/json`, which is not
 * a CORS-simple content type and so forces a preflight the attacker's origin
 * fails — CSRF-safe by accident. A multipart upload has no such protection: it
 * is a simple request, and under `AUTH_MODE=tailscale` the credential is the
 * source IP rather than a cookie, so no SameSite flag stands in the way either.
 * Any page opened on the tailnet could otherwise POST into the brain.
 *
 * The check is free because the routes that use it are only ever called by the
 * app itself, same-origin. Same shape as the WebSocket upgrade's origin guard.
 */
export function isSameOriginRequest(c: Context, allowed: string[]): boolean {
  // Chromium and Firefox send this, and it is not settable by script.
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";

  // Older browsers: fall back to Origin, and to the configured allowlist when
  // the deployment is split across origins.
  const origin = c.req.header("origin");
  if (!origin) return true; // A non-browser client; still gated by auth.
  if (allowed.length > 0) return allowed.includes(origin);
  try {
    const host = c.req.header("host");
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
