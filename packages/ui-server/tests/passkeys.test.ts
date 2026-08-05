import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { authRoutes, authGuard, resetLoginRateLimiter } from "../src/middleware/auth";
import {
  passkeyPublicRoutes,
  passkeyManagementRoutes,
  passwordLoginDisabled,
  type PasskeyDeps,
} from "../src/middleware/passkeys";
import { getDb, closeDb } from "../src/db/client";

const PASSWORD = "correct horse battery staple";
let HASH = "";
const SECRET = "test-cookie-secret-0123456789abcdef";
const TEST_DB = join(tmpdir(), `passkeys-test-${process.pid}.db`);

const ENV_KEYS = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "NODE_ENV",
  "HOST",
  "TRUST_PROXY",
  "ALLOWED_ORIGINS",
  "WEBAUTHN_ORIGINS",
  "WEBAUTHN_RP_ID",
  "BRAIN_UI_ALLOW_PASSWORD",
  "BRAIN_UI_ALLOW_LOOPBACK_ORIGIN",
  "DB_PATH",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  HASH = await Bun.password.hash(PASSWORD);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  closeDb();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DB_PATH = TEST_DB;
  process.env.BRAIN_UI_PASSWORD_HASH = HASH;
  process.env.COOKIE_SECRET = SECRET;
  process.env.TRUST_PROXY = "1";
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(TEST_DB + suffix, { force: true });
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  resetLoginRateLimiter();
  getDb().exec("DELETE FROM passkey_credentials");
});

// Mirrors the app.ts mount order: public routes before the guard, management
// routes after it.
function fullApp(deps: PasskeyDeps = {}) {
  const app = new Hono();
  app.route("/api", authRoutes("password", { passwordDisabled: passwordLoginDisabled }));
  app.route("/api", passkeyPublicRoutes("password", deps));
  app.use("/api/*", authGuard("password"));
  app.route("/api", passkeyManagementRoutes("password", deps));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  return app;
}

const ORIGIN = "https://example.test";
const HOST = "example.test";
const RP_ID = "example.test";

function headers(extra: Record<string, string> = {}, ip = "10.0.0.1") {
  return {
    "content-type": "application/json",
    origin: ORIGIN,
    host: HOST,
    "x-forwarded-for": ip,
    ...extra,
  };
}

async function loginCookie(app: Hono, ip = "10.0.0.99"): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: headers({}, ip),
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

function seedCredential(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: "cred-1",
    public_key: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: JSON.stringify(["internal"]),
    rp_id: RP_ID,
    aaguid: "aaguid-1",
    device_type: "multiDevice",
    backed_up: 1,
    label: "Test key",
    created_at: 1000,
    last_used_at: null,
    ...overrides,
  };
  getDb()
    .prepare(
      `INSERT INTO passkey_credentials
         (id, public_key, counter, transports, rp_id, aaguid, device_type,
          backed_up, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id as string,
      row.public_key as Uint8Array,
      row.counter as number,
      row.transports as string,
      row.rp_id as string,
      row.aaguid as string,
      row.device_type as string,
      row.backed_up as number,
      row.label as string,
      row.created_at as number,
      row.last_used_at as number | null
    );
  return row;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function assertionResponse(challenge: string, id = "cred-1") {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(JSON.stringify({ type: "webauthn.get", challenge })),
      authenticatorData: "",
      signature: "",
    },
  };
}

function registrationResponse(challenge: string, id = "cred-new") {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(JSON.stringify({ type: "webauthn.create", challenge })),
      attestationObject: "",
    },
  };
}

async function freshLoginChallenge(app: Hono, ip = "10.1.0.1"): Promise<string> {
  const res = await app.request("/api/auth/passkey/login-options", {
    method: "POST",
    headers: headers({}, ip),
    body: "{}",
  });
  expect(res.status).toBe(200);
  return (await res.json()).challenge as string;
}

const verifiedAuth = (newCounter = 7) =>
  (async () => ({
    verified: true,
    authenticationInfo: { newCounter },
  })) as unknown as NonNullable<PasskeyDeps["verifyAuthenticationResponse"]>;

const verifiedRegistration = (id = "cred-new") =>
  (async () => ({
    verified: true,
    registrationInfo: {
      aaguid: "aaguid-new",
      credential: {
        id,
        publicKey: new Uint8Array([9, 9, 9]),
        counter: 0,
        transports: ["hybrid"],
      },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  })) as unknown as NonNullable<PasskeyDeps["verifyRegistrationResponse"]>;

describe("mode gating", () => {
  test("non-password mode rejects every passkey route", async () => {
    const app = new Hono();
    app.route("/api", passkeyPublicRoutes("tailscale"));
    app.route("/api", passkeyManagementRoutes("tailscale"));

    const methods = await app.request("/api/auth/methods", { headers: headers() });
    expect(await methods.json()).toEqual({ password: false, passkey: false });

    for (const [path, method] of [
      ["/api/auth/passkey/login-options", "POST"],
      ["/api/auth/passkey/login-verify", "POST"],
      ["/api/auth/passkey/register-options", "POST"],
      ["/api/auth/passkey/register-verify", "POST"],
      ["/api/auth/passkey/list", "GET"],
      ["/api/auth/passkey/some-id", "DELETE"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: headers(),
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("/auth/methods", () => {
  test("reports passkey availability per RP", async () => {
    const app = fullApp();
    let res = await app.request("/api/auth/methods", { headers: headers() });
    expect(await res.json()).toEqual({ password: true, passkey: false });

    // A registered passkey also turns password login off (auto-disable).
    seedCredential();
    res = await app.request("/api/auth/methods", { headers: headers() });
    expect(await res.json()).toEqual({ password: false, passkey: true });
  });

  test("a foreign-RP credential does not enable passkeys", async () => {
    seedCredential({ rp_id: "other.test" });
    const res = await fullApp().request("/api/auth/methods", { headers: headers() });
    expect(await res.json()).toEqual({ password: true, passkey: false });
  });

  test("falls back to Host when Origin is absent (same-origin GET)", async () => {
    seedCredential();
    const res = await fullApp().request("/api/auth/methods", {
      headers: { host: `${HOST}:3000` },
    });
    expect(await res.json()).toEqual({ password: false, passkey: true });
  });
});

describe("origin / RP resolution", () => {
  test("same-origin request is allowed", async () => {
    const res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: headers({}, "10.2.0.1"),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const options = await res.json();
    expect(options.rpId).toBe(RP_ID);
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe("required");
    expect(typeof options.challenge).toBe("string");
  });

  test("cross-origin is rejected unless allowlisted", async () => {
    const cross = headers({ origin: "https://evil.test" }, "10.2.0.2");
    let res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: cross,
      body: "{}",
    });
    expect(res.status).toBe(400);

    process.env.ALLOWED_ORIGINS = "https://evil.test";
    res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: headers({ origin: "https://evil.test" }, "10.2.0.3"),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rpId).toBe("evil.test");
    delete process.env.ALLOWED_ORIGINS;
  });

  test("WEBAUTHN_ORIGINS + WEBAUTHN_RP_ID overrides apply", async () => {
    process.env.WEBAUTHN_ORIGINS = "https://alias.test";
    process.env.WEBAUTHN_RP_ID = "canonical.test";
    const res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: headers({ origin: "https://alias.test" }, "10.2.0.4"),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rpId).toBe("canonical.test");
    delete process.env.WEBAUTHN_ORIGINS;
    delete process.env.WEBAUTHN_RP_ID;
  });

  test("localhost escape hatch requires the explicit opt-in flag", async () => {
    // Vite-proxy shape: Origin localhost:5173, Host localhost:3000.
    const devHeaders = (ip: string) =>
      headers({ origin: "http://localhost:5173", host: "localhost:3000" }, ip);

    // Without the flag the mismatched loopback origin is refused — NODE_ENV
    // must play no role in RP resolution.
    let res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: devHeaders("10.2.0.5"),
      body: "{}",
    });
    expect(res.status).toBe(400);

    process.env.BRAIN_UI_ALLOW_LOOPBACK_ORIGIN = "1";
    res = await fullApp().request("/api/auth/passkey/login-options", {
      method: "POST",
      headers: devHeaders("10.2.0.6"),
      body: "{}",
    });
    expect(res.status).toBe(200);
    delete process.env.BRAIN_UI_ALLOW_LOOPBACK_ORIGIN;
  });
});

describe("login-verify", () => {
  test("valid assertion sets the session cookie and updates the credential", async () => {
    const app = fullApp({ verifyAuthenticationResponse: verifiedAuth(7), now: () => 5000 });
    seedCredential();
    const challenge = await freshLoginChallenge(app, "10.3.0.1");

    const res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.0.2"),
      body: JSON.stringify(assertionResponse(challenge)),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("brain_ui_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("secure");
    expect(setCookie.toLowerCase()).toContain("samesite=strict");

    const cookie = setCookie.split(";")[0];
    const guarded = await app.request("/api/secret", { headers: { cookie } });
    expect(guarded.status).toBe(200);

    const row = getDb()
      .query("SELECT counter, last_used_at FROM passkey_credentials WHERE id = 'cred-1'")
      .get() as { counter: number; last_used_at: number };
    expect(row.counter).toBe(7);
    expect(row.last_used_at).toBe(5000);
  });

  test("unknown credential and foreign-RP credential are rejected", async () => {
    const app = fullApp({ verifyAuthenticationResponse: verifiedAuth() });
    const challenge = await freshLoginChallenge(app, "10.3.1.1");
    let res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.1.2"),
      body: JSON.stringify(assertionResponse(challenge, "nope")),
    });
    expect(res.status).toBe(401);

    seedCredential({ rp_id: "other.test" });
    const challenge2 = await freshLoginChallenge(app, "10.3.1.3");
    res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.1.4"),
      body: JSON.stringify(assertionResponse(challenge2)),
    });
    expect(res.status).toBe(401);
  });

  test("challenges are single-use, typed, and expire", async () => {
    const app = fullApp({ verifyAuthenticationResponse: verifiedAuth() });
    seedCredential();

    // Replay: first use succeeds, second is rejected.
    const challenge = await freshLoginChallenge(app, "10.3.2.1");
    const attempt = (ip: string) =>
      app.request("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: headers({}, ip),
        body: JSON.stringify(assertionResponse(challenge)),
      });
    expect((await attempt("10.3.2.2")).status).toBe(200);
    expect((await attempt("10.3.2.3")).status).toBe(401);

    // Unknown challenge.
    const unknown = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.2.4"),
      body: JSON.stringify(assertionResponse(b64url("made-up"))),
    });
    expect(unknown.status).toBe(401);
  });

  test("an expired challenge is rejected", async () => {
    let clock = 0;
    const app = fullApp({
      verifyAuthenticationResponse: verifiedAuth(),
      now: () => clock,
    });
    seedCredential();
    const challenge = await freshLoginChallenge(app, "10.3.3.1");
    clock = 120_001; // past CHALLENGE_TTL_MS
    const res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.3.2"),
      body: JSON.stringify(assertionResponse(challenge)),
    });
    expect(res.status).toBe(401);
  });

  test("a registration challenge cannot be replayed into login", async () => {
    const app = fullApp({
      verifyAuthenticationResponse: verifiedAuth(),
      verifyRegistrationResponse: verifiedRegistration(),
    });
    // Cookie before seeding: once a credential exists, password login is off.
    const cookie = await loginCookie(app, "10.3.4.1");
    seedCredential();
    const optRes = await app.request("/api/auth/passkey/register-options", {
      method: "POST",
      headers: headers({ cookie }, "10.3.4.2"),
      body: "{}",
    });
    const regChallenge = (await optRes.json()).challenge as string;

    const res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.4.3"),
      body: JSON.stringify(assertionResponse(regChallenge)),
    });
    expect(res.status).toBe(401);
  });

  test("failed or throwing verification yields 401 without a cookie", async () => {
    const notVerified = (async () => ({
      verified: false,
    })) as unknown as NonNullable<PasskeyDeps["verifyAuthenticationResponse"]>;
    let app = fullApp({ verifyAuthenticationResponse: notVerified });
    seedCredential();
    let challenge = await freshLoginChallenge(app, "10.3.5.1");
    let res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.5.2"),
      body: JSON.stringify(assertionResponse(challenge)),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();

    const throwing = (async () => {
      throw new Error("Response counter value 1 was lower than expected 5");
    }) as unknown as NonNullable<PasskeyDeps["verifyAuthenticationResponse"]>;
    app = fullApp({ verifyAuthenticationResponse: throwing });
    challenge = await freshLoginChallenge(app, "10.3.5.3");
    res = await app.request("/api/auth/passkey/login-verify", {
      method: "POST",
      headers: headers({}, "10.3.5.4"),
      body: JSON.stringify(assertionResponse(challenge)),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("shares the password login rate budget per IP", async () => {
    const app = fullApp({ verifyAuthenticationResponse: verifiedAuth() });
    const attempt = () =>
      app.request("/api/auth/passkey/login-verify", {
        method: "POST",
        headers: headers({}, "10.3.6.1"),
        body: "not-json",
      });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);

    // The same IP is now also blocked from password login — one shared budget.
    const pw = await app.request("/api/auth/login", {
      method: "POST",
      headers: headers({}, "10.3.6.1"),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(pw.status).toBe(429);
  });
});

describe("password auto-disable", () => {
  const passwordLogin = (ip: string) =>
    fullApp().request("/api/auth/login", {
      method: "POST",
      headers: headers({}, ip),
      body: JSON.stringify({ password: PASSWORD }),
    });

  test("password login is refused once a passkey exists for the RP", async () => {
    seedCredential();
    const res = await passwordLogin("10.5.0.1");
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();

    const methods = await fullApp().request("/api/auth/methods", {
      headers: headers(),
    });
    expect(await methods.json()).toEqual({ password: false, passkey: true });
  });

  test("a foreign-RP credential does not disable password login", async () => {
    seedCredential({ rp_id: "other.test" });
    const res = await passwordLogin("10.5.1.1");
    expect(res.status).toBe(200);
  });

  test("BRAIN_UI_ALLOW_PASSWORD=1 re-enables password login", async () => {
    seedCredential();
    process.env.BRAIN_UI_ALLOW_PASSWORD = "1";
    try {
      const res = await passwordLogin("10.5.2.1");
      expect(res.status).toBe(200);
      const methods = await fullApp().request("/api/auth/methods", {
        headers: headers(),
      });
      expect(await methods.json()).toEqual({ password: true, passkey: true });
    } finally {
      delete process.env.BRAIN_UI_ALLOW_PASSWORD;
    }
  });

  test("deleting the last passkey re-enables password login", async () => {
    const app = fullApp();
    const cookie = await loginCookie(app, "10.5.3.1");
    seedCredential();
    expect((await passwordLogin("10.5.3.2")).status).toBe(403);

    const del = await app.request("/api/auth/passkey/cred-1", {
      method: "DELETE",
      headers: headers({ cookie }, "10.5.3.3"),
    });
    expect(del.status).toBe(200);
    expect((await passwordLogin("10.5.3.4")).status).toBe(200);
  });
});

describe("registration + management", () => {
  test("management routes are session-gated by mount position", async () => {
    const app = fullApp();
    for (const [path, method] of [
      ["/api/auth/passkey/register-options", "POST"],
      ["/api/auth/passkey/list", "GET"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: headers({}, "10.4.0.1"),
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(401);
    }
  });

  test("register-options excludes existing credentials for this RP only", async () => {
    const app = fullApp();
    const cookie = await loginCookie(app, "10.4.1.1");
    seedCredential();
    seedCredential({ id: "cred-other", rp_id: "other.test" });
    const res = await app.request("/api/auth/passkey/register-options", {
      method: "POST",
      headers: headers({ cookie }, "10.4.1.2"),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const options = await res.json();
    expect(options.rp.id).toBe(RP_ID);
    expect(options.user.id).toBe(b64url("brain-ui-owner"));
    expect(options.authenticatorSelection.residentKey).toBe("required");
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(["cred-1"]);
    expect(options.attestation).toBe("none");
  });

  test("register-verify stores the credential", async () => {
    const app = fullApp({ verifyRegistrationResponse: verifiedRegistration("cred-new") });
    const cookie = await loginCookie(app, "10.4.2.1");
    const optRes = await app.request("/api/auth/passkey/register-options", {
      method: "POST",
      headers: headers({ cookie }, "10.4.2.2"),
      body: "{}",
    });
    const challenge = (await optRes.json()).challenge as string;

    const res = await app.request("/api/auth/passkey/register-verify", {
      method: "POST",
      headers: headers({ cookie }, "10.4.2.3"),
      body: JSON.stringify({
        response: registrationResponse(challenge, "cred-new"),
        label: "  My phone  ",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.credential.id).toBe("cred-new");
    expect(body.credential.label).toBe("My phone");
    expect(body.credential.rpId).toBe(RP_ID);
    expect(body.credential.backedUp).toBe(true);
  });

  test("list, rename, delete round-trip", async () => {
    const app = fullApp();
    const cookie = await loginCookie(app, "10.4.3.1");
    seedCredential();
    seedCredential({ id: "cred-2", rp_id: "other.test", label: "Old laptop" });

    // List shows ALL RPs (so stale dev credentials are visible in prod).
    const list = await app.request("/api/auth/passkey/list", {
      headers: headers({ cookie }, "10.4.3.2"),
    });
    const credentials = (await list.json()).credentials as { id: string }[];
    expect(credentials.map((c) => c.id).sort()).toEqual(["cred-1", "cred-2"]);

    const rename = await app.request("/api/auth/passkey/cred-1", {
      method: "PUT",
      headers: headers({ cookie }, "10.4.3.3"),
      body: JSON.stringify({ label: "Renamed" }),
    });
    expect(rename.status).toBe(200);
    const row = getDb()
      .query("SELECT label FROM passkey_credentials WHERE id = 'cred-1'")
      .get() as { label: string };
    expect(row.label).toBe("Renamed");

    const del = await app.request("/api/auth/passkey/cred-2", {
      method: "DELETE",
      headers: headers({ cookie }, "10.4.3.4"),
    });
    expect(del.status).toBe(200);
    const missing = await app.request("/api/auth/passkey/cred-2", {
      method: "DELETE",
      headers: headers({ cookie }, "10.4.3.5"),
    });
    expect(missing.status).toBe(404);
  });
});
