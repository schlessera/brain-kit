import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { parseSigned, serializeSigned } from "hono/utils/cookie";

import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import {
  createPrincipal,
  resolveAmbientPrincipal,
  resolvePrincipal,
  revokePrincipal,
  type Principal,
} from "../src/db/principals";
import {
  authGuard,
  authRoutes,
  issueSessionCookie,
  resolveCookiePrincipal,
  type AuthRuntime,
} from "../src/middleware/auth";
import { ClientSet, type WSContext } from "../src/ws/clients";
import { createRecordingObservability } from "../src/observability/index";

const SECRET = "test-cookie-secret-0123456789abcdef";
const COOKIE_NAME = "brain_ui_session";
const DB_PATH = join(tmpdir(), `session-cookie-test-${process.pid}.db`);
const BASE_NOW = 2_000_000_000_000;

let db: Database;

beforeAll(() => {
  db = createUiDb(DB_PATH);
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(DB_PATH + suffix, { force: true });
  }
});

beforeEach(() => {
  db.exec("DELETE FROM principals; DELETE FROM settings;");
});

function runtime(): AuthRuntime {
  const config = resolveServerConfig({
    AUTH_MODE: "password",
    BRAIN_UI_PASSWORD_HASH: "test-password-hash",
    COOKIE_SECRET: SECRET,
  });
  return { ...config.auth, host: config.host };
}

function create(ttlSeconds = 3_600): Principal {
  return createPrincipal(db, {
    authMethod: "password",
    label: "Test browser",
    ttlSeconds,
  });
}

async function signedCookie(payload: string): Promise<string> {
  return serializeSigned(COOKIE_NAME, payload, SECRET);
}

async function issueCookie(principalId: string): Promise<{
  cookie: string;
  setCookie: string;
}> {
  const app = new Hono();
  app.get("/", async (c) => {
    await issueSessionCookie(c, runtime(), db, principalId);
    return c.json({ ok: true });
  });
  const response = await app.request("/");
  const setCookie = response.headers.get("set-cookie")!;
  return { cookie: setCookie.split(";")[0]!, setCookie };
}

async function authenticate(
  cookie: string | undefined,
  database: Database = db
): Promise<{ response: Response; principal: Principal | null }> {
  let principal: Principal | null = null;
  const app = new Hono();
  app.onError((error) => {
    throw error;
  });
  app.get("/", async (c) => {
    principal = await resolveCookiePrincipal(c, runtime(), database);
    return c.json({ principalId: principal?.id ?? null }, principal ? 200 : 401);
  });
  const response = await app.request("/", {
    headers: cookie ? { cookie } : undefined,
  });
  return { response, principal };
}

function countingDatabase(database: Database): {
  db: Database;
  count: () => number;
  reset: () => void;
} {
  let calls = 0;
  const counted = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return ((sql: string) => {
          calls++;
          return target.prepare(sql);
        }) as Database["prepare"];
      }
      if (property === "query") {
        return ((sql: string) => {
          calls++;
          return target.query(sql);
        }) as Database["query"];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
  return {
    db: counted,
    count: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

describe("principal session cookie", () => {
  test("a freshly minted cookie resolves the principal it was minted for", async () => {
    const principal = create();
    const { cookie } = await issueCookie(principal.id);

    const parsed = await parseSigned(cookie, SECRET, COOKIE_NAME);
    expect(parsed[COOKIE_NAME]).toBe(principal.id);

    const authenticated = await authenticate(cookie);
    expect(authenticated.response.status).toBe(200);
    expect(authenticated.principal?.id).toBe(principal.id);
  });

  test("a correctly signed v1 issuedAt.epoch cookie is rejected", async () => {
    const cookie = await signedCookie(`${Date.now()}.0`);
    const authenticated = await authenticate(cookie);

    expect(authenticated.response.status).toBe(401);
    expect(authenticated.principal).toBeNull();
  });

  test("a signed cookie naming an ambient principal is rejected", async () => {
    const ambient = resolveAmbientPrincipal(
      db,
      "none",
      "No authentication",
      "No authentication"
    );
    const authenticated = await authenticate(await signedCookie(ambient.id));

    expect(authenticated.response.status).toBe(401);
    expect(authenticated.principal).toBeNull();
  });

  test("editing the id but retaining the original signature is rejected", async () => {
    const principal = create();
    const other = create();
    const original = await signedCookie(principal.id);
    const encodedValue = original.slice(`${COOKIE_NAME}=`.length);
    const value = decodeURIComponent(encodedValue);
    const signature = value.slice(value.lastIndexOf("."));
    const edited = `${COOKIE_NAME}=${encodeURIComponent(other.id + signature)}`;

    const authenticated = await authenticate(edited);
    expect(authenticated.response.status).toBe(401);
    expect(authenticated.principal).toBeNull();
  });

  test("unknown, revoked, and expired principals are rejected after their cookies worked", async () => {
    const unknown = create();
    const revoked = create();
    const expired = create();
    const healthy = create();
    const cookies = new Map<string, string>();
    for (const principal of [unknown, revoked, expired, healthy]) {
      const { cookie } = await issueCookie(principal.id);
      cookies.set(principal.id, cookie);
      expect((await authenticate(cookie)).response.status).toBe(200);
    }

    db.prepare("DELETE FROM principals WHERE id = ?").run(unknown.id);
    revokePrincipal(db, revoked.id, Date.now());
    db.prepare("UPDATE principals SET expires_at = ? WHERE id = ?").run(
      Date.now() - 1,
      expired.id
    );

    for (const principal of [unknown, revoked, expired]) {
      const authenticated = await authenticate(cookies.get(principal.id));
      expect(authenticated.response.status).toBe(401);
      expect(authenticated.principal).toBeNull();
    }

    const control = await authenticate(cookies.get(healthy.id));
    expect(control.response.status).toBe(200);
    expect(control.principal?.id).toBe(healthy.id);
  });

  test("a corrupt row throws only for the principal that names it", async () => {
    const corrupt = create();
    const healthy = create();
    db.prepare("UPDATE principals SET expires_at = ? WHERE id = ?").run(
      "not-an-integer",
      corrupt.id
    );

    await expect(authenticate(await signedCookie(corrupt.id))).rejects.toThrow(
      /Corrupt principal.*expires_at/
    );

    const authenticated = await authenticate(await signedCookie(healthy.id));
    expect(authenticated.response.status).toBe(200);
    expect(authenticated.principal?.id).toBe(healthy.id);
  });

  test("signature and shape failures perform no database queries", async () => {
    const principal = create();
    const original = await signedCookie(principal.id);
    const value = decodeURIComponent(original.slice(`${COOKIE_NAME}=`.length));
    const signature = value.slice(value.lastIndexOf("."));
    const badSignature = `${COOKIE_NAME}=${encodeURIComponent(
      "B".repeat(22) + signature
    )}`;
    const v1Cookie = await signedCookie(`${Date.now()}.0`);
    const counted = countingDatabase(db);

    expect((await authenticate(badSignature, counted.db)).response.status).toBe(401);
    expect(counted.count()).toBe(0);

    counted.reset();
    expect((await authenticate(v1Cookie, counted.db)).response.status).toBe(401);
    expect(counted.count()).toBe(0);
  });

  test("Set-Cookie maxAge is derived from the principal expiry", async () => {
    const originalNow = Date.now;
    Date.now = () => BASE_NOW;
    try {
      const principal = create(321);
      Date.now = () => BASE_NOW + 100_000;
      const first = await issueCookie(principal.id);

      expect(first.setCookie).toContain("Max-Age=221");
      expect(first.setCookie).not.toContain("Max-Age=321");

      db.prepare("UPDATE principals SET expires_at = ? WHERE id = ?").run(
        BASE_NOW + 180_000,
        principal.id
      );
      const changed = await issueCookie(principal.id);

      expect(changed.setCookie).toContain("Max-Age=80");
    } finally {
      Date.now = originalNow;
    }
  });

  test("successful validation touches last_seen_at at most once per 60 seconds", async () => {
    const originalNow = Date.now;
    let now = BASE_NOW;
    Date.now = () => now;
    try {
      const principal = create();
      const cookie = await signedCookie(principal.id);

      expect((await authenticate(cookie)).response.status).toBe(200);
      expect(resolvePrincipal(db, principal.id)?.lastSeenAt).toBe(BASE_NOW);

      now += 60_000;
      expect((await authenticate(cookie)).response.status).toBe(200);
      expect(resolvePrincipal(db, principal.id)?.lastSeenAt).toBe(BASE_NOW);

      now++;
      expect((await authenticate(cookie)).response.status).toBe(200);
      expect(resolvePrincipal(db, principal.id)?.lastSeenAt).toBe(now);
    } finally {
      Date.now = originalNow;
    }
  });

  test("logout revokes every principal and retains the v1 downgrade guard", async () => {
    const clients = new ClientSet();
    const closed: Array<[number | undefined, string | undefined]> = [];
    const socket: WSContext = {
      send() {},
      close(code, reason) {
        closed.push([code, reason]);
      },
    };
    const auth = runtime();
    const app = new Hono();
    app.route(
      "/api",
      authRoutes("password", auth, {
        db,
        clients,
        verifyPassword: async () => true,
      })
    );
    app.use("/api/*", authGuard("password", auth, db));
    app.get("/api/secret", (c) => c.json({ ok: true }));

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "accepted by injected verifier" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const principalId = (
      db.query("SELECT id FROM principals WHERE revoked_at IS NULL").get() as { id: string }
    ).id;
    expect(clients.add(socket, principalId)).toBe(true);
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(200);

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(200);
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(401);
    expect(
      db.query("SELECT COUNT(*) AS count FROM principals WHERE revoked_at IS NULL").get()
    ).toEqual({ count: 0 });
    expect(
      db.query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'").get()
    ).toEqual({ value: "1" });
    expect(closed).toEqual([[1008, "Sessions invalidated"]]);
  });

  test("a rejected cookie cannot revoke principals through logout", async () => {
    const principal = create();
    const clients = new ClientSet();
    const auth = runtime();
    const app = new Hono();
    app.route(
      "/api",
      authRoutes("password", auth, {
        db,
        clients,
        verifyPassword: async () => false,
      })
    );

    const response = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: await signedCookie(`${Date.now()}.0`) },
    });

    expect(response.status).toBe(401);
    expect(resolvePrincipal(db, principal.id)?.revokedAt).toBeNull();
    expect(
      db.query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'").get()
    ).toBeNull();
  });

  test("logout still revokes sessions when the legacy epoch row is corrupt", async () => {
    const principal = create();
    const cookie = await signedCookie(principal.id);
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('auth.sessionsEpoch', 'not-json', ?)`
    ).run(Date.now());
    const observability = createRecordingObservability();
    const auth = runtime();
    const app = new Hono();
    app.route(
      "/api",
      authRoutes("password", auth, {
        db,
        clients: new ClientSet(),
        log: observability.logger("auth"),
      })
    );
    app.use("/api/*", authGuard("password", auth, db));
    app.get("/api/secret", (c) => c.json({ ok: true }));

    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(
      200
    );
    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });

    expect(logout.status).toBe(200);
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(
      401
    );
    expect(resolvePrincipal(db, principal.id)?.revokedAt).not.toBeNull();
    expect(
      observability.logs.count({
        body: "legacy session epoch is corrupt; downgrade guard was not advanced",
      })
    ).toBe(1);
  });
});
