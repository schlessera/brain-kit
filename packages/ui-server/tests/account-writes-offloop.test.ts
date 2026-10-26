/** Account/security administration commits on the shared FULL writer (#3002). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import type { AppEnv } from "../src/app-env.js";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createPrincipal, PrincipalCreatorNotUsableError, PrincipalCredentialNotFoundError, PrincipalLimitError, resolvePrincipal } from "../src/db/principals.js";
import { accountWrites, registerAccountWrites } from "../src/db/account-writes.js";
import { registerPrincipalWrites } from "../src/db/principal-writes.js";
import { createReferenceGrant, ReferenceGrantDuplicateError, ReferenceGrantPrincipalError, ReferenceRepositoryError } from "../src/db/reference-grants.js";
import { principalManagementRoutes } from "../src/middleware/principals.js";
import { authGuard, authRoutes, createLoginRateLimiter, type AuthRuntime } from "../src/middleware/auth.js";
import { createPasskeyChallenges, passkeyManagementRoutes, passkeyPublicRoutes, type PasskeyContext, type PasskeyDeps } from "../src/middleware/passkeys.js";
import { createAccountPartitionKeys } from "../src/middleware/account-partition.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { createPushRoutes } from "../src/routes/push.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import type { ActivityNotifier } from "../src/activity/notify.js";
import { WsHost } from "../src/ws/host.js";

const config = resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "odysseus-password-hash",
  COOKIE_SECRET: "odysseus-cookie-secret-0123456789abcdef" });
const auth: AuthRuntime = { ...config.auth, host: config.host };
const revoker = { revokePrincipals() {} };

function fixture(revokerOverride: Pick<WsHost, "revokePrincipals"> = revoker) {
  const root = mkdtempSync(join(tmpdir(), "account-writes-odysseus-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const owner = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Athena", createdBy: owner.id, ttlSeconds: 3600 });
  registerPrincipalWrites(db, writer);
  registerAccountWrites(db, writer);
  const app = new Hono<AppEnv>().use("*", async (c, next) => { c.set("principal", owner); await next(); });
  app.onError((error, c) => c.json({ error: error.message }, 500));
  app.route("/api", principalManagementRoutes("password", auth, { db, revoker: revokerOverride, brain: "ithaca" }));
  return { root, db, writer, owner, agent, app,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

for (const operation of ["mint", "revoke", "grant", "revokeGrant"] as const) {
  test(`account ${operation} commits on the write worker at FULL, never on the app connection`, async () => {
    const f = fixture();
    try {
      const grant = operation === "revokeGrant" ? createReferenceGrant(f.db, { brain: "ithaca", principalId: f.agent.id,
        repositoryPrefix: "https://github.com/odysseus", credential: null, createdBy: f.owner.id, now: Date.now() }) : null;
      const sites = await watchWriteSites(f.db, f.writer, ["principals", "reference_grants"]);
      expect(f.writer.offloop).toBe(true);
      const response = operation === "mint" ? await f.app.request("/api/auth/principals", json("POST", { label: "Telemachus" }))
        : operation === "revoke" ? await f.app.request(`/api/auth/principals/${f.agent.id}`, json("DELETE"))
          : operation === "grant" ? await f.app.request(`/api/auth/principals/${f.agent.id}/reference-grants`, json("POST", { repositoryPrefix: "https://github.com/odysseus" }))
            : await f.app.request(`/api/auth/principals/${f.agent.id}/reference-grants/${grant!.id}`, json("DELETE"));
      const body = await response.json();
      expect({ status: response.status, body }, `ACCOUNT_${operation.toUpperCase()}_COMMITTED_BEFORE_HTTP_RESPONSE`)
        .toMatchObject({ status: operation === "grant" ? 201 : 200 });
      expect(await sites.log(), `ACCOUNT_${operation.toUpperCase()}_WRITES_ON_WORKER`)
        .toContain(operation === "grant" || operation === "revokeGrant" ? "reference_grants" : "principals");
      if (operation === "revoke") expect(resolvePrincipal(f.db, f.agent.id)?.revokedAt, "ACCOUNT_REVOCATION_COMMITTED").not.toBeNull();
    } finally { await f.close(); }
  });
}

for (const operation of ["publicKey", "subscribe", "unsubscribe", "unbindPrincipal"] as const) {
  test(`push ${operation} commits on the write worker at FULL, never on the app connection`, async () => {
    const f = fixture();
    try {
      const sender = createPushSender(f.db, { writer: f.writer });
      const sub = { endpoint: "https://push.example.test/ithaca", keys: { p256dh: "bow", auth: "loom" } };
      if (operation === "unsubscribe" || operation === "unbindPrincipal") await sender.subscribe(sub, f.owner.id);
      const sites = await watchWriteSites(f.db, f.writer, ["push_subscriptions", "vapid_keys"]);
      const result = operation === "publicKey" ? await sender.publicKey()
        : operation === "subscribe" ? await sender.subscribe(sub, f.owner.id)
          : operation === "unsubscribe" ? await sender.unsubscribe(sub.endpoint, f.owner.id) : await sender.unbindPrincipal(f.owner.id);
      expect(result, `PUSH_${operation.toUpperCase()}_COMMITTED`).toBeTruthy();
      expect(await sites.log(), `PUSH_${operation.toUpperCase()}_WRITES_ON_WORKER`)
        .toEqual([operation === "publicKey" ? "vapid_keys" : "push_subscriptions"]);
    } finally { await f.close(); }
  });
}

test("a revocation route waits behind the worker and every authentication after its answer refuses the principal", async () => {
  const f = fixture();
  try {
    const cookie = await serializeSigned("brain_ui_session", f.agent.id, auth.cookieSecret!);
    const app = new Hono<AppEnv>().use("/api/*", authGuard("password", auth, f.db))
      .get("/api/who", c => c.json({ id: c.get("principal")!.id }));
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 250);
    let answered = false;
    const response = Promise.resolve(f.app.request(`/api/auth/principals/${f.agent.id}`, json("DELETE"))).then(r => { answered = true; return r; });
    // Let the asynchronous HTTP handler submit while the worker is held.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(answered, "ACCOUNT_REVOCATION_HTTP_WAITS_FOR_COMMIT").toBe(false);
    await slow;
    expect((await response).status, "ACCOUNT_REVOCATION_HTTP_SUCCEEDS").toBe(200);
    for (let i = 0; i < 3; i++) expect((await app.request("/api/who", { headers: { cookie } })).status,
      "ACCOUNT_REVOKED_PRINCIPAL_NEVER_AUTHENTICATES_AFTER_RESPONSE").toBe(401);
  } finally { await f.close(); }
});

test("push HTTP routes await subscription commits and key creation", async () => {
  const f = fixture();
  try {
    const sender = createPushSender(f.db, { writer: f.writer });
    f.app.route("/api", createPushRoutes({ sender }));
    const sites = await watchWriteSites(f.db, f.writer, ["push_subscriptions", "vapid_keys"]);
    const key = await f.app.request("/api/push/public-key");
    expect(await key.json(), "PUSH_KEY_HTTP_AWAITS_COMMIT").toMatchObject({ publicKey: expect.any(String) });
    const sub = { endpoint: "https://push.example.test/ithaca", keys: { p256dh: "bow", auth: "loom" } };
    expect((await f.app.request("/api/push/subscribe", json("POST", { subscription: sub }))).status).toBe(200);
    expect(sender.subscriptions(f.owner.id), "PUSH_SUBSCRIBE_HTTP_AWAITS_COMMIT").toHaveLength(1);
    expect(await (await f.app.request("/api/push/unsubscribe", json("POST", { endpoint: sub.endpoint }))).json(),
      "PUSH_UNSUBSCRIBE_HTTP_AWAITS_COMMIT").toEqual({ removed: true });
    expect(await sites.log(), "PUSH_HTTP_WRITES_ON_WORKER").toEqual(["vapid_keys", "push_subscriptions", "push_subscriptions"]);
  } finally { await f.close(); }
});

function passkeys(f: ReturnType<typeof fixture>) {
  const failures: string[] = [];
  const ctx: PasskeyContext = { log: { emit: record => { failures.push(String(record.attributes?.error ?? record.body)); } }, db: f.db, auth, revoker, rateLimiter: createLoginRateLimiter(), challenges: createPasskeyChallenges(),
    webauthn: config.webauthn, allowedOrigins: ["http://localhost"] };
  const deps: PasskeyDeps = {
    verifyRegistrationResponse: (async () => ({ verified: true, registrationInfo: {
      fmt: "none", credentialType: "public-key", attestationObject: new Uint8Array(), userVerified: true, origin: "http://localhost",
      aaguid: "ithaca", credential: { id: "odysseus-bow", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "multiDevice", credentialBackedUp: true,
    } })),
    verifyAuthenticationResponse: (async () => ({ verified: true, authenticationInfo: { credentialID: "odysseus-bow", newCounter: 7, userVerified: true,
      credentialDeviceType: "multiDevice", credentialBackedUp: true, origin: "http://localhost", rpID: "localhost" } })),
  };
  f.app.route("/api", passkeyPublicRoutes("password", ctx, deps));
  f.app.route("/api", passkeyManagementRoutes("password", ctx, deps));
  const ceremony = (type: "registration" | "authentication") => {
    const challenge = `ithaca-${type}`;
    ctx.challenges.putChallenge(challenge, type, Date.now());
    return { id: "odysseus-bow", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString("base64url") } };
  };
  const request = (path: string, method: string, body?: unknown) => f.app.request(path, { ...json(method, body),
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" } });
  const register = () => request("/api/auth/passkey/register-verify", "POST", { response: ceremony("registration"), label: "Odysseus' bow" });
  return { ceremony, request, register, failures };
}

for (const operation of ["register", "counter", "label", "delete"] as const) {
  test(`passkey ${operation} commits on the write worker at FULL, never on the app connection`, async () => {
    const f = fixture();
    try {
      const keys = passkeys(f);
      if (operation !== "register") expect((await keys.register()).status, "PASSKEY_FIXTURE_REGISTERED").toBe(200);
      const principal = operation === "delete" ? await accountWrites(f.db).createPrincipal({ authMethod: "passkey", label: "Odysseus",
        credentialId: "odysseus-bow", ttlSeconds: 3600 }) : null;
      const sites = await watchWriteSites(f.db, f.writer, ["passkey_credentials", "principals"]);
      const response = operation === "register" ? await keys.register() : operation === "counter"
        ? await keys.request("/api/auth/passkey/login-verify", "POST", keys.ceremony("authentication"))
        : await keys.request("/api/auth/passkey/odysseus-bow", operation === "delete" ? "DELETE" : "PUT", { label: "Ithaca" });
      const body = await response.json();
      expect({ status: response.status, body, failures: keys.failures }, `PASSKEY_${operation.toUpperCase()}_HTTP_AWAITS_COMMIT`).toMatchObject({ status: 200 });
      const row = f.db.query("SELECT counter, label FROM passkey_credentials WHERE id = 'odysseus-bow'").get();
      expect(row, `PASSKEY_${operation.toUpperCase()}_READ_SEES_COMMIT`).toEqual(operation === "delete" ? null : {
        counter: operation === "counter" ? 7 : 0, label: operation === "label" ? "Ithaca" : "Odysseus' bow",
      });
      const log = await sites.log();
      expect(log[0], `PASSKEY_${operation.toUpperCase()}_WRITES_ON_WORKER`).toBe("passkey_credentials");
      if (operation === "delete") {
        expect(log, "PASSKEY_DELETE_BEFORE_SESSION_REVOCATION").toEqual(["passkey_credentials", "principals"]);
        expect(resolvePrincipal(f.db, principal!.id)?.revokedAt, "PASSKEY_SESSION_REVOKED_BEFORE_RESPONSE").not.toBeNull();
      }
    } finally { await f.close(); }
  });
}

for (const who of ["owner", "agent"] as const) {
  test(`${who} logout awaits its revocation on the FULL worker`, async () => {
    const f = fixture();
    try {
      f.app.route("/api", authRoutes("password", auth, { db: f.db, revoker, rateLimiter: createLoginRateLimiter() }));
      const sites = await watchWriteSites(f.db, f.writer, ["principals"]);
      const cookie = await serializeSigned("brain_ui_session", f[who].id, auth.cookieSecret!);
      const response = await f.app.request("/api/auth/logout", { method: "POST", headers: { cookie } });
      expect({ status: response.status, body: await response.json() }, `ACCOUNT_LOGOUT_${who.toUpperCase()}_HTTP_AWAITS_COMMIT`).toMatchObject({ status: 200 });
      expect(resolvePrincipal(f.db, f[who].id)?.revokedAt, "ACCOUNT_LOGOUT_DURABLE_REVOCATION").not.toBeNull();
      expect(await sites.log(), "ACCOUNT_LOGOUT_WRITES_ON_WORKER").toContain("principals");
      if (who === "owner") expect(resolvePrincipal(f.db, f.agent.id)?.revokedAt, "ACCOUNT_OWNER_LOGOUT_REVOKES_ALL").not.toBeNull();
    } finally { await f.close(); }
  });
}

test("the partition seed commits on the FULL worker and concurrent first uses share it", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["settings"]);
    const writes = accountWrites(f.db);
    const [first, raced] = await Promise.all([writes.partitionSeed(), writes.partitionSeed()]);
    expect(first, "ACCOUNT_PARTITION_SEED_FORMAT").toMatch(/^[0-9a-f]{64}$/);
    expect(first, "ACCOUNT_PARTITION_SEED_RACE_USES_COMMIT").toBe(raced);
    const key = createAccountPartitionKeys(f.db, f.root, "password", first);
    expect(key(f.owner), "ACCOUNT_PARTITION_KEY_READS_WORKER_SEED").toBe(createAccountPartitionKeys(f.db, f.root, "password")(f.owner));
    expect(await sites.log(), "ACCOUNT_PARTITION_SEED_INSERTED_ONCE_ON_WORKER").toEqual(["settings"]);
  } finally { await f.close(); }
});

test("two delivery passes racing the key route create VAPID once and all use the committed pair", async () => {
  const f = fixture();
  try {
    const sent: Array<{ publicKey: string; privateKey: string }> = [];
    const sender = createPushSender(f.db, { writer: f.writer, send: async (_sub, _body, options) => { sent.push(options.vapidDetails); } });
    await sender.subscribe({ endpoint: "https://push.example.test/ithaca", keys: { p256dh: "bow", auth: "loom" } }, f.owner.id);
    const sites = await watchWriteSites(f.db, f.writer, ["vapid_keys"]);
    const notifier = { pending: () => [{ id: 1, runId: "ithaca", title: "Ithaca", body: "Ready" }], markDelivered: async () => {} } as unknown as ActivityNotifier;
    f.app.route("/api", createPushRoutes({ sender }));
    const [one, two, response] = await Promise.all([sender.deliverPending(notifier), sender.deliverPending(notifier), f.app.request("/api/push/public-key")]);
    const key = await response.json() as { publicKey: string };
    expect([one, two], "PUSH_RACING_PASSES_BOTH_SEND").toEqual([1, 1]);
    expect(sent.map(pair => pair.publicKey), "PUSH_VAPID_RACE_SHARES_PUBLIC_KEY").toEqual([key.publicKey, key.publicKey]);
    expect(sent[0]?.privateKey, "PUSH_VAPID_RACE_SHARES_PRIVATE_KEY").toBe(sent[1]?.privateKey);
    expect(await sites.log(), "PUSH_VAPID_RACE_INSERTS_ONCE").toEqual(["vapid_keys"]);
  } finally { await f.close(); }
});

test("account worker refusals retain their classes and reference-grant HTTP statuses", async () => {
  const f = fixture();
  try {
    const writes = accountWrites(f.db);
    const input = { brain: "ithaca", principalId: f.agent.id, repositoryPrefix: "https://github.com/odysseus", credential: null, createdBy: f.owner.id, now: Date.now() };
    await writes.createGrant(input);
    await expectRejection(writes.createGrant(input), ReferenceGrantDuplicateError, "ACCOUNT_GRANT_DUPLICATE_CLASS");
    await expectRejection(writes.createGrant({ ...input, principalId: "missing" }), ReferenceGrantPrincipalError, "ACCOUNT_GRANT_PRINCIPAL_CLASS");
    await expectRejection(writes.createGrant({ ...input, repositoryPrefix: "invalid" }), ReferenceRepositoryError, "ACCOUNT_GRANT_REPOSITORY_CLASS");
    for (const [id, repositoryPrefix, status] of [[f.agent.id, input.repositoryPrefix, 409], ["missing", input.repositoryPrefix, 404], [f.agent.id, "invalid", 400]] as const) {
      expect((await f.app.request(`/api/auth/principals/${id}/reference-grants`, json("POST", { repositoryPrefix }))).status,
        "ACCOUNT_GRANT_HTTP_REFUSAL_STATUS").toBe(status);
    }
  } finally { await f.close(); }
});


test("queued administration rechecks owner authority and preserves principal refusal classes and statuses", async () => {
  const f = fixture();
  try {
    const writes = accountWrites(f.db);
    await expectRejection(writes.createPrincipal({ authMethod: "passkey", label: "Odysseus", credentialId: "missing", ttlSeconds: 3600 }),
      PrincipalCredentialNotFoundError, "ACCOUNT_CREDENTIAL_REFUSAL_CLASS");
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 150);
    const revocation = writes.revokePrincipal(f.owner.id, Date.now());
    const minted = writes.createPrincipal({ authMethod: "delegated", label: "Telemachus", createdBy: f.owner.id, ttlSeconds: 3600 });
    await expectRejection(minted, PrincipalCreatorNotUsableError, "ACCOUNT_CREATOR_REFUSAL_CLASS");
    await slow; await revocation;
    expect((await f.app.request("/api/auth/principals", json("POST", { label: "Telemachus" }))).status, "ACCOUNT_CREATOR_REFUSAL_HTTP_STATUS").toBe(403);
    expect((await f.app.request(`/api/auth/principals/${f.agent.id}/reference-grants`, json("POST", { repositoryPrefix: "https://github.com/odysseus" }))).status,
      "ACCOUNT_GRANT_RECHECKS_REVOKED_CREATOR").toBe(404);
  } finally { await f.close(); }
});

test("principal capacity refusal keeps its class and 503 across the account worker", async () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 98; i++) createPrincipal(f.db, { authMethod: "password", label: "Ithaca", ttlSeconds: 3600 });
    }).immediate();
    await expectRejection(accountWrites(f.db).createPrincipal({ authMethod: "password", label: "Odysseus", ttlSeconds: 3600 }),
      PrincipalLimitError, "ACCOUNT_CAPACITY_REFUSAL_CLASS");
    expect((await f.app.request("/api/auth/principals", json("POST", { label: "Telemachus" }))).status, "ACCOUNT_CAPACITY_REFUSAL_HTTP_STATUS").toBe(503);
  } finally { await f.close(); }
});

test("revocation disconnects immediately and HTTP awaits the host's push unbinding commit", async () => {
  let submitted!: () => void, release!: () => void;
  const submission = new Promise<void>(resolve => { submitted = resolve; });
  const commit = new Promise<number>(resolve => { release = () => resolve(1); });
  const closed: string[] = [];
  const host = { coordinator: { revokePrincipals: () => [] }, clients: { closeFor: (id: string) => closed.push(id) },
    activity: { stream: { dropFor() {} }, pushSender: { unbindPrincipal: () => { submitted(); return commit; } } } };
  const f = fixture({ revokePrincipals: (ids, code, reason) => WsHost.prototype.revokePrincipals.call(host as unknown as WsHost, ids, code, reason) });
  try {
    let answered = false;
    const response = Promise.resolve(f.app.request(`/api/auth/principals/${f.agent.id}`, json("DELETE"))).then(r => { answered = true; return r; });
    await submission;
    expect(closed, "ACCOUNT_REVOCATION_DISCONNECTS_BEFORE_UNBIND_COMMIT").toEqual([f.agent.id]);
    expect(answered, "ACCOUNT_REVOCATION_HTTP_AWAITS_PUSH_UNBIND_COMMIT").toBe(false);
    release();
    expect((await response).status, "ACCOUNT_REVOCATION_HTTP_FOLLOWS_UNBIND_COMMIT").toBe(200);
  } finally { release(); await f.close(); }
});

test("a failed push unbind still fails the revocation HTTP response after durable revocation", async () => {
  const f = fixture({ revokePrincipals: async () => { throw new Error("Ithaca push unbind refused"); } });
  try {
    const response = await f.app.request(`/api/auth/principals/${f.agent.id}`, json("DELETE"));
    expect(response.status, "ACCOUNT_UNBIND_REFUSAL_HTTP_STATUS").toBe(500);
    expect(await response.json(), "ACCOUNT_UNBIND_REFUSAL_MESSAGE").toEqual({ error: "Ithaca push unbind refused" });
    expect(resolvePrincipal(f.db, f.agent.id)?.revokedAt, "ACCOUNT_UNBIND_REFUSAL_KEEPS_DURABLE_REVOCATION").not.toBeNull();
  } finally { await f.close(); }
});
