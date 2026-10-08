import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createRecordingObservability } from "../src/observability/index";
import { accountScope } from "../src/middleware/account-partition";
import type { Principal } from "../src/db/principals";
import { makeFakeBackend } from "./helpers/fake-backend";

// The account partition key (#1014) through the real auth routes: the same
// owner signing out and in again gets the same key; another host (another
// database) or another root gets a different one; an agent gets none.

const PASSWORD = "Ithaca is the harbour, not the voyage";
const scratch = join(tmpdir(), `account-partition-${process.pid}`);
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await Bun.password.hash(PASSWORD);
  for (const dir of ["ithaca", "pylos"]) mkdirSync(join(scratch, dir), { recursive: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Mode = "password" | "none" | "proxy";
async function host(options: { db: string; brain: string; mode?: Mode }) {
  const backend = makeFakeBackend({ id: "fake" });
  const mode = options.mode ?? "password";
  return createApp({
    config: resolveServerConfig({
      AUTH_MODE: mode,
      ...(mode === "password" ? { BRAIN_UI_PASSWORD_HASH: passwordHash, COOKIE_SECRET: "odysseus-cookie-secret-0123456789abcdef" } : {}),
      ...(mode === "proxy" ? { TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-forwarded-user" } : {}),
      HOST: "127.0.0.1",
      DB_PATH: join(scratch, options.db),
      BRAIN_PATH: join(scratch, options.brain),
      BRAIN_UI_MODEL_DISCOVERY: "0",
      BRAIN_UI_PRICING_DISCOVERY: "0",
    }),
    observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([backend], backend.id),
  });
}
type Host = Awaited<ReturnType<typeof host>>;

async function signIn(app: Host): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function probe(app: Host, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await app.fetch(new Request("http://localhost/api/vpn-check", { headers }));
  return { status: res.status, body: res.ok ? await res.json() as Record<string, unknown> : null };
}

async function keyOf(app: Host, headers: Record<string, string> = {}): Promise<string> {
  const { status, body } = await probe(app, headers);
  expect(status).toBe(200);
  expect(body!.accountKey).toBeString();
  return body!.accountKey as string;
}

describe("account partition key (#1014)", () => {
  test("the same owner keeps the key across a sign-out and a sign-in; another host or root does not share it", async () => {
    const ithaca = await host({ db: "ithaca.db", brain: "ithaca" });
    const first = await signIn(ithaca);
    const key = await keyOf(ithaca, { cookie: first });

    // Signing out revokes the login: the probe is refused, and names no key.
    const out = await ithaca.fetch(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie: first } }));
    expect(out.status).toBe(200);
    const signedOut = await probe(ithaca, { cookie: first });
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toBeNull();

    // A new login is a new principal, and the same account.
    const second = await signIn(ithaca);
    expect(second).not.toBe(first);
    expect(await keyOf(ithaca, { cookie: second })).toBe(key);
    await ithaca.close();

    // The same database again (a restart) is the same host.
    const restarted = await host({ db: "ithaca.db", brain: "ithaca" });
    expect(await keyOf(restarted, { cookie: await signIn(restarted) })).toBe(key);
    await restarted.close();

    // Another host: its own database.
    const otherHost = await host({ db: "pylos.db", brain: "ithaca" });
    expect(await keyOf(otherHost, { cookie: await signIn(otherHost) })).not.toBe(key);
    await otherHost.close();

    // Another root on the same database.
    const otherRoot = await host({ db: "ithaca.db", brain: "pylos" });
    expect(await keyOf(otherRoot, { cookie: await signIn(otherRoot) })).not.toBe(key);
    await otherRoot.close();
  });

  test("an agent principal never gets the owner's key", async () => {
    const app = await host({ db: "agents.db", brain: "ithaca" });
    const owner = await signIn(app);
    const ownerKey = await keyOf(app, { cookie: owner });
    const minted = await app.fetch(new Request("http://localhost/api/auth/principals", {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ label: "Eurylochus' delegate" }),
    }));
    expect(minted.status).toBe(200);
    const { cookie } = await minted.json() as { cookie: string };
    const agent = await probe(app, { cookie: `brain_ui_session=${encodeURIComponent(cookie)}` });
    expect(agent.status).toBe(200);
    expect(ownerKey).toBeString();
    expect(agent.body).toEqual({ vpn: true });
    await app.close();
  });

  test("ambient modes: none is the owner; a proxy keeps one key per upstream user", async () => {
    const none = await host({ db: "none.db", brain: "ithaca", mode: "none" });
    const key = await keyOf(none);
    expect(await keyOf(none)).toBe(key);
    await none.close();

    const proxy = await host({ db: "proxy.db", brain: "ithaca", mode: "proxy" });
    const penelope = await keyOf(proxy, { "x-forwarded-user": "penelope" });
    expect(await keyOf(proxy, { "x-forwarded-user": "penelope" })).toBe(penelope);
    expect(await keyOf(proxy, { "x-forwarded-user": "telemachus" })).not.toBe(penelope);
    await proxy.close();
  });

  test("every owner login method is the one owner; only owner and ambient principals have an account", () => {
    const principal = (kind: Principal["kind"], authMethod: Principal["authMethod"]): Principal => ({
      id: `odysseus-${kind}-${authMethod}`, kind, authMethod, label: "Odysseus", credentialId: null,
      createdBy: null, createdAt: 0, expiresAt: 1, lastSeenAt: null, revokedAt: null,
    });
    expect(accountScope(principal("owner", "password"), "password")).toBe("owner");
    expect(accountScope(principal("owner", "passkey"), "password")).toBe("owner");
    expect(accountScope(principal("ambient", "ambient"), "tailscale")).toBe("owner");
    expect(accountScope(principal("ambient", "ambient"), "none")).toBe("owner");
    expect(accountScope(principal("ambient", "ambient"), "proxy")).toBe("proxy\u0000odysseus-ambient-ambient");
    expect(accountScope(principal("agent", "delegated"), "password")).toBeNull();
    expect(accountScope(principal("system", "ambient"), "password")).toBeNull();
  });
});
