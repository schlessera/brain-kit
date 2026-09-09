import type { Context, MiddlewareHandler } from "hono";

/**
 * The scheme a browser would put in an `Origin` header for a connection this
 * proxy describes.
 *
 * A browser's Origin is always http/https — never ws/wss, even for a
 * WebSocket. Reverse proxies do not agree on that: several report the
 * *connection* scheme in `X-Forwarded-Proto` and send `ws` / `wss` on an
 * upgrade while sending `https` on ordinary requests. Comparing that verbatim
 * builds an expected origin of `wss://host`, which no browser can ever match,
 * so every WebSocket handshake that falls back to the Origin comparison is
 * refused while HTTP keeps working. Browsers that send `Sec-Fetch-Site` on the
 * handshake never reach this path, which is what made it look like a
 * client-specific failure.
 */
function webOriginProtocol(forwarded: string): string {
  if (forwarded === "wss") return "https:";
  if (forwarded === "ws") return "http:";
  return `${forwarded}:`;
}

/**
 * Compare the browser's Origin with the request's externally visible origin.
 *
 * Without a trusted proxy the server cannot know whether TLS was terminated
 * upstream, so preserve the historical host+port comparison. Once proxy
 * headers are trusted, include the scheme sourced from X-Forwarded-Proto.
 */
function originMatchesRequest(
  c: Context,
  origin: string,
  trustProxy: boolean
): boolean {
  const host = c.req.header("host");
  if (!host) return false;

  const parsedOrigin = new URL(origin);
  if (!trustProxy) return parsedOrigin.host === host;

  const forwarded = c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwarded
    ? webOriginProtocol(forwarded.toLowerCase())
    : new URL(c.req.url).protocol;

  return parsedOrigin.origin === new URL(`${protocol}//${host}`).origin;
}

/**
 * Browser request origin policy shared by state-changing HTTP routes and the
 * WebSocket upgrade.
 *
 * Fetch metadata is authoritative when it says same-origin (including the
 * Vite proxy case where Host is rewritten). Older browsers fall back to an
 * Origin comparison: host+port without TRUST_PROXY, or the full origin when
 * proxy headers are trusted. Headerless non-browser clients remain accepted
 * and are still subject to the route's auth guard. ALLOWED_ORIGINS is an
 * additional path for explicitly configured split-topology deployments.
 */
export function isSameOriginRequest(
  c: Context,
  allowedOrigins: readonly string[],
  trustProxy = false
): boolean {
  const site = c.req.header("sec-fetch-site")?.toLowerCase();
  const origin = c.req.header("origin");

  // An opaque sandboxed origin is present, not equivalent to a headerless
  // non-browser client. Reject it even if other metadata claims same-origin.
  if (origin?.toLowerCase() === "null") return false;

  if (site === "same-origin" || site === "none") return true;

  if (origin) {
    try {
      if (originMatchesRequest(c, origin, trustProxy)) return true;
    } catch {
      // Malformed Origin can still only match an allowlist by exact string.
    }
  }

  if (!site && !origin) return true;

  return origin !== undefined && allowedOrigins.includes(origin);
}

/**
 * Enforce the origin policy on every non-GET API request, with an optional
 * additional allowlist confined to one route prefix.
 */
export function originPolicy(
  allowedOrigins: readonly string[],
  trustProxy = false,
  scopedAllowlist?: { pathPrefix: string; origins: readonly string[] }
): MiddlewareHandler {
  return async (c, next) => {
    const requestAllowedOrigins =
      scopedAllowlist && c.req.path.startsWith(scopedAllowlist.pathPrefix)
        ? [...allowedOrigins, ...scopedAllowlist.origins]
        : allowedOrigins;
    if (
      c.req.method !== "GET" &&
      !isSameOriginRequest(c, requestAllowedOrigins, trustProxy)
    ) {
      return c.json({ error: "cross_origin_rejected" }, 403);
    }
    await next();
  };
}

/** Require the exact JSON media type while allowing standard parameters. */
export function requireJson(): MiddlewareHandler {
  return async (c, next) => {
    const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    await next();
  };
}
