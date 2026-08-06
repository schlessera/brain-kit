import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { createApp } from "../src/app";
import { closeDb } from "../src/db/client";

// Hermetic wiring test: boots the real app in a deployed-like config and asserts
// the wiring that the three prod lockouts (auth-guard ordering, CORS, WS origin)
// would have tripped. No brain/claude subprocess, no network — just app.fetch.

const PASSWORD = "correct horse battery staple";
let passwordHash: string;

const ENV = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "ALLOWED_ORIGINS",
  "TRUST_PROXY",
  "DB_PATH",
] as const;
const saved: Record<string, string | undefined> = {};
const TEST_DB = join(tmpdir(), `app-wiring-test-${process.pid}.db`);

beforeAll(async () => {
  for (const key of ENV) saved[key] = process.env[key];
  passwordHash = await Bun.password.hash(PASSWORD);
  process.env.AUTH_MODE = "password";
  process.env.BRAIN_UI_PASSWORD_HASH = passwordHash;
  process.env.COOKIE_SECRET = "test-cookie-secret-0123456789abcdef";
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.TRUST_PROXY;
  // Passkey routes touch the DB; never let a wiring test open a real db file.
  closeDb();
  process.env.DB_PATH = TEST_DB;
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(TEST_DB + suffix, { force: true });
  }
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

const app = () => createApp();
const get = (path: string, headers?: Record<string, string>) =>
  app().fetch(new Request(`http://localhost${path}`, { headers }));

describe("app wiring — auth guard ordering", () => {
  test("/api/health is public and carries no version/SHA", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBeUndefined();
  });

  test("/api/status is behind the auth guard", async () => {
    const res = await get("/api/status");
    expect(res.status).toBe(401);
  });

  test("/api/vpn-check is behind the auth guard", async () => {
    const res = await get("/api/vpn-check");
    expect(res.status).toBe(401);
  });

  test("the model catalog routes are behind the auth guard", async () => {
    const send = (path: string, init?: RequestInit) =>
      app().fetch(new Request(`http://localhost${path}`, init));

    expect((await send("/api/models")).status).toBe(401);
    expect(
      (
        await send("/api/models/hidden", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hidden: [] }),
        })
      ).status
    ).toBe(401);
    expect((await send("/api/models/refresh", { method: "POST" })).status).toBe(
      401
    );
  });
});

describe("app wiring — password auth", () => {
  test("valid login round-trips a hardened cookie that unlocks a guarded route", async () => {
    const a = app();
    const login = await a.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    expect(login.status).toBe(200);

    const cookie = login.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const rawCookie = cookie!.split(";")[0];
    const guarded = await a.fetch(
      new Request("http://localhost/api/vpn-check", {
        headers: { cookie: rawCookie },
      })
    );
    expect(guarded.status).toBe(200);
  });

  test("wrong password is rejected", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("app wiring — passkey route gating", () => {
  const sameOrigin = { origin: "http://localhost", host: "localhost" };

  test("passkey assertion routes are public (not behind the guard)", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/auth/passkey/login-options", {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: "{}",
      })
    );
    expect(res.status).toBe(200);
  });

  test("passkey management routes are behind the guard", async () => {
    const list = await get("/api/auth/passkey/list", sameOrigin);
    expect(list.status).toBe(401);

    const register = await app().fetch(
      new Request("http://localhost/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: "{}",
      })
    );
    expect(register.status).toBe(401);
  });

  test("a login cookie unlocks passkey management", async () => {
    const a = app();
    const login = await a.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const register = await a.fetch(
      new Request("http://localhost/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...sameOrigin },
        body: "{}",
      })
    );
    expect(register.status).toBe(200);
    expect((await register.json()).rp.id).toBe("localhost");
  });
});

describe("app wiring — WebSocket origin check (CSWSH)", () => {
  test("a foreign Origin is rejected before auth", async () => {
    const res = await get("/ws", {
      origin: "https://evil.example",
      host: "localhost",
    });
    expect(res.status).toBe(403);
  });

  test("same-origin passes the origin check, then fails on auth (401, not 403)", async () => {
    const res = await get("/ws", {
      origin: "http://localhost",
      host: "localhost",
    });
    expect(res.status).toBe(401);
  });
});

describe("app wiring — CORS (split topology)", () => {
  test("no ALLOWED_ORIGINS means no CORS header (same-origin default)", async () => {
    delete process.env.ALLOWED_ORIGINS;
    const res = await get("/api/health", { origin: "https://app.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an allowed origin gets a matching ACAO with credentials", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example";
    try {
      const res = await get("/api/health", { origin: "https://app.example" });
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://app.example"
      );
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });
});

describe("createApp refuses unsafe configuration", () => {
  const restore: Record<string, string | undefined> = {};
  const keys = ["AUTH_MODE", "HOST", "NODE_ENV", "WEBAUTHN_USER_ID"] as const;

  function snapshot() {
    for (const k of keys) restore[k] = process.env[k];
  }
  function reset() {
    for (const k of keys) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k]!;
    }
  }

  test("AUTH_MODE=none on a non-loopback host fails inside the factory", () => {
    snapshot();
    try {
      process.env.AUTH_MODE = "none";
      process.env.HOST = "0.0.0.0";
      delete process.env.NODE_ENV; // the refusal must not depend on it
      expect(() => createApp()).toThrow(/refuses to start/);

      // The explicit escape hatch is the only way through.
      process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH = "1";
      expect(() => createApp()).not.toThrow();
      delete process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH;
    } finally {
      reset();
    }
  });

  test("an over-long WEBAUTHN_USER_ID fails inside the factory", () => {
    snapshot();
    try {
      process.env.AUTH_MODE = "password";
      process.env.WEBAUTHN_USER_ID = "x".repeat(65);
      expect(() => createApp()).toThrow(/WEBAUTHN_USER_ID/);
      process.env.WEBAUTHN_USER_ID = "x".repeat(64);
      expect(() => createApp()).not.toThrow();
    } finally {
      reset();
    }
  });
});
