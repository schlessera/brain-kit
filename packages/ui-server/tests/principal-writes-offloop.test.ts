/** Authentication's per-request principal writes commit on the write worker (#2850). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createPrincipal, PrincipalCredentialNotFoundError, resolvePrincipal, type Principal } from "../src/db/principals.js";
import { principalWrites, registerPrincipalWrites } from "../src/db/principal-writes.js";
import { authGuard, issueSessionCookie, resolveCookiePrincipal, type AuthRuntime } from "../src/middleware/auth.js";
import { resolveServerConfig } from "../src/config/env.js";
import type { AppEnv } from "../src/app-env.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import { watchWriteSites } from "./helpers/write-sites.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "principal-writes-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db);
  return { root, db, writer, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const lastSeen = (f: ReturnType<typeof fixture>, id: string) => (f.db.query("SELECT last_seen_at AS at FROM principals WHERE id = ?").get(id) as { at: number | null }).at;

test("request-path principal writes commit on the write worker at FULL, never on the app connection", async () => {
  const f = fixture();
  try {
    const athena = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
    expect(f.writer.offloop).toBe(true);
    const sites = await watchWriteSites(f.db, f.writer, ["principals"]);
    const writes = registerPrincipalWrites(f.db, f.writer);
    expect(principalWrites(f.db), "PRINCIPAL_WRITES_REGISTERED_FOR_DB").toBe(writes);
    writes.touch(athena, Date.now());
    writes.pruneIfDue(Date.now());
    // The guard creates the request's ambient principal through the same writes.
    const app = new Hono<AppEnv>().use("/api/*", authGuard("none", { mode: "none" } as never, f.db)).get("/api/who", c => c.json({ id: c.get("principal")!.id }));
    const guarded = ((await (await app.request("/api/who")).json()) as { id: string }).id;
    const ambient = await writes.ambient("none", "No authentication", "No authentication");
    expect(ambient.kind, "PRINCIPAL_AMBIENT_CREATED_ON_WORKER").toBe("ambient");
    expect(guarded, "PRINCIPAL_GUARD_RESOLVES_AMBIENT").toBe(ambient.id);
    const login = await writes.login({ authMethod: "password", label: "Penelope's loom", ttlSeconds: 3600 });
    expect(resolvePrincipal(f.db, login.id)?.label, "PRINCIPAL_LOGIN_COMMITTED_BEFORE_SETTLING").toBe("Penelope's loom");
    await f.writer.idle();
    const log = await sites.log();
    expect(log.length, "PRINCIPAL_WRITES_LOGGED_ON_WORKER").toBeGreaterThanOrEqual(3);
    expect(new Set(log), "PRINCIPAL_WRITES_ONLY_TO_PRINCIPALS").toEqual(new Set(["principals"]));
    expect(lastSeen(f, athena.id), "PRINCIPAL_TOUCH_COMMITTED").not.toBeNull();
  } finally { await f.close(); }
});

test("a touch never waits for its commit, and a pending one is not submitted twice", async () => {
  const f = fixture();
  try {
    const athena: Principal = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
    const sites = await watchWriteSites(f.db, f.writer, ["principals"]);
    const writes = registerPrincipalWrites(f.db, f.writer);
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const started = performance.now();
    const seen = writes.touch(athena, Date.now());
    // Late enough that a second submission would commit a second row.
    writes.touch(athena, Date.now() + 61_000);
    expect(performance.now() - started, "PRINCIPAL_TOUCH_DOES_NOT_WAIT").toBeLessThan(100);
    expect(seen.lastSeenAt, "PRINCIPAL_TOUCH_ANSWERS_AT_ONCE").not.toBeNull();
    expect(lastSeen(f, athena.id), "PRINCIPAL_TOUCH_NOT_COMMITTED_ON_LOOP").toBeNull();
    await slow;
    await f.writer.idle();
    expect(await sites.log(), "PRINCIPAL_PENDING_TOUCH_SUBMITTED_ONCE").toEqual(["principals"]);
    expect(lastSeen(f, athena.id), "PRINCIPAL_TOUCH_COMMITTED_AFTER_HOLD").not.toBeNull();
  } finally { await f.close(); }
});

test("a signed-in request is answered without waiting for its touch to commit", async () => {
  const f = fixture();
  try {
    const config = resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "odysseus-password-hash", COOKIE_SECRET: "odysseus-cookie-secret-0123456789abcdef" });
    const auth: AuthRuntime = { ...config.auth, host: config.host };
    registerPrincipalWrites(f.db, f.writer);
    const penelope = createPrincipal(f.db, { authMethod: "password", label: "Penelope's loom", ttlSeconds: 3600 });
    const issue = new Hono().get("/", async c => { await issueSessionCookie(c, auth, f.db, penelope.id); return c.text("ok"); });
    const cookie = (await issue.request("/")).headers.get("set-cookie")!.split(";")[0]!;
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 400);
    const app = new Hono().get("/", async c => c.json({ id: (await resolveCookiePrincipal(c, auth, f.db))?.id ?? null }));
    const started = performance.now();
    const resolved = await (await app.request("/", { headers: { cookie } })).json() as { id: string | null };
    expect(resolved.id, "PRINCIPAL_COOKIE_RESOLVES").toBe(penelope.id);
    expect(performance.now() - started, "PRINCIPAL_COOKIE_REQUEST_DOES_NOT_WAIT_FOR_TOUCH").toBeLessThan(200);
    expect(lastSeen(f, penelope.id), "PRINCIPAL_COOKIE_TOUCH_NOT_COMMITTED_ON_LOOP").toBeNull();
    await slow; await f.writer.idle();
    expect(lastSeen(f, penelope.id), "PRINCIPAL_COOKIE_TOUCH_COMMITTED").not.toBeNull();
  } finally { await f.close(); }
});

test("a login refusal keeps its class across the worker", async () => {
  const f = fixture();
  try {
    const writes = registerPrincipalWrites(f.db, f.writer);
    await expectRejection(writes.login({ authMethod: "passkey", label: "Odysseus' bow", credentialId: "no-such-bow", ttlSeconds: 3600 }),
      PrincipalCredentialNotFoundError, "PRINCIPAL_LOGIN_REFUSAL_CLASS_KEPT");
  } finally { await f.close(); }
});

