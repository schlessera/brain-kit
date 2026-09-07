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
  authGuard,
  authRoutes,
  issueSessionCookie,
  type AuthRuntime,
} from "../src/middleware/auth";
import {
  passkeyManagementRoutes,
  passwordLoginDisabled,
  type PasskeyContext,
} from "../src/middleware/passkeys";
import { ClientSet, type WSContext } from "../src/ws/clients";

const PASSWORD = "correct horse battery staple";
const SECRET = "test-cookie-secret-0123456789abcdef";
const DB_PATH = join(tmpdir(), `sessions-epoch-test-${process.pid}.db`);
const COOKIE_NAME = "brain_ui_session";
const ORIGIN = "https://example.test";

let hash = "";
let db: Database;

beforeAll(async () => {
  hash = await Bun.password.hash(PASSWORD);
  db = createUiDb(DB_PATH);
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(DB_PATH + suffix, { force: true });
  }
});

beforeEach(() => {
  db.exec("DELETE FROM settings; DELETE FROM passkey_credentials;");
});

function runtime(): AuthRuntime {
  const config = resolveServerConfig({
    AUTH_MODE: "password",
    BRAIN_UI_PASSWORD_HASH: hash,
    COOKIE_SECRET: SECRET,
    TRUST_PROXY: "1",
  });
  return { ...config.auth, host: config.host };
}

function sessionApp(clients = new ClientSet()): Hono {
  const auth = runtime();
  const config = resolveServerConfig({
    AUTH_MODE: "password",
    BRAIN_UI_PASSWORD_HASH: hash,
    COOKIE_SECRET: SECRET,
    TRUST_PROXY: "1",
  });
  const passkeyContext: PasskeyContext = {
    db,
    clients,
    webauthn: config.webauthn,
    auth,
    allowedOrigins: [],
  };
  const app = new Hono();
  app.route(
    "/api",
    authRoutes("password", auth, {
      db,
      clients,
      passwordDisabled: (c) => passwordLoginDisabled(c, passkeyContext),
      verifyPassword: async (password) => password === PASSWORD,
    })
  );
  app.use("/api/*", authGuard("password", auth, db));
  app.route("/api", passkeyManagementRoutes("password", passkeyContext));
  app.get("/api/secret", (c) => c.json({ ok: true }));
  return app;
}

async function loginCookie(app: Hono): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "10.0.0.1",
      host: "example.test",
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function signedCookie(payload: string): Promise<string> {
  return serializeSigned(COOKIE_NAME, payload, SECRET);
}

function epochRow(): string | null {
  const row = db
    .query("SELECT value FROM settings WHERE key = 'auth.sessionsEpoch'")
    .get() as { value: string } | null;
  return row?.value ?? null;
}

function setEpoch(value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('auth.sessionsEpoch', ?, ?)"
  ).run(value, Date.now());
}

function liveSocket(clients: ClientSet): {
  ws: WSContext;
  closed: Array<[number | undefined, string | undefined]>;
} {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const ws: WSContext = {
    send() {},
    close(code, reason) {
      closed.push([code, reason]);
    },
  };
  expect(clients.add(ws)).toBe(true);
  return { ws, closed };
}

function seedCredential(): void {
  db.prepare(
    `INSERT INTO passkey_credentials
       (id, public_key, counter, transports, rp_id, aaguid, device_type,
        backed_up, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "cred-1",
    new Uint8Array([1, 2, 3]),
    0,
    JSON.stringify(["internal"]),
    "example.test",
    "aaguid-1",
    "multiDevice",
    1,
    "Test key",
    1_000
  );
}

describe("sessions epoch", () => {
  test("logout invalidates the old cookie on the next request and closes sockets", async () => {
    const clients = new ClientSet();
    const socket = liveSocket(clients);
    const app = sessionApp(clients);
    const cookie = await loginCookie(app);
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(200);

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });

    expect(logout.status).toBe(200);
    expect(epochRow()).toBe("1");
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(401);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(clients.count()).toBe(0);
  });

  test("passkey revocation invalidates the old cookie and closes sockets", async () => {
    const clients = new ClientSet();
    const socket = liveSocket(clients);
    const app = sessionApp(clients);
    const cookie = await loginCookie(app);
    seedCredential();

    const response = await app.request("/api/auth/passkey/cred-1", {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN, host: "example.test" },
    });

    expect(response.status).toBe(200);
    expect(epochRow()).toBe("1");
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(401);
    expect(socket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(clients.count()).toBe(0);
  });

  test("a pre-epoch cookie is rejected", async () => {
    const app = sessionApp();
    const cookie = await signedCookie(String(Date.now()));
    expect((await app.request("/api/secret", { headers: { cookie } })).status).toBe(401);
  });

  test("an issuedAt.epoch payload round-trips through Hono signed cookies", async () => {
    setEpoch("7");
    const issuer = new Hono();
    issuer.get("/issue", async (c) => {
      await issueSessionCookie(c, runtime(), db);
      return c.json({ ok: true });
    });
    const issued = await issuer.request("/issue");
    const cookie = issued.headers.get("set-cookie")!.split(";")[0];
    const parsed = await parseSigned(cookie, SECRET, COOKIE_NAME);
    expect(parsed[COOKIE_NAME]).toMatch(/^\d+\.7$/);
    expect((await sessionApp().request("/api/secret", { headers: { cookie } })).status).toBe(200);
  });

  for (const invalid of [
    {
      label: "no cookie",
      prepare: async () => ({ cookie: undefined, expectedEpoch: null }),
    },
    {
      label: "a malformed cookie",
      prepare: async () => ({ cookie: `${COOKIE_NAME}=garbage`, expectedEpoch: null }),
    },
    {
      label: "an expired cookie",
      prepare: async () => ({
        cookie: await signedCookie(`${Date.now() - 31 * 24 * 60 * 60 * 1_000}.0`),
        expectedEpoch: null,
      }),
    },
    {
      label: "a previously revoked cookie",
      prepare: async () => {
        setEpoch("2");
        return { cookie: await signedCookie(`${Date.now()}.1`), expectedEpoch: "2" };
      },
    },
  ]) {
    test(`${invalid.label} cannot advance the epoch or close sockets through logout`, async () => {
      const clients = new ClientSet();
      const socket = liveSocket(clients);
      const app = sessionApp(clients);
      const { cookie, expectedEpoch } = await invalid.prepare();

      const response = await app.request("/api/auth/logout", {
        method: "POST",
        headers: cookie ? { cookie } : undefined,
      });

      expect(response.status).toBe(401);
      expect(epochRow()).toBe(expectedEpoch);
      expect(socket.closed).toHaveLength(0);
      expect(clients.count()).toBe(1);
    });
  }

  test("a previously revoked cookie cannot revoke a passkey or mutate auth state", async () => {
    setEpoch("2");
    seedCredential();
    const clients = new ClientSet();
    const socket = liveSocket(clients);
    const cookie = await signedCookie(`${Date.now()}.1`);

    const response = await sessionApp(clients).request("/api/auth/passkey/cred-1", {
      method: "DELETE",
      headers: { cookie, origin: ORIGIN, host: "example.test" },
    });

    expect(response.status).toBe(401);
    expect(epochRow()).toBe("2");
    expect(
      db.query("SELECT COUNT(*) AS count FROM passkey_credentials WHERE id = 'cred-1'").get()
    ).toEqual({ count: 1 });
    expect(socket.closed).toHaveLength(0);
    expect(clients.count()).toBe(1);
  });

  test("only an absent epoch row reads as zero", async () => {
    const app = new Hono();
    app.get("/issue", async (c) => {
      await issueSessionCookie(c, runtime(), db);
      return c.json({ ok: true });
    });

    const response = await app.request("/issue");
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const parsed = await parseSigned(cookie, SECRET, COOKIE_NAME);
    expect(parsed[COOKIE_NAME]).toMatch(/^\d+\.0$/);
  });

  for (const [label, value] of [
    ["unparsable JSON", "not-json"],
    ["a non-integer JSON value", JSON.stringify("zero")],
  ] as const) {
    test(`a corrupt epoch row (${label}) refuses instead of reading as zero`, async () => {
      setEpoch(value);
      await expect(issueSessionCookie({} as never, runtime(), db)).rejects.toThrow(
        /Corrupt auth\.sessionsEpoch/
      );
    });
  }
});
