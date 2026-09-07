import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import {
  resolveAuthMode,
  assertAuthConfig,
  authGuard,
  authRoutes,
  consumeLoginToken,
  GLOBAL_LOGIN_RATE_LIMIT,
  isWsAuthorized,
  resetLoginRateLimiter,
  type AuthMode,
  type AuthRuntime,
} from "../src/middleware/auth";
import { resolveServerConfig } from "../src/config/env";
import {
  createRecordingObservability,
  type RecordingObservability,
} from "../src/observability/index";
import { createUiDb } from "../src/db/client";
import { ClientSet } from "../src/ws/clients";

const PASSWORD = "correct horse battery staple";
let HASH = "";
const DB = createUiDb(":memory:");
const SECRET = "test-cookie-secret-0123456789abcdef";

/**
 * Configuration is injected, not ambient: build an AuthRuntime from an
 * explicit env record through the real resolver, so these tests exercise the
 * same resolution path production uses — with zero process.env mutation.
 */
function auth(env: Record<string, string | undefined> = {}): AuthRuntime {
  const config = resolveServerConfig(env);
  return { ...config.auth, host: config.host };
}

beforeAll(async () => {
  HASH = await Bun.password.hash(PASSWORD);
});

afterAll(() => DB.close());

describe("resolveAuthMode", () => {
  test("honors an explicit AUTH_MODE", () => {
    for (const mode of ["password", "tailscale", "proxy", "none"] as AuthMode[]) {
      expect(resolveAuthMode(auth({ AUTH_MODE: mode }))).toBe(mode);
    }
  });

  test("defaults to password when a hash is present", () => {
    expect(resolveAuthMode(auth({ BRAIN_UI_PASSWORD_HASH: HASH }))).toBe("password");
  });

  test("defaults to tailscale with no hash", () => {
    expect(resolveAuthMode(auth())).toBe("tailscale");
  });

  test("an unknown AUTH_MODE falls back to auto-detection", () => {
    expect(resolveAuthMode(auth({ AUTH_MODE: "carrier-pigeon" }))).toBe("tailscale");
    expect(
      resolveAuthMode(auth({ AUTH_MODE: "carrier-pigeon", BRAIN_UI_PASSWORD_HASH: HASH }))
    ).toBe("password");
  });
});

describe("assertAuthConfig", () => {
  test("password mode requires hash + cookie secret", () => {
    expect(() => assertAuthConfig("password", auth())).toThrow(
      /BRAIN_UI_PASSWORD_HASH/
    );
    expect(() =>
      assertAuthConfig("password", auth({ BRAIN_UI_PASSWORD_HASH: HASH }))
    ).toThrow(/COOKIE_SECRET/);
    expect(() =>
      assertAuthConfig(
        "password",
        auth({ BRAIN_UI_PASSWORD_HASH: HASH, COOKIE_SECRET: SECRET })
      )
    ).not.toThrow();
  });

  test("none refuses a non-loopback host regardless of NODE_ENV", () => {
    for (const nodeEnv of ["production", "development", undefined]) {
      expect(() =>
        assertAuthConfig("none", auth({ NODE_ENV: nodeEnv, HOST: "0.0.0.0" }))
      ).toThrow(/refuses to start/);
    }
  });

  test("none refuses when HOST is unset (fail closed)", () => {
    expect(() => assertAuthConfig("none", auth())).toThrow(/refuses to start/);
  });

  test("none is allowed on a loopback host", () => {
    expect(() =>
      assertAuthConfig("none", auth({ NODE_ENV: "production", HOST: "127.0.0.1" }))
    ).not.toThrow();
  });

  test("none on a non-loopback host requires the explicit escape hatch", () => {
    expect(() =>
      assertAuthConfig(
        "none",
        auth({ HOST: "0.0.0.0", BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: "1" })
      )
    ).not.toThrow();
  });

  test("proxy mode refuses to boot without TRUST_PROXY", () => {
    expect(() => assertAuthConfig("proxy", auth())).toThrow(/TRUST_PROXY/);
    expect(() => assertAuthConfig("proxy", auth({ TRUST_PROXY: "1" }))).not.toThrow();
  });
});

function passwordAuth(): AuthRuntime {
  return auth({
    BRAIN_UI_PASSWORD_HASH: HASH,
    COOKIE_SECRET: SECRET,
    // Read x-forwarded-for so each test can use a distinct rate-limit bucket.
    TRUST_PROXY: "1",
  });
}

function passwordApp() {
  const runtime = passwordAuth();
  const app = new Hono();
  app.route(
    "/api",
    authRoutes("password", runtime, { db: DB, clients: new ClientSet() })
  );
  app.use("/api/*", authGuard("password", runtime, DB));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  // Un-guarded probe so isWsAuthorized can be tested with a real Hono context.
  app.get("/wscheck", async (c) =>
    c.json({ ok: await isWsAuthorized(c, "password", runtime, DB) })
  );
  return app;
}

describe("password login + guard", () => {
  test("guard blocks an unauthenticated request with 401", async () => {
    const app = passwordApp();
    const res = await app.request("/api/secret");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.authRequired).toBe(true);
  });

  test("wrong password is rejected", async () => {
    const app = passwordApp();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  test("correct password sets a cookie that unlocks the guard", async () => {
    const app = passwordApp();
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.2" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie");
    expect(setCookie).toContain("brain_ui_session=");
    expect(setCookie?.toLowerCase()).toContain("httponly");

    const cookie = setCookie!.split(";")[0];
    const ok = await app.request("/api/secret", { headers: { cookie } });
    expect(ok.status).toBe(200);

    // The same cookie authorizes a WebSocket upgrade.
    const wsRes = await app.request("/wscheck", { headers: { cookie } });
    expect((await wsRes.json()).ok).toBe(true);
  });

  test("login is rate limited per client IP", async () => {
    const app = passwordApp();
    const attempt = () =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify({ password: "wrong" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
    // 5 allowed (401), then the bucket empties (429).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  });

  test("bounds concurrent password verification per client IP", async () => {
    const runtime = passwordAuth();
    const app = new Hono();
    let entered = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let twoEntered!: () => void;
    const enteredTwo = new Promise<void>((resolve) => {
      twoEntered = resolve;
    });

    app.route(
      "/api",
      authRoutes("password", runtime, {
        db: DB,
        clients: new ClientSet(),
        verifyPassword: async () => {
          entered++;
          active++;
          maxActive = Math.max(maxActive, active);
          if (entered === 2) twoEntered();
          await gate;
          active--;
          return false;
        },
      })
    );

    const requests = Array.from({ length: 6 }, () =>
      login(app, "wrong", "10.9.9.10")
    );
    await Promise.race([
      enteredTwo,
      Bun.sleep(250).then(() => {
        throw new Error("two requests did not enter the injected verifier");
      }),
    ]);
    expect(entered).toBe(2);
    expect(maxActive).toBe(2);

    release();
    const statuses = await Promise.all(requests.map(async (request) => (await request).status));
    expect(statuses.filter((status) => status === 401)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
  });
});

describe("login limiter storage", () => {
  beforeEach(() => resetLoginRateLimiter());

  test("a client-derived key cannot overwrite the global password bucket", async () => {
    const runtime = passwordAuth();
    const app = new Hono();
    let releaseDelayed!: () => void;
    const delayedGate = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    let markDelayedEntered!: () => void;
    const delayedEntered = new Promise<void>((resolve) => {
      markDelayedEntered = resolve;
    });

    app.route(
      "/api",
      authRoutes("password", runtime, {
        db: DB,
        clients: new ClientSet(),
        verifyPassword: async (password) => {
          if (password === "delayed") {
            markDelayedEntered();
            await delayedGate;
          }
          return password === PASSWORD;
        },
      })
    );

    // `global` used to produce the same `pw:global` key as the process-wide
    // bucket. Hold this failure in verification while other source keys fill
    // the global budget, reproducing the ordering that could clamp it back to 5.
    const collidingFailure = login(app, "delayed", "global");
    await delayedEntered;

    for (let index = 0; index < GLOBAL_LOGIN_RATE_LIMIT; index++) {
      expect((await login(app, "wrong", `other-${index}`)).status).toBe(401);
    }
    expect((await login(app, PASSWORD, "blocked-before-release")).status).toBe(429);

    releaseDelayed();
    expect((await collidingFailure).status).toBe(401);

    // Finishing the colliding request must not reduce the saturated global
    // counter and reopen verification for a fresh source key.
    expect((await login(app, PASSWORD, "blocked-after-release")).status).toBe(429);
  });

  test("evicts old buckets when the size cap is reached", () => {
    expect(consumeLoginToken("bounded:sentinel", 1)).toBe(true);
    expect(consumeLoginToken("bounded:sentinel", 1)).toBe(false);

    for (let index = 0; index < 1_024; index++) {
      expect(consumeLoginToken(`bounded:${index}`, 1)).toBe(true);
    }

    // The sentinel was the oldest entry, so a capped map admits it afresh.
    expect(consumeLoginToken("bounded:sentinel", 1)).toBe(true);
  });
});

describe("isWsAuthorized", () => {
  test("none mode always authorizes", async () => {
    const ctx = { req: { header: () => undefined } };
    expect(await isWsAuthorized(ctx as never, "none", auth(), DB)).toBe(true);
  });

  test("password mode rejects without a cookie", async () => {
    const ctx = { req: { header: () => undefined } };
    expect(
      await isWsAuthorized(
        ctx as never,
        "password",
        auth({ COOKIE_SECRET: SECRET }),
        DB
      )
    ).toBe(false);
  });

  test("proxy mode authorizes when the trusted header is present", async () => {
    const ctx = {
      req: { header: (n: string) => (n === "x-forwarded-user" ? "alex" : undefined) },
    };
    expect(
      await isWsAuthorized(
        ctx as never,
        "proxy",
        auth({ PROXY_AUTH_HEADER: "x-forwarded-user", TRUST_PROXY: "1" }),
        DB
      )
    ).toBe(true);
  });

  test("proxy mode denies the header when TRUST_PROXY is not set", async () => {
    const ctx = {
      req: { header: (n: string) => (n === "x-forwarded-user" ? "alex" : undefined) },
    };
    expect(
      await isWsAuthorized(
        ctx as never,
        "proxy",
        auth({ PROXY_AUTH_HEADER: "x-forwarded-user" }),
        DB
      )
    ).toBe(false);
  });
});

/**
 * The login route observed the way createApp wires it: the auth logger plus
 * the shared auth.failures counter, read back through the recording consumer.
 */
function observedPasswordApp(runtime: AuthRuntime = passwordAuth()): {
  app: Hono;
  observability: RecordingObservability;
} {
  const observability = createRecordingObservability();
  const app = new Hono();
  app.route(
    "/api",
    authRoutes("password", runtime, {
      db: DB,
      clients: new ClientSet(),
      log: observability.logger("auth"),
      failures: observability.meter("auth").createCounter("auth.failures"),
    })
  );
  return { app, observability };
}

const login = (app: Hono, password: string, ip: string) =>
  app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });

describe("login outcomes are observable", () => {
  // The rate-limit buckets (per-IP and global) are module state shared with
  // the earlier login tests; start each test from a full global bucket.
  beforeEach(() => resetLoginRateLimiter());

  test("a wrong password is a WARN and an auth.failures count — without the password", async () => {
    const { app, observability } = observedPasswordApp();

    const res = await login(app, "swordfish-wrong", "10.1.0.1");
    expect(res.status).toBe(401);

    expect(
      observability.metrics.value("auth.failures", {
        reason: "invalid_password",
        method: "password",
      })
    ).toBe(1);
    const [record] = observability.logs.find({ scope: "auth", severity: "WARN" });
    expect(record.body).toBe("login failed");
    expect(record.attributes.ip).toBe("10.1.0.1");
    expect(JSON.stringify(observability.logs.records())).not.toContain("swordfish");
  });

  test("hitting the rate limit is its own reason", async () => {
    const { app, observability } = observedPasswordApp();

    let last = 0;
    for (let i = 0; i < 7; i++) last = (await login(app, "wrong", "10.1.0.2")).status;
    expect(last).toBe(429);

    expect(
      observability.metrics.value("auth.failures", {
        reason: "rate_limited",
        method: "password",
      })
    ).toBeGreaterThan(0);
    expect(observability.logs.count({ body: "login rate limited" })).toBeGreaterThan(0);
  });

  test("a successful login is an INFO record and no failure count", async () => {
    const { app, observability } = observedPasswordApp();

    const res = await login(app, PASSWORD, "10.1.0.3");
    expect(res.status).toBe(200);

    expect(observability.metrics.total("auth.failures")).toBe(0);
    const [record] = observability.logs.find({ body: "login succeeded" });
    expect(record.severity).toBe("INFO");
    expect(record.attributes.ip).toBe("10.1.0.3");
  });

  test("a hash Bun cannot parse is an ERROR, not another wrong password", async () => {
    // The regression: `.catch(() => false)` made a corrupt
    // BRAIN_UI_PASSWORD_HASH indistinguishable from a typo — the owner is
    // locked out and the log blames them for it.
    const runtime = {
      ...passwordAuth(),
      passwordHash: "$corrupt$not-a-real-argon2-hash",
    };
    const { app, observability } = observedPasswordApp(runtime);

    const res = await login(app, PASSWORD, "10.1.0.4");
    expect(res.status).toBe(401);

    expect(
      observability.metrics.value("auth.failures", {
        reason: "verify_error",
        method: "password",
      })
    ).toBe(1);
    const [record] = observability.logs.find({ scope: "auth", severity: "ERROR" });
    expect(record.body).toContain("BRAIN_UI_PASSWORD_HASH");
    expect(observability.logs.count({ body: "login failed" })).toBe(0);
  });

  test("warns once when X-Forwarded-For is ignored in password mode", async () => {
    const runtime = auth({
      BRAIN_UI_PASSWORD_HASH: HASH,
      COOKIE_SECRET: SECRET,
    });
    const { app, observability } = observedPasswordApp(runtime);

    await login(app, "wrong", "10.1.0.5");
    await login(app, "wrong", "10.1.0.6");

    expect(
      observability.logs.count({ body: "X-Forwarded-For ignored in password mode" })
    ).toBe(1);
  });
});
