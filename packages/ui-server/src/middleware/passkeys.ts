import { Hono } from "hono";
import type { Context } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse as realVerifyAuthentication,
  verifyRegistrationResponse as realVerifyRegistration,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  type AuthMode,
  issueSessionCookie,
  consumeLoginToken,
  LOGIN_RATE_LIMIT,
  GLOBAL_LOGIN_RATE_LIMIT,
} from "./auth.js";
import { clientIp } from "./tailscale.js";
import { getDb } from "../db/client.js";

/**
 * WebAuthn passkeys as an extension of `password` mode: the password bootstraps
 * the first registration (and stays as recovery), passkeys are the day-to-day
 * login. A successful assertion mints the same session cookie as password login
 * (issueSessionCookie), so authGuard / isWsAuthorized / TTL are untouched.
 *
 * Self-contained on purpose — this module (plus its auth.ts imports) is slated
 * to move wholesale into @schlessera/ui-server.
 *
 * Credentials are RP-scoped: a credential registered on localhost does not
 * exist for the production domain and vice versa. Rows carry rp_id so all
 * environments share the table.
 */

const CHALLENGE_TTL_MS = 120_000; // > the 60s ceremony timeout
// Pending challenges are unauthenticated state; cap and evict oldest-first so
// login-options spam can't grow memory. Losing one costs a retried ceremony.
const MAX_PENDING_CHALLENGES = 100;
const OPTIONS_RATE_LIMIT = 10; // login-options per IP per minute (own bucket)
// Branding/identity are config-injected with the historical values as
// defaults, so existing deployments keep their credentials.
function rpName(): string {
  return process.env.WEBAUTHN_RP_NAME || "Brain UI";
}
// The single "user" every passkey belongs to. Stable across registrations so
// an authenticator overwrites its existing entry instead of stacking
// duplicates for the same site.
//
// WARNING: the user handle is part of the WebAuthn wire contract — it is
// burned into every resident credential at registration. Changing
// WEBAUTHN_USER_ID on a deployment that already has passkeys orphans them
// (authenticators will present a handle the server no longer recognizes as
// the same user and re-registration stacks a second entry). Set it before the
// first passkey is registered and never change it.
function userName(): string {
  return process.env.WEBAUTHN_USER_NAME || "owner";
}
/** WebAuthn caps `user.id` at 64 bytes; browsers reject anything longer. */
const MAX_USER_ID_BYTES = 64;

function userId(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    process.env.WEBAUTHN_USER_ID || "brain-ui-owner"
  ) as Uint8Array<ArrayBuffer>;
}

/**
 * Refuse to boot on a WebAuthn user handle the browser would reject. Called
 * from createApp(): an oversized handle otherwise produces registration
 * options that look fine server-side and fail silently in every browser.
 */
export function assertPasskeyConfig(): void {
  const bytes = userId().byteLength;
  if (bytes > MAX_USER_ID_BYTES) {
    throw new Error(
      `WEBAUTHN_USER_ID is ${bytes} bytes; WebAuthn allows at most ${MAX_USER_ID_BYTES}. ` +
        "Pick a shorter stable identifier (it is burned into every credential)."
    );
  }
}
// ES256 + RS256 only: every mainstream authenticator supports ES256, and it
// keeps Ed25519 (whose WebCrypto verify path on Bun is unproven) out of the
// database. Widen once Bun's Ed25519 verify is validated.
const SUPPORTED_ALGORITHM_IDS = [-7, -257];

type ChallengeType = "registration" | "authentication";

/** Injectable seams for tests; production callers pass nothing. */
export interface PasskeyDeps {
  verifyRegistrationResponse?: typeof realVerifyRegistration;
  verifyAuthenticationResponse?: typeof realVerifyAuthentication;
  now?: () => number;
}

// --- challenge store (in-memory: single-process server; move to a shared
// store if this ever runs multi-process) ---

const pendingChallenges = new Map<string, { type: ChallengeType; expiresAt: number }>();

function putChallenge(challenge: string, type: ChallengeType, now: number): void {
  for (const [key, entry] of pendingChallenges) {
    if (entry.expiresAt <= now) pendingChallenges.delete(key);
  }
  while (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
    const oldest = pendingChallenges.keys().next().value;
    if (oldest === undefined) break;
    pendingChallenges.delete(oldest);
  }
  pendingChallenges.set(challenge, { type, expiresAt: now + CHALLENGE_TTL_MS });
}

/** Single-use: deleted before verification, so a failed verify still burns it. */
function consumeChallenge(challenge: string, type: ChallengeType, now: number): boolean {
  const entry = pendingChallenges.get(challenge);
  if (!entry) return false;
  pendingChallenges.delete(challenge);
  return entry.type === type && entry.expiresAt > now;
}

/** The challenge the browser actually signed, from clientDataJSON. */
function challengeFromResponse(response: {
  response: { clientDataJSON: string };
}): string | null {
  try {
    const json = JSON.parse(
      Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")
    ) as { challenge?: unknown };
    return typeof json.challenge === "string" ? json.challenge : null;
  } catch {
    return null;
  }
}

// --- RP / origin resolution ---

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Derive the relying party from the request instead of demanding new env:
 * same-origin deployments, split topology (ALLOWED_ORIGINS), and dev all work
 * unconfigured. WEBAUTHN_ORIGINS / WEBAUTHN_RP_ID remain as overrides for
 * proxies that rewrite Host.
 */
function resolveRp(c: Context): { rpID: string; origin: string } | null {
  const origin = c.req.header("origin");
  if (!origin) return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  const allowed =
    envList("WEBAUTHN_ORIGINS").includes(origin) ||
    envList("ALLOWED_ORIGINS").includes(origin) ||
    url.host === c.req.header("host") ||
    // Dev escape hatch: the vite proxy sets changeOrigin, so the server sees
    // Host localhost:3000 but Origin http://localhost:5173. Opt-in via an
    // explicit flag — NOT NODE_ENV, whose absence must never widen the RP.
    (process.env.BRAIN_UI_ALLOW_LOOPBACK_ORIGIN === "1" &&
      isLoopbackHostname(url.hostname));
  if (!allowed) return null;

  return { rpID: process.env.WEBAUTHN_RP_ID ?? url.hostname, origin };
}

/** rpID for endpoints where same-origin GETs legitimately omit Origin. */
function rpIdForRead(c: Context): string {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
  const origin = c.req.header("origin");
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      // fall through to Host
    }
  }
  const host = c.req.header("host") ?? "localhost";
  return host.replace(/:\d+$/, "");
}

// --- persistence ---

interface CredentialRow {
  id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  rp_id: string;
  aaguid: string | null;
  device_type: string | null;
  backed_up: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

/** Wire shape shared with the client (shared/protocol.ts PasskeySummary). */
function toSummary(row: CredentialRow) {
  return {
    id: row.id,
    label: row.label,
    rpId: row.rp_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    backedUp: row.backed_up === 1,
    deviceType: row.device_type,
    transports: row.transports ? (JSON.parse(row.transports) as string[]) : null,
    aaguid: row.aaguid,
  };
}

function credentialsForRp(rpID: string): CredentialRow[] {
  return getDb()
    .query("SELECT * FROM passkey_credentials WHERE rp_id = ?")
    .all(rpID) as CredentialRow[];
}

function credentialById(id: string): CredentialRow | null {
  return getDb()
    .query("SELECT * FROM passkey_credentials WHERE id = ?")
    .get(id) as CredentialRow | null;
}

function toWebAuthnCredential(row: CredentialRow): WebAuthnCredential {
  return {
    id: row.id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: row.transports
      ? (JSON.parse(row.transports) as WebAuthnCredential["transports"])
      : undefined,
  };
}

function sanitizeLabel(label: unknown): string {
  return typeof label === "string" ? label.trim().slice(0, 64) : "";
}

function notEnabled(c: Context) {
  return c.json({ error: "Passkey login is not enabled" }, 400);
}

/**
 * Once a passkey exists for the request's RP, password login is disabled —
 * the password becomes registration-bootstrap and break-glass recovery only
 * (set BRAIN_UI_ALLOW_PASSWORD=1 to re-enable it, e.g. after losing every
 * authenticator). Scoped per RP so e.g. localhost dev keeps password login
 * until it has its own credential. Host-derived rpID is fine here: a forged
 * Host can at most re-enable password auth, which still requires the password.
 */
export function passwordLoginDisabled(c: Context): boolean {
  if (process.env.BRAIN_UI_ALLOW_PASSWORD === "1") return false;
  const row = getDb()
    .query("SELECT COUNT(*) AS n FROM passkey_credentials WHERE rp_id = ?")
    .get(rpIdForRead(c)) as { n: number };
  return row.n > 0;
}

/**
 * Unauthenticated passkey routes. Mount BEFORE the auth guard, next to
 * authRoutes.
 */
export function passkeyPublicRoutes(mode: AuthMode, deps: PasskeyDeps = {}): Hono {
  const verifyAuthentication = deps.verifyAuthenticationResponse ?? realVerifyAuthentication;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  // Capability hint for the login screen: which methods can it offer?
  app.get("/auth/methods", (c) => {
    c.header("Cache-Control", "no-store");
    if (mode !== "password") {
      return c.json({ password: false, passkey: false });
    }
    const row = getDb()
      .query("SELECT COUNT(*) AS n FROM passkey_credentials WHERE rp_id = ?")
      .get(rpIdForRead(c)) as { n: number };
    return c.json({ password: !passwordLoginDisabled(c), passkey: row.n > 0 });
  });

  app.post("/auth/passkey/login-options", async (c) => {
    if (mode !== "password") return notEnabled(c);
    const ip = clientIp(c, process.env.TRUST_PROXY === "1") || "unknown";
    // Own bucket: conditional-UI mounts fire this on every login-screen load
    // and must not starve real verify attempts of their shared budget.
    if (!consumeLoginToken(`pk-opt:${ip}`, OPTIONS_RATE_LIMIT)) {
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    }
    const rp = resolveRp(c);
    if (!rp) return c.json({ error: "Origin not allowed" }, 400);

    // Empty allowCredentials + discoverable credentials = usernameless login.
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: [],
      userVerification: "required",
    });
    putChallenge(options.challenge, "authentication", now());
    return c.json(options);
  });

  app.post("/auth/passkey/login-verify", async (c) => {
    if (mode !== "password") return notEnabled(c);
    const ip = clientIp(c, process.env.TRUST_PROXY === "1") || "unknown";
    // Same buckets as password login: one combined online-guess budget.
    const perIpOk = consumeLoginToken(`ip:${ip}`, LOGIN_RATE_LIMIT);
    const globalOk = consumeLoginToken("global", GLOBAL_LOGIN_RATE_LIMIT);
    if (!perIpOk || !globalOk) {
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    }
    const rp = resolveRp(c);
    if (!rp) return c.json({ error: "Origin not allowed" }, 400);

    let response: AuthenticationResponseJSON;
    try {
      response = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const fail = () => c.json({ error: "Passkey verification failed" }, 401);

    const row = typeof response?.id === "string" ? credentialById(response.id) : null;
    if (!row || row.rp_id !== rp.rpID) return fail();

    const challenge = challengeFromResponse(response);
    if (!challenge || !consumeChallenge(challenge, "authentication", now())) {
      return fail();
    }

    try {
      const result = await verifyAuthentication({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: toWebAuthnCredential(row),
      });
      if (!result.verified) return fail();
      getDb()
        .prepare(
          "UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?"
        )
        .run(result.authenticationInfo.newCounter, now(), row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The library throws on a counter regression — possible cloned
      // credential. Cloud passkeys legitimately sit at 0, so warn, don't
      // revoke.
      if (/counter/i.test(message)) {
        console.warn(
          `[passkeys] counter regression for credential ${row.id} — possible cloned credential`
        );
      } else {
        console.warn(`[passkeys] authentication failed: ${message}`);
      }
      return fail();
    }

    await issueSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Session-gated passkey routes. Mount AFTER the auth guard — gating comes from
 * mount position, not per-route checks.
 */
export function passkeyManagementRoutes(mode: AuthMode, deps: PasskeyDeps = {}): Hono {
  const verifyRegistration = deps.verifyRegistrationResponse ?? realVerifyRegistration;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.post("/auth/passkey/register-options", async (c) => {
    if (mode !== "password") return notEnabled(c);
    const rp = resolveRp(c);
    if (!rp) return c.json({ error: "Origin not allowed" }, 400);

    const options = await generateRegistrationOptions({
      rpName: rpName(),
      rpID: rp.rpID,
      userName: userName(),
      userID: userId(),
      userDisplayName: rpName(),
      attestationType: "none",
      excludeCredentials: credentialsForRp(rp.rpID).map((row) => ({
        id: row.id,
        transports: toWebAuthnCredential(row).transports,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
    putChallenge(options.challenge, "registration", now());
    return c.json(options);
  });

  app.post("/auth/passkey/register-verify", async (c) => {
    if (mode !== "password") return notEnabled(c);
    const rp = resolveRp(c);
    if (!rp) return c.json({ error: "Origin not allowed" }, 400);

    let body: { response?: RegistrationResponseJSON; label?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    if (!body.response) return c.json({ error: "Invalid request body" }, 400);

    const challenge = challengeFromResponse(body.response);
    if (!challenge || !consumeChallenge(challenge, "registration", now())) {
      return c.json({ error: "Passkey registration failed" }, 400);
    }

    try {
      const result = await verifyRegistration({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
      });
      if (!result.verified || !result.registrationInfo) {
        return c.json({ error: "Passkey registration failed" }, 400);
      }
      const { credential, aaguid, credentialDeviceType, credentialBackedUp } =
        result.registrationInfo;
      const createdAt = now();
      getDb()
        .prepare(
          `INSERT INTO passkey_credentials
             (id, public_key, counter, transports, rp_id, aaguid, device_type,
              backed_up, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          credential.id,
          credential.publicKey,
          credential.counter,
          credential.transports ? JSON.stringify(credential.transports) : null,
          rp.rpID,
          aaguid || null,
          credentialDeviceType,
          credentialBackedUp ? 1 : 0,
          sanitizeLabel(body.label),
          createdAt
        );
      const row = credentialById(credential.id);
      return c.json({ ok: true, credential: row ? toSummary(row) : null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[passkeys] registration failed: ${message}`);
      return c.json({ error: "Passkey registration failed" }, 400);
    }
  });

  // All rows, not rpID-filtered: the prod panel must be able to show and
  // delete stale localhost/dev credentials. The client badges foreign RPs.
  app.get("/auth/passkey/list", (c) => {
    if (mode !== "password") return notEnabled(c);
    const rows = getDb()
      .query("SELECT * FROM passkey_credentials ORDER BY created_at DESC")
      .all() as CredentialRow[];
    return c.json({ credentials: rows.map(toSummary) });
  });

  app.put("/auth/passkey/:id", async (c) => {
    if (mode !== "password") return notEnabled(c);
    let body: { label?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const result = getDb()
      .prepare("UPDATE passkey_credentials SET label = ? WHERE id = ?")
      .run(sanitizeLabel(body.label), c.req.param("id"));
    if (result.changes === 0) return c.json({ error: "Unknown passkey" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/auth/passkey/:id", (c) => {
    if (mode !== "password") return notEnabled(c);
    const result = getDb()
      .prepare("DELETE FROM passkey_credentials WHERE id = ?")
      .run(c.req.param("id"));
    if (result.changes === 0) return c.json({ error: "Unknown passkey" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
