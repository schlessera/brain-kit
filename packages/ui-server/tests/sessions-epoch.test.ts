import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";

import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import { createPrincipal, resolvePrincipal } from "../src/db/principals";
import { authGuard, authRoutes, type AuthRuntime } from "../src/middleware/auth";
import {
  passkeyManagementRoutes,
  passwordLoginDisabled,
  type PasskeyContext,
} from "../src/middleware/passkeys";
import { ClientSet, type WSContext } from "../src/ws/clients";

const PASSWORD = "correct horse battery staple";
const SECRET = "test-cookie-secret-0123456789abcdef";
const DB_PATH = join(tmpdir(), `sessions-epoch-test-${process.pid}.db`);
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
  db.exec("DELETE FROM principals; DELETE FROM settings; DELETE FROM passkey_credentials;");
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
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

function liveSocket(clients: ClientSet, principalId: string): {
  closed: Array<[number | undefined, string | undefined]>;
} {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const ws: WSContext = {
    send() {},
    close(code, reason) {
      closed.push([code, reason]);
    },
  };
  expect(clients.add(ws, principalId)).toBe(true);
  return { closed };
}

function seedCredential(id: string): void {
  db.prepare(
    `INSERT INTO passkey_credentials
       (id, public_key, counter, transports, rp_id, aaguid, device_type,
        backed_up, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
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

describe("passkey credential revocation", () => {
  test("passkey deletion revokes only principals carrying that credential", async () => {
    const clients = new ClientSet();
    const app = sessionApp(clients);
    const passwordCookie = await loginCookie(app);
    const passwordPrincipal = db
      .query("SELECT id FROM principals WHERE auth_method = 'password'")
      .get() as { id: string };
    seedCredential("cred-1");
    seedCredential("cred-2");
    const first = createPrincipal(db, {
      kind: "owner",
      authMethod: "passkey",
      credentialId: "cred-1",
      label: "First passkey session",
      ttlSeconds: 3_600,
    });
    const second = createPrincipal(db, {
      kind: "owner",
      authMethod: "passkey",
      credentialId: "cred-1",
      label: "Second passkey session",
      ttlSeconds: 3_600,
    });
    const other = createPrincipal(db, {
      kind: "owner",
      authMethod: "passkey",
      credentialId: "cred-2",
      label: "Other passkey session",
      ttlSeconds: 3_600,
    });
    const firstCookie = await serializeSigned("brain_ui_session", first.id, SECRET);
    const secondCookie = await serializeSigned("brain_ui_session", second.id, SECRET);
    const otherCookie = await serializeSigned("brain_ui_session", other.id, SECRET);
    const firstSocket = liveSocket(clients, first.id);
    const secondSocket = liveSocket(clients, second.id);
    const passwordSocket = liveSocket(clients, passwordPrincipal.id);
    const otherSocket = liveSocket(clients, other.id);

    const response = await app.request("/api/auth/passkey/cred-1", {
      method: "DELETE",
      headers: { cookie: passwordCookie, origin: ORIGIN, host: "example.test" },
    });

    expect(response.status).toBe(200);
    expect((await app.request("/api/secret", { headers: { cookie: firstCookie } })).status).toBe(401);
    expect((await app.request("/api/secret", { headers: { cookie: secondCookie } })).status).toBe(401);
    expect((await app.request("/api/secret", { headers: { cookie: passwordCookie } })).status).toBe(200);
    expect((await app.request("/api/secret", { headers: { cookie: otherCookie } })).status).toBe(200);
    expect(firstSocket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(secondSocket.closed).toEqual([[1008, "Sessions invalidated"]]);
    expect(passwordSocket.closed).toEqual([]);
    expect(otherSocket.closed).toEqual([]);
    expect(resolvePrincipal(db, first.id)?.revokedAt).not.toBeNull();
    expect(resolvePrincipal(db, second.id)?.revokedAt).not.toBeNull();
    expect(resolvePrincipal(db, passwordPrincipal.id)?.revokedAt).toBeNull();
    expect(resolvePrincipal(db, other.id)?.revokedAt).toBeNull();
    expect(clients.count()).toBe(2);
  });
});
