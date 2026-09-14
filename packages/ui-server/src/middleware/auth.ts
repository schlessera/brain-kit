import type { Counter } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import { isTailscaleAllowed, clientIp } from "./tailscale.js";
import type { AuthConfig } from "../config/env.js";
import { readJsonBody } from "./body-limit.js";
import { requireJson } from "./origin.js";
import { setSetting } from "../db/settings.js";
import {
  createPrincipal,
  isUsablePrincipal,
  PrincipalLimitError,
  prunePrincipals,
  prunePrincipalsIfDue,
  resolveAmbientPrincipal,
  resolvePrincipal,
  revokeAllPrincipals,
  touchLastSeen,
  type Principal,
} from "../db/principals.js";
import type { AppEnv } from "../app-env.js";
import type { WsHost } from "../ws/host.js";

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
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const LOGIN_LABEL_MAX_LENGTH = 64;
const LOGIN_LABEL_FALLBACK = "Unknown device";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const SESSIONS_EPOCH_KEY = "auth.sessionsEpoch";
const SESSION_REVOKED_CLOSE_CODE = 1008;
const SESSION_REVOKED_CLOSE_REASON = "Sessions invalidated";

export const LOGIN_RATE_LIMIT = 5; // failures per window, per client IP
const LOGIN_RATE_WINDOW_MS = 60_000; // per minute
// A global cap in addition to the per-IP one: the per-IP key is derived from
// X-Forwarded-For, which a client behind a trusted proxy can rotate to mint a
// fresh bucket per request. The global cap bounds brute force across rotated
// IPs. At 100 genuine failures/minute it stays well above a human's needs and
// makes a global lockout substantially harder to weaponize, while still
// bounding distributed online guessing. Per-IP failures remain at 5/minute.
// Passkeys get 5 matched-but-invalid assertions/minute in an independent
// `pk:` bucket: assertions are not guessable, but verification still consumes
// resources. Password and passkey verification therefore each allow two
// in-flight operations per IP and eight process-wide. Two tolerates a browser
// retry/double-submit; eight bounds either verifier's comparable CPU cost.
// Keeping the reservation pools separate preserves passkeys' independent
// admission path while each pool still has a process-wide ceiling. The failure
// map and both reservation maps cap at 1,024 source keys, comfortably above
// the global password-failure budget while bounding forged-IP memory growth.
export const GLOBAL_LOGIN_RATE_LIMIT = 100; // failures per window, all IPs combined
export const PASSKEY_LOGIN_RATE_LIMIT = 5;
const PASSWORD_VERIFY_IN_FLIGHT_PER_IP = 2;
const PASSWORD_VERIFY_IN_FLIGHT_GLOBAL = 8;
const PASSKEY_VERIFY_IN_FLIGHT_PER_IP = 2;
const PASSKEY_VERIFY_IN_FLIGHT_GLOBAL = 8;
const LOGIN_BUCKET_CAP = 1_024;
// Client-derived password buckets always start `pw:ip:`, which cannot equal
// the fixed `pw:global` key for any client-controlled key suffix. Keeping these
// namespaces disjoint prevents a per-IP saturated write from clamping the
// authoritative global failure counter to the smaller per-IP limit.
const PASSWORD_IP_BUCKET_PREFIX = "pw:ip:";
const PASSWORD_GLOBAL_BUCKET = "pw:global";

export function resolveAuthMode(auth: AuthRuntime, log?: Logger): AuthMode {
  if (auth.mode) return auth.mode;
  if (auth.invalidMode) {
    log?.emit({
      severityText: "WARN",
      body: "unknown AUTH_MODE; auto-detecting instead",
      attributes: { requested: auth.invalidMode },
    });
  }
  if (auth.passwordHash) return "password";
  return "tailscale";
}

/**
 * Validate the auth configuration at startup. Throws (refusing to boot) on an
 * unsafe or unusable configuration.
 */
export function assertAuthConfig(mode: AuthMode, auth: AuthRuntime, log?: Logger): void {
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
      // ERROR, not WARN: this is a safety that has been deliberately switched
      // off, and the severity must survive any sane BRAIN_UI_LOG_LEVEL. A log
      // threshold must never be the reason nobody saw this.
      log?.emit({
        severityText: "ERROR",
        body:
          "AUTH_MODE=none on a non-loopback host, allowed by " +
          "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1 — every network peer has full " +
          "agent access. Do not run this on anything but a trusted network.",
        attributes: { "auth.mode": "none", host },
      });
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
    log?.emit({
      severityText: "INFO",
      body:
        "auth mode resolved: proxy — ensure the upstream proxy sets this header " +
        "and strips any client-supplied copy",
      attributes: { "auth.mode": "proxy", header: auth.proxyAuthHeader },
    });
    return;
  }
  log?.emit({
    severityText: "INFO",
    body: "auth mode resolved",
    attributes: { "auth.mode": mode },
  });
}

/** Middleware guarding /api/* according to the resolved mode. */
export function authGuard(
  mode: AuthMode,
  auth: AuthRuntime,
  db: Database
): MiddlewareHandler<AppEnv> {
  switch (mode) {
    case "tailscale":
      return async (c, next) => {
        prunePrincipalsIfDue(db, Date.now());
        if (isTailscaleAllowed(c, auth.trustProxy, auth.trustProxyHops)) {
          const ip = clientIp(c, auth.trustProxy, auth.trustProxyHops);
          c.set(
            "principal",
            resolveAmbientPrincipal(db, "tailscale", ip, sanitizeAmbientLabel(ip))
          );
          await next();
        } else {
          return c.json({ error: "VPN access required" }, 403);
        }
      };
    case "proxy":
      return async (c, next) => {
        prunePrincipalsIfDue(db, Date.now());
        const proxyIdentity = resolveProxyIdentity(c, auth);
        if (proxyIdentity) {
          c.set(
            "principal",
            resolveAmbientPrincipal(
              db,
              "proxy",
              proxyIdentity.identity,
              proxyIdentity.label
            )
          );
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
        prunePrincipalsIfDue(db, Date.now());
        const principal = await hasValidSession(c, auth, db);
        if (principal) {
          c.set("principal", principal);
          await next();
        } else {
          return c.json(
            { error: "Authentication required", authRequired: true },
            401
          );
        }
      };
    case "none":
      return async (c, next) => {
        prunePrincipalsIfDue(db, Date.now());
        c.set(
          "principal",
          resolveAmbientPrincipal(
            db,
            "none",
            "No authentication",
            "No authentication"
          )
        );
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
  c: Context<AppEnv>,
  mode: AuthMode,
  auth: AuthRuntime,
  db: Database
): Promise<Principal | null> {
  prunePrincipalsIfDue(db, Date.now());
  switch (mode) {
    case "none":
      return resolveAmbientPrincipal(
        db,
        "none",
        "No authentication",
        "No authentication"
      );
    case "tailscale": {
      if (!isTailscaleAllowed(c, auth.trustProxy, auth.trustProxyHops)) return null;
      const ip = clientIp(c, auth.trustProxy, auth.trustProxyHops);
      return resolveAmbientPrincipal(
        db,
        "tailscale",
        ip,
        sanitizeAmbientLabel(ip)
      );
    }
    case "proxy": {
      const proxyIdentity = resolveProxyIdentity(c, auth);
      return proxyIdentity
        ? resolveAmbientPrincipal(
            db,
            "proxy",
            proxyIdentity.identity,
            proxyIdentity.label
          )
        : null;
    }
    case "password":
      return hasValidSession(c, auth, db);
  }
}

// --- password mode helpers ---

/**
 * Mint the session cookie. The single place a session comes into existence —
 * both password login and passkey login (middleware/passkeys.ts) call this, so
 * authGuard / isWsAuthorized / TTL semantics stay identical across methods.
 */
export async function issueSessionCookie(
  c: Context,
  auth: AuthRuntime,
  db: Database,
  principalId: string
): Promise<void> {
  const secret = auth.cookieSecret ?? "";
  const principal = resolvePrincipal(db, principalId);
  const now = Date.now();
  if (!principal || !isUsablePrincipal(principal, now)) {
    throw new Error(`Cannot issue a session cookie for unusable principal ${principalId}`);
  }
  const maxAge = Math.floor((principal.expiresAt - now) / 1_000);
  await setSignedCookie(c, COOKIE_NAME, principal.id, secret, {
    httpOnly: true,
    sameSite: "Strict",
    // Always Secure — every real deployment serves over HTTPS, and we do not
    // want a missing NODE_ENV to silently drop the flag and expose the cookie
    // over plaintext. (Local password testing must use https/localhost.)
    secure: true,
    path: "/",
    maxAge,
  });
}

/** Turn the client-controlled User-Agent into a short, log-safe display hint. */
export function sanitizeLoginLabel(userAgent: unknown): string {
  if (typeof userAgent !== "string") return LOGIN_LABEL_FALLBACK;
  const label = userAgent
    .replace(CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, LOGIN_LABEL_MAX_LENGTH)
    .trim();
  // A label exists to be recognised in a device list. A string with nothing
  // alphanumeric in it ("(((") is technically a User-Agent and useless as a
  // hint, so it takes the fallback rather than being shown as-is.
  if (!/[\p{L}\p{N}]/u.test(label)) return LOGIN_LABEL_FALLBACK;
  return label;
}

type LoginPrincipalLineage =
  | { authMethod: "password" }
  | { authMethod: "passkey"; credentialId: string };

/**
 * Create the durable owner principal for a verified login and issue its cookie.
 * Returns a response only when the live-principal cap refuses the login.
 */
export async function issueLoginSession(
  c: Context,
  auth: AuthRuntime,
  db: Database,
  lineage: LoginPrincipalLineage
): Promise<Response | null> {
  prunePrincipals(db, Date.now());

  try {
    const principal = createPrincipal(db, {
      kind: "owner",
      authMethod: lineage.authMethod,
      label: sanitizeLoginLabel(c.req.header("user-agent")),
      credentialId:
        lineage.authMethod === "passkey" ? lineage.credentialId : undefined,
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    await issueSessionCookie(c, auth, db, principal.id);
  } catch (err) {
    if (!(err instanceof PrincipalLimitError)) throw err;
    // 503: valid credentials reached a server-side capacity limit. This is
    // neither an authentication failure nor a request the client can repair
    // except by waiting for expiry or signing out another device.
    return c.json(
      { error: "Session capacity reached. Sign out another device and try again." },
      503
    );
  }

  return null;
}

/**
 * Resolve the principal named by a valid session cookie. Signature and payload
 * shape are checked before the principal store is queried.
 */
export async function hasValidSession(
  c: Context,
  auth: AuthRuntime,
  db: Database
): Promise<Principal | null> {
  const secret = auth.cookieSecret ?? "";
  if (!secret) return null;
  let value: string | false | undefined;
  try {
    value = await getSignedCookie(c, secret, COOKIE_NAME);
  } catch {
    return null;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) {
    return null;
  }

  // Deliberately after signature and shape verification, and outside the
  // cookie-parser catch: arbitrary ids cannot drive reads, while corrupt
  // authoritative state fails only the principal whose signed cookie names it.
  const principal = resolvePrincipal(db, value);
  const now = Date.now();
  if (!principal || !isUsablePrincipal(principal, now)) return null;
  touchLastSeen(db, principal.id, now);
  return principal;
}

/** Read the legacy downgrade epoch so {@link bumpSessionsEpoch} can advance it. */
function sessionsEpoch(db: Database): number {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(SESSIONS_EPOCH_KEY) as { value: string } | null;
  if (!row) return 0;

  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new Error(`Corrupt ${SESSIONS_EPOCH_KEY}: expected a JSON integer`);
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Corrupt ${SESSIONS_EPOCH_KEY}: expected a non-negative integer`);
  }
  return value as number;
}

/**
 * Revoke every principal, advance the legacy epoch, and disconnect every
 * attached client. This remains the sign-out-everywhere primitive in 0.35.0;
 * P5 narrows passkey deletion to revokeByCredential.
 *
 * The 0.35.0 session-principals verifier never reads this row. The write is a
 * downgrade guard so rolling back to v1 does not revive pre-upgrade cookies;
 * delete this compatibility helper and the epoch row in the 0.36.0 release.
 */
export function applyPrincipalRevocation(
  revoker: Pick<WsHost, "revokePrincipals">,
  principalIds: readonly string[]
): void {
  revoker.revokePrincipals(
    principalIds,
    SESSION_REVOKED_CLOSE_CODE,
    SESSION_REVOKED_CLOSE_REASON
  );
}

export function bumpSessionsEpoch(
  db: Database,
  revoker: Pick<WsHost, "revokePrincipals">
): number {
  const current = sessionsEpoch(db);
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new Error(`${SESSIONS_EPOCH_KEY} cannot be advanced safely`);
  }
  const next = current + 1;
  const revokedIds = revokeAllPrincipals(db, Date.now());
  applyPrincipalRevocation(revoker, revokedIds);
  setSetting(db, SESSIONS_EPOCH_KEY, next);
  return next;
}

// --- proxy mode helpers ---

const AMBIENT_LABEL_MAX_LENGTH = 64;

function sanitizeAmbientLabel(identity: string): string {
  return identity
    .replace(CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, AMBIENT_LABEL_MAX_LENGTH);
}

function resolveProxyIdentity(
  c: Context,
  auth: AuthRuntime
): { identity: string; label: string } | null {
  // The proxy-auth header is only meaningful when a trusted proxy fronts the app
  // and TRUST_PROXY says so; otherwise a client could set it directly. Gate on
  // trustProxy, consistent with tailscale-mode XFF trust. (assertAuthConfig
  // already refuses to boot proxy mode without it — this is belt-and-braces.)
  if (!auth.trustProxy) return null;
  const user = c.req.header(auth.proxyAuthHeader);
  if (!user || user.trim().length === 0) return null;
  return { identity: user, label: sanitizeAmbientLabel(user) };
}

// --- login rate limiter (in-memory failure windows + verification reservations) ---

interface Bucket {
  failures: number;
  resetAt: number;
}
const loginBuckets = new Map<string, Bucket>();

interface InFlightBucket {
  count: number;
  expiresAt: number;
}

interface VerificationReservations {
  acquire(ip: string): boolean;
  release(ip: string): void;
  reset(): void;
}

function pruneExpiredBuckets(now: number): void {
  for (const [key, bucket] of loginBuckets) {
    if (now >= bucket.resetAt) loginBuckets.delete(key);
  }
}

function makeBucketRoom(): void {
  while (loginBuckets.size >= LOGIN_BUCKET_CAP) {
    // Keep the global password bucket authoritative. The cap is larger than
    // its maximum number of per-IP contributors in one window, so ordinary
    // password traffic never needs to evict an active per-IP failure record.
    const oldest = [...loginBuckets.keys()].find(
      (key) => key !== PASSWORD_GLOBAL_BUCKET
    );
    if (oldest === undefined) break;
    loginBuckets.delete(oldest);
  }
}

function bucketForWrite(key: string, now: number): Bucket {
  pruneExpiredBuckets(now);
  const existing = loginBuckets.get(key);
  if (existing) return existing;
  makeBucketRoom();
  const bucket = { failures: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
  loginBuckets.set(key, bucket);
  return bucket;
}

/** Record one genuine authentication failure in a fixed one-minute window. */
export function recordLoginFailure(key: string, limit: number): void {
  const bucket = bucketForWrite(key, Date.now());
  // Saturate: callers only care whether the limit was reached, and this avoids
  // an unbounded counter if a test or future caller records after blocking.
  bucket.failures = Math.min(limit, bucket.failures + 1);
}

/** Read without allocating: junk requests cannot grow the failure map. */
export function isLoginBlocked(key: string, limit: number): boolean {
  const now = Date.now();
  const bucket = loginBuckets.get(key);
  if (!bucket) return false;
  if (now >= bucket.resetAt) {
    loginBuckets.delete(key);
    return false;
  }
  return bucket.failures >= limit;
}

function createVerificationReservations(
  perIpLimit: number,
  globalLimit: number
): VerificationReservations {
  const buckets = new Map<string, InFlightBucket>();
  let totalInFlight = 0;

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.count === 0 && now >= bucket.expiresAt) buckets.delete(key);
    }
  }

  return {
    acquire(ip) {
      const now = Date.now();
      prune(now);
      if (totalInFlight >= globalLimit) return false;

      let bucket = buckets.get(ip);
      if (bucket && bucket.count >= perIpLimit) return false;
      if (!bucket) {
        while (buckets.size >= LOGIN_BUCKET_CAP) {
          const idle = [...buckets].find(([, entry]) => entry.count === 0);
          if (!idle) return false;
          buckets.delete(idle[0]);
        }
        bucket = { count: 0, expiresAt: now + LOGIN_RATE_WINDOW_MS };
        buckets.set(ip, bucket);
      }
      bucket.count++;
      bucket.expiresAt = now + LOGIN_RATE_WINDOW_MS;
      totalInFlight++;
      return true;
    },
    release(ip) {
      const bucket = buckets.get(ip);
      if (!bucket || bucket.count === 0) return;
      bucket.count--;
      bucket.expiresAt = Date.now() + LOGIN_RATE_WINDOW_MS;
      totalInFlight--;
    },
    reset() {
      buckets.clear();
      totalInFlight = 0;
    },
  };
}

const passwordVerifications = createVerificationReservations(
  PASSWORD_VERIFY_IN_FLIGHT_PER_IP,
  PASSWORD_VERIFY_IN_FLIGHT_GLOBAL
);
const passkeyVerifications = createVerificationReservations(
  PASSKEY_VERIFY_IN_FLIGHT_PER_IP,
  PASSKEY_VERIFY_IN_FLIGHT_GLOBAL
);

function acquirePasswordVerification(ip: string): boolean {
  return passwordVerifications.acquire(ip);
}

function releasePasswordVerification(ip: string): void {
  passwordVerifications.release(ip);
}

/** Internal middleware coordination; not exported from the package root. */
export function acquirePasskeyVerification(ip: string): boolean {
  return passkeyVerifications.acquire(ip);
}

/** Internal middleware coordination; not exported from the package root. */
export function releasePasskeyVerification(ip: string): void {
  passkeyVerifications.release(ip);
}

/** Test-only: clear all rate-limit buckets (they are module-global state). */
export function resetLoginRateLimiter(): void {
  loginBuckets.clear();
  passwordVerifications.reset();
  passkeyVerifications.reset();
}

/** Attempt-counting bucket retained for passkey option generation. */
export function consumeLoginToken(key: string, limit: number): boolean {
  if (isLoginBlocked(key, limit)) return false;
  recordLoginFailure(key, limit);
  return true;
}

/** Login/logout routes. Only functional in `password` mode. */
export function authRoutes(
  mode: AuthMode,
  auth: AuthRuntime,
  deps: {
    /** Authoritative session state. */
    db: Database;
    /** Runtime authorities invalidated whenever durable principals are revoked. */
    clients: Pick<WsHost, "revokePrincipals">;
    /**
     * When provided and returning true, password login is refused (the app
     * injects passkeys' passwordLoginDisabled so the shared password dies
     * once a passkey exists for the RP). Injected to keep this module free
     * of WebAuthn concerns.
     */
    passwordDisabled?: (c: Context) => boolean;
    /** Where login outcomes are reported; absent means silence. */
    log?: Logger;
    /** Failed-login counter — the same `auth.failures` instrument passkeys use. */
    failures?: Counter;
    /** Test-only password verifier; production uses Bun.password.verify. */
    verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  }
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { log, failures } = deps;
  const verifyPassword = deps.verifyPassword ?? Bun.password.verify;
  let warnedUntrustedForwardedFor = false;

  app.post("/auth/login", requireJson(), async (c) => {
    if (mode !== "password") {
      return c.json({ error: "Password login is not enabled" }, 400);
    }

    if (
      !auth.trustProxy &&
      !warnedUntrustedForwardedFor &&
      c.req.header("x-forwarded-for")
    ) {
      warnedUntrustedForwardedFor = true;
      log?.emit({
        severityText: "WARN",
        body: "X-Forwarded-For ignored in password mode",
        attributes: { "auth.mode": "password", "auth.trust_proxy": false },
      });
    }

    const key = clientIp(c, auth.trustProxy, auth.trustProxyHops) || "unknown";
    const perIpBucket = `${PASSWORD_IP_BUCKET_PREFIX}${key}`;

    if (deps.passwordDisabled?.(c)) {
      return c.json(
        { error: "Password login is disabled — sign in with a passkey." },
        403
      );
    }

    // Refuse a blocked client before reading its body: admission control is
    // cheapest when it costs no parsing.
    const perIpBlocked = isLoginBlocked(perIpBucket, LOGIN_RATE_LIMIT);
    const globalBlocked = isLoginBlocked(
      PASSWORD_GLOBAL_BUCKET,
      GLOBAL_LOGIN_RATE_LIMIT
    );
    if (perIpBlocked || globalBlocked) {
      failures?.add(1, { reason: "rate_limited", method: "password" });
      log?.emit({
        severityText: "WARN",
        body: "login rate limited",
        attributes: { ip: key, limit: perIpBlocked ? "ip" : "global" },
      });
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    }

    const hash = auth.passwordHash ?? "";
    const secret = auth.cookieSecret ?? "";
    let body: { password?: unknown };
    try {
      const result = await readJsonBody<{ password?: unknown }>(c);
      if (result instanceof Response) return result;
      body = result;
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !hash || !secret) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    if (!acquirePasswordVerification(key)) {
      failures?.add(1, { reason: "in_flight_limited", method: "password" });
      log?.emit({
        severityText: "WARN",
        body: "password verification capacity reached",
        attributes: { ip: key },
      });
      return c.json({ error: "Too many login verifications in progress." }, 429);
    }

    // A verify that THROWS is not a wrong password — it is a hash Bun cannot
    // parse (a corrupt BRAIN_UI_PASSWORD_HASH locks the owner out of every
    // login), and collapsing it into "invalid credentials" hid exactly that.
    let ok = false;
    let verifyError: unknown = null;
    try {
      ok = await verifyPassword(password, hash);
    } catch (err) {
      verifyError = err;
    } finally {
      releasePasswordVerification(key);
    }
    if (verifyError) {
      failures?.add(1, { reason: "verify_error", method: "password" });
      log?.emit({
        severityText: "ERROR",
        body: "password verification errored — check BRAIN_UI_PASSWORD_HASH",
        attributes: {
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        },
      });
      return c.json({ error: "Invalid credentials" }, 401);
    }
    if (!ok) {
      recordLoginFailure(perIpBucket, LOGIN_RATE_LIMIT);
      recordLoginFailure(PASSWORD_GLOBAL_BUCKET, GLOBAL_LOGIN_RATE_LIMIT);
      failures?.add(1, { reason: "invalid_password", method: "password" });
      log?.emit({
        severityText: "WARN",
        body: "login failed",
        attributes: { ip: key },
      });
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const capacityResponse = await issueLoginSession(c, auth, deps.db, {
      authMethod: "password",
    });
    if (capacityResponse) return capacityResponse;
    log?.emit({
      severityText: "INFO",
      body: "login succeeded",
      attributes: { ip: key },
    });
    return c.json({ ok: true });
  });

  app.post("/auth/logout", async (c) => {
    if (mode === "password") {
      const principal = await hasValidSession(c, auth, deps.db);
      if (!principal) {
        return c.json({ error: "Authentication required", authRequired: true }, 401);
      }
      c.set("principal", principal);
      bumpSessionsEpoch(deps.db, deps.clients);
    }
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
