import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { isTailscaleAllowed, clientIp } from "./tailscale.js";
import type { AuthConfig } from "../config/env.js";

/**
 * Authentication for a remote surface to an agent with write access to the
 * user's files. Modes (AUTH_MODE):
 *
 * - `password`  — a single shared password (Bun.password argon2id hash in
 *                 BRAIN_UI_PASSWORD_HASH), a signed HttpOnly SameSite=Strict
 *                 session cookie (COOKIE_SECRET), a rate-limited login route.
 *                 The only mode where `docker compose up` on a bare VPS is safe.
 * - `tailscale` — Tailscale IP allowlist (today's model). Header trust is gated
 *                 behind TRUST_PROXY=1; otherwise the socket address is used.
 * - `proxy`     — trust an upstream auth header (PROXY_AUTH_HEADER) set by
 *                 Authelia / oauth2-proxy / Caddy basic_auth, etc.
 * - `none`      — no auth. REFUSES to start unless HOST is loopback (fail
 *                 closed), regardless of NODE_ENV; the only override is the
 *                 explicit BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1 escape hatch.
 *
 * Default: `password` when BRAIN_UI_PASSWORD_HASH is set, else `tailscale`.
 *
 * All configuration is injected as the resolved {@link AuthRuntime} — this
 * module never reads the environment, so two apps with different auth
 * configuration can coexist and tests vary it without global mutation. The
 * validation semantics themselves are unchanged.
 */

export type AuthMode = "password" | "tailscale" | "proxy" | "none";

/** What the auth layer needs from the resolved server config. */
export interface AuthRuntime extends AuthConfig {
  /** Bind host, for the loopback check on AUTH_MODE=none. */
  host: string;
}

const COOKIE_NAME = "brain_ui_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const LOGIN_RATE_LIMIT = 5; // attempts per window, per client IP
const LOGIN_RATE_WINDOW_MS = 60_000; // per minute
// A global cap in addition to the per-IP one: the per-IP key is derived from
// X-Forwarded-For, which a client behind a trusted proxy can rotate to mint a
// fresh bucket per request. The global cap bounds brute force across rotated
// IPs. It stays well above a human's needs and, combined with the argon2id
// verify cost, makes online guessing infeasible without being a lockout an
// attacker could weaponize to deny the owner access.
export const GLOBAL_LOGIN_RATE_LIMIT = 20; // attempts per window, all IPs combined

export function resolveAuthMode(auth: AuthRuntime): AuthMode {
  if (auth.mode) return auth.mode;
  if (auth.invalidMode) {
    console.warn(
      `[auth] Unknown AUTH_MODE="${auth.invalidMode}"; auto-detecting instead.`
    );
  }
  if (auth.passwordHash) return "password";
  return "tailscale";
}

/**
 * Validate the auth configuration at startup. Throws (refusing to boot) on an
 * unsafe or unusable configuration.
 */
export function assertAuthConfig(mode: AuthMode, auth: AuthRuntime): void {
  const host = auth.host;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

  if (mode === "password") {
    if (!auth.passwordHash) {
      throw new Error(
        "AUTH_MODE=password requires BRAIN_UI_PASSWORD_HASH. Generate one with:\n" +
          "  bun -e 'console.log(await Bun.password.hash(process.argv[1]))' 'your-password'"
      );
    }
    if (!auth.cookieSecret) {
      throw new Error(
        "AUTH_MODE=password requires COOKIE_SECRET (a long random string used to " +
          "sign the session cookie). Generate one with:\n  openssl rand -hex 32"
      );
    }
  }

  // Deliberately NOT gated on NODE_ENV: a forgotten env var must never be the
  // difference between "auth required" and "agent with file-write access
  // exposed to the network".
  if (mode === "none" && !loopback) {
    if (auth.dangerouslyDisableAuth) {
      console.warn(
        "[auth] AUTH_MODE=none on a non-loopback host, allowed by " +
          "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1 — every network peer has full " +
          "agent access. Do not run this on anything but a trusted network."
      );
    } else {
      throw new Error(
        "AUTH_MODE=none refuses to start unless HOST is loopback " +
          `(got HOST="${host}"). Running with no auth would expose an agent with ` +
          "write access to your files to the whole network. Set AUTH_MODE=password " +
          "(recommended), tailscale, or proxy — or bind HOST to 127.0.0.1. " +
          "To intentionally run unauthenticated on a trusted network, set " +
          "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1."
      );
    }
  }

  if (mode === "proxy") {
    if (!auth.trustProxy) {
      throw new Error(
        "AUTH_MODE=proxy requires TRUST_PROXY=1 — the proxy-auth header is only " +
          "trustworthy when a fronting proxy is guaranteed to set it and strip " +
          "any client-supplied copy. Set TRUST_PROXY=1 once that holds."
      );
    }
    console.log(
      `[auth] mode: proxy (trusting header "${auth.proxyAuthHeader}"; ensure your ` +
        "upstream proxy sets it and strips any client-supplied copy)"
    );
    return;
  }
  console.log(`[auth] mode: ${mode}`);
}

/** Middleware guarding /api/* according to the resolved mode. */
export function authGuard(mode: AuthMode, auth: AuthRuntime): MiddlewareHandler {
  switch (mode) {
    case "tailscale":
      return async (c, next) => {
        if (isTailscaleAllowed(c, auth.trustProxy, auth.trustProxyHops)) {
          await next();
        } else {
          return c.json({ error: "VPN access required" }, 403);
        }
      };
    case "proxy":
      return async (c, next) => {
        if (hasProxyAuth(c, auth)) {
          await next();
        } else {
          return c.json(
            { error: "Authentication required", authRequired: true },
            401
          );
        }
      };
    case "password":
      return async (c, next) => {
        if (await hasValidSession(c, auth)) {
          await next();
        } else {
          return c.json(
            { error: "Authentication required", authRequired: true },
            401
          );
        }
      };
    case "none":
      return async (_c, next) => {
        await next();
      };
  }
}

/**
 * Authorize a WebSocket upgrade. The upgrade handler must call this itself —
 * browsers can't set headers on the WS handshake, so the session cookie (sent
 * automatically same-origin) is the credential, and no header-modifying
 * middleware may sit on the WS route (immutable-header errors). Mirrors
 * {@link authGuard} without emitting a response.
 */
export async function isWsAuthorized(
  c: Context,
  mode: AuthMode,
  auth: AuthRuntime
): Promise<boolean> {
  switch (mode) {
    case "none":
      return true;
    case "tailscale":
      return isTailscaleAllowed(c, auth.trustProxy, auth.trustProxyHops);
    case "proxy":
      return hasProxyAuth(c, auth);
    case "password":
      return hasValidSession(c, auth);
  }
}

// --- password mode helpers ---

/**
 * Mint the session cookie. The single place a session comes into existence —
 * both password login and passkey login (middleware/passkeys.ts) call this, so
 * authGuard / isWsAuthorized / TTL semantics stay identical across methods.
 */
export async function issueSessionCookie(c: Context, auth: AuthRuntime): Promise<void> {
  const secret = auth.cookieSecret ?? "";
  await setSignedCookie(c, COOKIE_NAME, String(Date.now()), secret, {
    httpOnly: true,
    sameSite: "Strict",
    // Always Secure — every real deployment serves over HTTPS, and we do not
    // want a missing NODE_ENV to silently drop the flag and expose the cookie
    // over plaintext. (Local password testing must use https/localhost.)
    secure: true,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function hasValidSession(c: Context, auth: AuthRuntime): Promise<boolean> {
  const secret = auth.cookieSecret ?? "";
  if (!secret) return false;
  try {
    const value = await getSignedCookie(c, secret, COOKIE_NAME);
    if (typeof value !== "string" || value.length === 0) return false;
    // The cookie value is the issue timestamp. Validate its age server-side:
    // Max-Age is client-discardable, so the signature alone does not bound a
    // session's lifetime — this does.
    const issuedAt = Number(value);
    if (!Number.isFinite(issuedAt)) return false;
    const ageSeconds = (Date.now() - issuedAt) / 1000;
    return ageSeconds >= 0 && ageSeconds < SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

// --- proxy mode helpers ---

function hasProxyAuth(c: Context, auth: AuthRuntime): boolean {
  // The proxy-auth header is only meaningful when a trusted proxy fronts the app
  // and TRUST_PROXY says so; otherwise a client could set it directly. Gate on
  // trustProxy, consistent with tailscale-mode XFF trust. (assertAuthConfig
  // already refuses to boot proxy mode without it — this is belt-and-braces.)
  if (!auth.trustProxy) return false;
  const user = c.req.header(auth.proxyAuthHeader);
  return !!user && user.trim().length > 0;
}

// --- login rate limiter (in-memory token bucket, per client IP) ---

interface Bucket {
  tokens: number;
  resetAt: number;
}
const loginBuckets = new Map<string, Bucket>();

/** Test-only: clear all rate-limit buckets (they are module-global state). */
export function resetLoginRateLimiter(): void {
  loginBuckets.clear();
}

export function consumeLoginToken(key: string, limit: number): boolean {
  const now = Date.now();
  let bucket = loginBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { tokens: limit, resetAt: now + LOGIN_RATE_WINDOW_MS };
    loginBuckets.set(key, bucket);
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

/** Login/logout routes. Only functional in `password` mode. */
export function authRoutes(
  mode: AuthMode,
  auth: AuthRuntime,
  deps: {
    /**
     * When provided and returning true, password login is refused (the app
     * injects passkeys' passwordLoginDisabled so the shared password dies
     * once a passkey exists for the RP). Injected to keep this module free
     * of WebAuthn concerns.
     */
    passwordDisabled?: (c: Context) => boolean;
  } = {}
): Hono {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    if (mode !== "password") {
      return c.json({ error: "Password login is not enabled" }, 400);
    }

    const key = clientIp(c, auth.trustProxy, auth.trustProxyHops) || "unknown";
    const perIpOk = consumeLoginToken(`ip:${key}`, LOGIN_RATE_LIMIT);
    const globalOk = consumeLoginToken("global", GLOBAL_LOGIN_RATE_LIMIT);
    if (!perIpOk || !globalOk) {
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    }

    if (deps.passwordDisabled?.(c)) {
      return c.json(
        { error: "Password login is disabled — sign in with a passkey." },
        403
      );
    }

    const hash = auth.passwordHash ?? "";
    const secret = auth.cookieSecret ?? "";
    let body: { password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !hash || !secret) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const ok = await Bun.password.verify(password, hash).catch(() => false);
    if (!ok) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    await issueSessionCookie(c, auth);
    return c.json({ ok: true });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
