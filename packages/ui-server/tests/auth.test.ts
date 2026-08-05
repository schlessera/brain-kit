import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import {
  resolveAuthMode,
  assertAuthConfig,
  authGuard,
  authRoutes,
  isWsAuthorized,
  type AuthMode,
} from "../src/middleware/auth";

const PASSWORD = "correct horse battery staple";
let HASH = "";
const SECRET = "test-cookie-secret-0123456789abcdef";

// Snapshot the env keys these tests mutate so nothing leaks between files.
const ENV_KEYS = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "NODE_ENV",
  "HOST",
  "TRUST_PROXY",
  "PROXY_AUTH_HEADER",
  "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  HASH = await Bun.password.hash(PASSWORD);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("resolveAuthMode", () => {
  test("honors an explicit AUTH_MODE", () => {
    clearEnv();
    for (const mode of ["password", "tailscale", "proxy", "none"] as AuthMode[]) {
      process.env.AUTH_MODE = mode;
      expect(resolveAuthMode()).toBe(mode);
    }
  });

  test("defaults to password when a hash is present", () => {
    clearEnv();
    process.env.BRAIN_UI_PASSWORD_HASH = HASH;
    expect(resolveAuthMode()).toBe("password");
  });

  test("defaults to tailscale with no hash", () => {
    clearEnv();
    expect(resolveAuthMode()).toBe("tailscale");
  });
});

describe("assertAuthConfig", () => {
  test("password mode requires hash + cookie secret", () => {
    clearEnv();
    expect(() => assertAuthConfig("password")).toThrow(/BRAIN_UI_PASSWORD_HASH/);
    process.env.BRAIN_UI_PASSWORD_HASH = HASH;
    expect(() => assertAuthConfig("password")).toThrow(/COOKIE_SECRET/);
    process.env.COOKIE_SECRET = SECRET;
    expect(() => assertAuthConfig("password")).not.toThrow();
  });

  test("none refuses a non-loopback host regardless of NODE_ENV", () => {
    for (const nodeEnv of ["production", "development", undefined]) {
      clearEnv();
      if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
      process.env.HOST = "0.0.0.0";
      expect(() => assertAuthConfig("none")).toThrow(/refuses to start/);
    }
  });

  test("none refuses when HOST is unset (fail closed)", () => {
    clearEnv();
    expect(() => assertAuthConfig("none")).toThrow(/refuses to start/);
  });

  test("none is allowed on a loopback host", () => {
    clearEnv();
    process.env.NODE_ENV = "production";
    process.env.HOST = "127.0.0.1";
    expect(() => assertAuthConfig("none")).not.toThrow();
  });

  test("none on a non-loopback host requires the explicit escape hatch", () => {
    clearEnv();
    process.env.HOST = "0.0.0.0";
    process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH = "1";
    expect(() => assertAuthConfig("none")).not.toThrow();
    delete process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH;
  });
});

function passwordApp() {
  const app = new Hono();
  app.route("/api", authRoutes("password"));
  app.use("/api/*", authGuard("password"));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  // Un-guarded probe so isWsAuthorized can be tested with a real Hono context.
  app.get("/wscheck", async (c) => c.json({ ok: await isWsAuthorized(c, "password") }));
  return app;
}

describe("password login + guard", () => {
  beforeAll(() => {
    clearEnv();
    process.env.BRAIN_UI_PASSWORD_HASH = HASH;
    process.env.COOKIE_SECRET = SECRET;
    // Read x-forwarded-for so each test can use a distinct rate-limit bucket.
    process.env.TRUST_PROXY = "1";
  });

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
    expect(await isWsAuthorized(ctx as never, "none")).toBe(true);
  });

  test("password mode rejects without a cookie", async () => {
    clearEnv();
    process.env.COOKIE_SECRET = SECRET;
    const ctx = { req: { header: () => undefined } };
    expect(await isWsAuthorized(ctx as never, "password")).toBe(false);
  });

  test("proxy mode authorizes when the trusted header is present", async () => {
    clearEnv();
    process.env.PROXY_AUTH_HEADER = "x-forwarded-user";
    process.env.TRUST_PROXY = "1";
    const ctx = {
      req: { header: (n: string) => (n === "x-forwarded-user" ? "alex" : undefined) },
    };
    expect(await isWsAuthorized(ctx as never, "proxy")).toBe(true);
  });

  test("proxy mode denies the header when TRUST_PROXY is not set", async () => {
    clearEnv();
    process.env.PROXY_AUTH_HEADER = "x-forwarded-user";
    delete process.env.TRUST_PROXY;
    const ctx = {
      req: { header: (n: string) => (n === "x-forwarded-user" ? "alex" : undefined) },
    };
    expect(await isWsAuthorized(ctx as never, "proxy")).toBe(false);
  });
});
