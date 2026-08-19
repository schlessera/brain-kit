import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import {
  resolveAuthMode,
  assertAuthConfig,
  authGuard,
  authRoutes,
  isWsAuthorized,
  type AuthMode,
  type AuthRuntime,
} from "../src/middleware/auth";
import { resolveServerConfig } from "../src/config/env";

const PASSWORD = "correct horse battery staple";
let HASH = "";
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
  app.route("/api", authRoutes("password", runtime));
  app.use("/api/*", authGuard("password", runtime));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  // Un-guarded probe so isWsAuthorized can be tested with a real Hono context.
  app.get("/wscheck", async (c) =>
    c.json({ ok: await isWsAuthorized(c, "password", runtime) })
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
});

describe("isWsAuthorized", () => {
  test("none mode always authorizes", async () => {
    const ctx = { req: { header: () => undefined } };
    expect(await isWsAuthorized(ctx as never, "none", auth())).toBe(true);
  });

  test("password mode rejects without a cookie", async () => {
    const ctx = { req: { header: () => undefined } };
    expect(
      await isWsAuthorized(ctx as never, "password", auth({ COOKIE_SECRET: SECRET }))
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
        auth({ PROXY_AUTH_HEADER: "x-forwarded-user", TRUST_PROXY: "1" })
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
        auth({ PROXY_AUTH_HEADER: "x-forwarded-user" })
      )
    ).toBe(false);
  });
});
