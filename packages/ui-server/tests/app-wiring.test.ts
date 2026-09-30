import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import { createApp } from "../src/app";
import {
  createConsoleLoggerProvider,
  createObservability,
  createRecordingObservability,
} from "../src/observability/index";
import { resolveServerConfig } from "../src/config/env";
import { bundledClaudeBinary } from "./helpers/claude-binary";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createUiDb } from "../src/db/client";
import {
  PRINCIPAL_RETENTION_MS,
  resolveAmbientPrincipal,
  resolvePrincipal,
} from "../src/db/principals";

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
  "BRAIN_PATH",
  "CLAUDE_CODE_PATH",
  "BRAIN_UI_PRICING_DISCOVERY",
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
  process.env.DB_PATH = TEST_DB;
  // The version probe must never inspect a developer's real brain repo.
  process.env.BRAIN_PATH = join(tmpdir(), `app-wiring-brain-${process.pid}`);
  mkdirSync(process.env.BRAIN_PATH, { recursive: true });
  // Boot probes the binary a turn would spawn (#211): the one the lockfile installs.
  process.env.CLAUDE_CODE_PATH = bundledClaudeBinary();
  // Production NODE_ENV cases below still test wiring, not live pricing.
  process.env.BRAIN_UI_PRICING_DISCOVERY = "0";
});

afterAll(() => {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(TEST_DB + suffix, { force: true });
  }
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
});

const app = async () => await createApp();
const get = async (path: string, headers?: Record<string, string>) =>
  (await app()).fetch(new Request(`http://localhost${path}`, { headers }));

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

  test("principal management routes are mounted behind the auth guard", async () => {
    const instance = await app();
    try {
      expect(
        (
          await instance.fetch(
            new Request("http://localhost/api/auth/principals")
          )
        ).status
      ).toBe(401);

      const login = await instance.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: PASSWORD }),
        })
      );
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      const list = await instance.fetch(
        new Request("http://localhost/api/auth/principals", {
          headers: { cookie },
        })
      );
      expect(list.status).toBe(200);
      const listed = (await list.json()) as {
        principals: Array<{ id: string; kind: string; is_own: boolean }>;
      };
      expect(
        listed.principals.some(
          ({ kind, is_own }) => kind === "owner" && is_own
        )
      ).toBe(true);

      const mint = await instance.fetch(
        new Request("http://localhost/api/auth/principals", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ label: "Wiring agent" }),
        })
      );
      expect(mint.status).toBe(200);
      const minted = (await mint.json()) as {
        id: string;
        label: string;
        cookie: string;
      };
      expect(minted.label).toBe("Wiring agent");
      expect(minted.cookie).toBeString();

      const deleted = await instance.fetch(
        new Request(`http://localhost/api/auth/principals/${minted.id}`, {
          method: "DELETE",
          headers: { cookie },
        })
      );
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
    } finally {
      await instance.close();
    }
  });

  test("the activity routes are behind the auth guard", async () => {
    // The activity record leaks strictly more than /api/status (session
    // activity, errors, spend) — same boundary, same reason.
    for (const path of ["/api/activity/runs", "/api/activity/runs/x", "/api/activity/rollups", "/api/activity/stats", "/api/activity/inbox"]) {
      const res = await get(path);
      expect(res.status).toBe(401);
    }
  });

  test("the runtime stats route is mounted, not merely 401ing as an unknown path", async () => {
    // The 401 list above would pass for a path that does not exist at all —
    // the guard runs before routing. Authenticate and read it back, so the
    // guard assertion is about a route rather than about a typo.
    const instance = await app();
    try {
      const login = await instance.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: PASSWORD }),
        })
      );
      const cookie = login.headers.get("set-cookie")!.split(";")[0];

      const res = await instance.fetch(
        new Request("http://localhost/api/activity/stats?days=7", {
          headers: { cookie },
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        lifetime: { scope: string };
        window: { scope: string; days: number };
        database: { sizeBytes: number };
      };
      expect(body.lifetime.scope).toBe("lifetime");
      expect(body.window.scope).toBe("window");
      expect(body.window.days).toBe(7);
      expect(body.database.sizeBytes).toBeGreaterThan(0);
    } finally {
      await instance.close();
    }
  });

  test("the push routes are behind the auth guard", async () => {
    // Subscribing is a write into the notification fan-out; the public key
    // is per-deployment. Only the authenticated user gets either.
    for (const path of ["/api/push/public-key", "/api/push/subscriptions"]) {
      const res = await get(path);
      expect(res.status).toBe(401);
    }
  });

  test("the model catalog routes are behind the auth guard", async () => {
    const send = async (path: string, init?: RequestInit) =>
      (await app()).fetch(new Request(`http://localhost${path}`, init));

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

  test("a share that reaches the server without a worker lands in the app", async () => {
    // No service worker intercepted it — the POST must not become a bare 404
    // inside the app window. Public by necessity: a share navigation is
    // cross-site, so the SameSite=Strict cookie is absent by construction.
    const res = await (await app()).fetch(
      new Request("http://localhost/share-target", { method: "POST" })
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?share_error=no_worker");
  });

  test("the share intake route is behind the auth guard", async () => {
    // It writes files into the brain root, so mount position is the whole
    // defense: an unauthenticated POST must never reach the staging code.
    const res = await (await app()).fetch(
      new Request("http://localhost/api/share", {
        method: "POST",
        body: new FormData(),
      })
    );
    expect(res.status).toBe(401);
  });

  test("the graph routes are behind the auth guard", async () => {
    // Every one of these enumerates note paths and titles, so an unauthenticated
    // caller must not reach them — not even /graph/meta, which counts the corpus.
    for (const path of [
      "/api/graph/meta",
      "/api/graph/clusters",
      "/api/graph/neighborhood?center=index.md",
      "/api/graph/discovery",
      "/api/graph/maintenance",
    ]) {
      expect((await get(path)).status).toBe(401);
    }
  });
});

describe("app wiring — password auth", () => {
  test("valid login round-trips a hardened cookie that unlocks a guarded route", async () => {
    const a = await app();
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
    const res = await (await app()).fetch(
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
    const res = await (await app()).fetch(
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

    const register = await (await app()).fetch(
      new Request("http://localhost/api/auth/passkey/register-options", {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: "{}",
      })
    );
    expect(register.status).toBe(401);
  });

  test("a login cookie unlocks passkey management", async () => {
    const a = await app();
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

  test("an authorized upgrade keeps its status and attributes the request", async () => {
    const observability = createRecordingObservability();
    const wired = await createApp({ observability });
    const login = await wired.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    observability.reset();

    let upgraded = false;
    const response = await wired.fetch(
      new Request("http://localhost/ws", {
        headers: {
          connection: "Upgrade",
          cookie,
          host: "localhost",
          origin: "http://localhost",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          upgrade: "websocket",
        },
      }),
      {
        server: {
          upgrade() {
            upgraded = true;
            return true;
          },
        },
      }
    );

    expect(response.status).toBe(200);
    expect(upgraded).toBe(true);
    const [record] = observability.logs.find({ scope: "http", body: "request" });
    expect(record.attributes.path).toBe("/ws");
    expect(record.attributes["auth.principal.id"]).toBeString();
    expect(record.attributes["auth.principal.label"]).toBe("Unknown device");
    await wired.close();
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

  test("AUTH_MODE=none on a non-loopback host fails inside the factory", async () => {
    snapshot();
    try {
      process.env.AUTH_MODE = "none";
      process.env.HOST = "0.0.0.0";
      delete process.env.NODE_ENV; // the refusal must not depend on it
      await expect(createApp()).rejects.toThrow(/refuses to start/);

      // The explicit escape hatch is the only way through.
      process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH = "1";
      await (await createApp()).close();
      delete process.env.BRAIN_UI_DANGEROUSLY_DISABLE_AUTH;
    } finally {
      reset();
    }
  });

  test("an over-long WEBAUTHN_USER_ID fails inside the factory", async () => {
    snapshot();
    try {
      process.env.AUTH_MODE = "password";
      process.env.WEBAUTHN_USER_ID = "x".repeat(65);
      await expect(createApp()).rejects.toThrow(/WEBAUTHN_USER_ID/);
      process.env.WEBAUTHN_USER_ID = "x".repeat(64);
      await (await createApp()).close();
    } finally {
      reset();
    }
  });
});

describe("createApp principal retention", () => {
  test("boot prunes an inactive ambient principal through the production path", async () => {
    const dbPath = join(
      tmpdir(),
      `app-wiring-principal-retention-${process.pid}-${Date.now()}.db`
    );
    const seed = createUiDb(dbPath);
    const inactive = resolveAmbientPrincipal(
      seed,
      "proxy",
      "inactive@example.test",
      "Inactive proxy user"
    );
    seed.prepare("UPDATE principals SET last_seen_at = ? WHERE id = ?").run(
      Date.now() - PRINCIPAL_RETENTION_MS - 1,
      inactive.id
    );
    await seed.close();

    let wired: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const backend = makeFakeBackend({ id: "fake" });
      wired = await createApp({
        dbPath,
        registry: createStaticBackendRegistry([backend], backend.id),
      });
      expect(resolvePrincipal(wired.db, inactive.id)).toBeNull();
    } finally {
      await wired?.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        rmSync(dbPath + suffix, { force: true });
      }
    }
  });
});

describe("app wiring — request logging", () => {
  test("requests are logged through the observability layer, /api/health excepted", async () => {
    const observability = createRecordingObservability();
    const wired = await createApp({ observability });
    const send = (path: string) =>
      wired.fetch(new Request(`http://localhost${path}`));

    await send("/api/health");
    await send("/api/status?secret=value");

    // The healthcheck poll leaves no record; the real request does — with the
    // path only, never the query string.
    expect(observability.logs.count({ scope: "http" })).toBe(1);
    const [record] = observability.logs.find({ scope: "http" });
    expect(record.severity).toBe("INFO");
    expect(record.attributes.method).toBe("GET");
    expect(record.attributes.path).toBe("/api/status");
    expect(record.attributes.status).toBe(401);
    expect(record.attributes["duration.ms"]).toBeNumber();
    expect(JSON.stringify(record.attributes)).not.toContain("secret");
    expect("auth.principal.id" in record.attributes).toBe(false);
    expect("auth.principal.label" in record.attributes).toBe(false);

    await wired.close();
  });

  test("an authenticated request log carries the resolved principal", async () => {
    const observability = createRecordingObservability();
    const wired = await createApp({ observability });
    const login = await wired.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    observability.reset();

    const response = await wired.fetch(
      new Request("http://localhost/api/vpn-check", { headers: { cookie } })
    );
    expect(response.status).toBe(200);

    const [record] = observability.logs.find({ scope: "http", body: "request" });
    const principalId = record.attributes["auth.principal.id"];
    expect(principalId).toBeString();
    expect(record.attributes["auth.principal.label"]).toBe("Unknown device");
    expect(
      wired.db.prepare("SELECT label FROM principals WHERE id = ?").get(principalId)
    ).toEqual({ label: "Unknown device" });
    await wired.close();
  });

  test("a successful logout log retains the principal that revoked the sessions", async () => {
    const observability = createRecordingObservability();
    const wired = await createApp({ observability });
    const login = await wired.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    observability.reset();

    const response = await wired.fetch(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie },
      })
    );

    expect(response.status).toBe(200);
    const [record] = observability.logs.find({ scope: "http", body: "request" });
    expect(record.attributes.path).toBe("/api/auth/logout");
    expect(record.attributes["auth.principal.id"]).toBeString();
    expect(record.attributes["auth.principal.label"]).toBe("Unknown device");
    await wired.close();
  });

  test("a proxy identity is sanitized and bounded before storage and logging", async () => {
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    const wired = await createApp({
      config: resolveServerConfig({
        AUTH_MODE: "proxy",
        TRUST_PROXY: "1",
        PROXY_AUTH_HEADER: "x-forwarded-user",
        HOST: "127.0.0.1",
        DB_PATH: ":memory:",
        BRAIN_PATH: join(tmpdir(), `app-wiring-proxy-brain-${process.pid}`),
        BRAIN_UI_MODEL_DISCOVERY: "0",
        BRAIN_UI_PRICING_DISCOVERY: "0",
      }),
      observability,
      registry: createStaticBackendRegistry([backend], backend.id),
    });
    const unsafeLabel = `\u0001 Alex\u007f ${"x".repeat(300)}`;
    const expectedLabel = `Alex ${"x".repeat(59)}`;

    const response = await wired.fetch(
      new Request("http://localhost/api/vpn-check", {
        headers: { "x-forwarded-user": unsafeLabel },
      })
    );
    expect(response.status).toBe(200);

    const row = wired.db
      .prepare("SELECT kind, label FROM principals")
      .get() as { kind: string; label: string };
    expect(row).toEqual({ kind: "ambient", label: expectedLabel });
    expect(row.label).toHaveLength(64);
    const [record] = observability.logs.find({ scope: "http", body: "request" });
    expect(record.attributes["auth.principal.label"]).toBe(expectedLabel);
    expect(record.attributes["auth.principal.label"]).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f]/u
    );
    await wired.close();
  });

  test("a proxy label cannot forge fields in the rendered request log", async () => {
    const lines: string[] = [];
    const loggerProvider = createConsoleLoggerProvider({
      write: (_severity, line) => lines.push(line),
    });
    const backend = makeFakeBackend({ id: "fake" });
    const wired = await createApp({
      config: resolveServerConfig({
        AUTH_MODE: "proxy",
        TRUST_PROXY: "1",
        PROXY_AUTH_HEADER: "x-forwarded-user",
        HOST: "127.0.0.1",
        DB_PATH: ":memory:",
        BRAIN_PATH: join(tmpdir(), `app-wiring-proxy-log-brain-${process.pid}`),
        BRAIN_UI_MODEL_DISCOVERY: "0",
        BRAIN_UI_PRICING_DISCOVERY: "0",
      }),
      observability: createObservability({ loggerProvider }),
      registry: createStaticBackendRegistry([backend], backend.id),
    });
    const label = "Alex status=200 auth.principal.id=forged";

    const response = await wired.fetch(
      new Request("http://localhost/api/vpn-check", {
        headers: { "x-forwarded-user": label },
      })
    );

    expect(response.status).toBe(200);
    const requestLine = lines.find((line) => line.startsWith("[http] request "));
    expect(requestLine).toMatch(
      /^\[http\] request method="GET" path="\/api\/vpn-check" status=200 duration\.ms=\d+ auth\.principal\.id="[A-Za-z0-9_-]{22}" auth\.principal\.label="Alex status=200 auth\.principal\.id=forged"$/
    );
    await wired.close();
  });
});

describe("app wiring — health probes the database", () => {
  test("a dead SQLite handle turns /api/health into 503 unhealthy", async () => {
    const wired = await createApp();
    const send = () => wired.fetch(new Request("http://localhost/api/health"));

    expect((await send()).status).toBe(200);

    // close() releases the handle — the same state a wedged database presents.
    // Awaited: the handle goes only once the scratch prune pass has ended.
    await wired.close();
    const res = await send();
    expect(res.status).toBe(503);
    const body = await res.json();
    // Fails minimal: the route is public, so the body says unhealthy and
    // nothing else.
    expect(body).toEqual({ status: "unhealthy" });
  });
});
