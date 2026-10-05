import { expect, spyOn, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { registerPushHandlers, type PushCapableScope } from "@schlessera/brain-ui-sdk/push-handlers";
import { createPrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

const SECRET = "http-principal-fixture-secret-0123456789";
async function cookie(id: string) {
  return (await generateSignedCookie("brain_ui_session", id, SECRET)).split(";")[0]!;
}
async function acting(t: HttpContractApp, createdBy?: string) {
  const principal = createPrincipal(t.app.db, { authMethod: createdBy ? "delegated" : "password", ...(createdBy ? { createdBy } : {}), label: "Fixture principal", ttlSeconds: 3600 });
  return { principal, cookie: await cookie(principal.id) };
}
function json(cookie: string, method: string, body: unknown): RequestInit {
  return { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) };
}

test("real owner management rejects a live agent against populated principal and credential stores", async () => {
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  try {
    const owner = await acting(t);
    const agent = await acting(t, owner.principal.id);
    t.app.db.query("INSERT INTO passkey_credentials (id, public_key, counter, rp_id, label, created_at) VALUES ('fixture-key', ?, 0, 'localhost', 'Original fixture label', 1)").run(new Uint8Array([1, 2, 3]));
    expect(t.app.db.query("SELECT id FROM principals").all()).toHaveLength(2);
    expect(t.app.db.query("SELECT id FROM passkey_credentials").all()).toHaveLength(1);
    for (const [method, path, body] of [
      ["GET", "/api/auth/principals", undefined],
      ["POST", "/api/auth/principals", { label: "Forbidden delegate" }],
      ["DELETE", `/api/auth/principals/${owner.principal.id}`, undefined],
      ["GET", "/api/auth/passkey/list", undefined],
      ["PUT", "/api/auth/passkey/fixture-key", { label: "Forbidden rename" }],
      ["DELETE", "/api/auth/passkey/fixture-key", undefined],
      ["POST", "/api/auth/passkey/register-options", undefined],
      ["POST", "/api/auth/passkey/register-verify", { response: {} }],
    ] as const) {
      const init: RequestInit = body === undefined
        ? { method, headers: { cookie: agent.cookie } }
        : json(agent.cookie, method, body);
      const response = await t.fetch(path, init);
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
      expect(await response.json()).toEqual({ error: "Owner access required" });
    }
    const credentials = await (await t.fetch("/api/auth/passkey/list", { headers: { cookie: owner.cookie } })).json();
    expect(credentials.credentials).toHaveLength(1);
    expect(credentials.credentials[0]).toMatchObject({ id: "fixture-key", label: "Original fixture label" });
    const principals = await (await t.fetch("/api/auth/principals", { headers: { cookie: owner.cookie } })).json();
    expect(principals.principals.map((p: { id: string }) => p.id).sort()).toEqual([owner.principal.id, agent.principal.id].sort());
    const renamed = await t.fetch("/api/auth/passkey/fixture-key", json(owner.cookie, "PUT", { label: "Allowed rename" }));
    expect(renamed.status).toBe(200);
    expect(t.app.db.query("SELECT label FROM passkey_credentials").get()).toEqual({ label: "Allowed rename" });
  } finally { await t.close(); }
});

test("real app password login issues a usable owner cookie and logout revokes it", async () => {
  const password = "fixture-only-password";
  const hash = await Bun.password.hash(password);
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: hash, COOKIE_SECRET: SECRET } });
  try {
    const login = await t.fetch("/api/auth/login", json("", "POST", { password }));
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ ok: true });
    const credential = login.headers.get("set-cookie")!;
    expect(credential).toContain("HttpOnly");
    expect(credential).toContain("Secure");
    expect(credential).toContain("SameSite=Strict");
    const cookie = credential.split(";")[0]!;
    const list = await (await t.fetch("/api/auth/principals", { headers: { cookie } })).json();
    expect(list.principals).toHaveLength(1);
    expect(list.principals[0]).toMatchObject({ kind: "owner", auth_method: "password", is_own: true });
    const logout = await t.fetch("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect((await t.fetch("/api/auth/principals", { headers: { cookie } })).status).toBe(401);
  } finally { await t.close(); }
});

test("SDK push renewal reaches the mounted subscribe handler and retains principal isolation", async () => {
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET } });
  try {
    const a = await acting(t), b = await acting(t);
    const endpointA = "https://push.example/device-a", endpointB = "https://push.example/device-b";
    const subscription = (endpoint: string, auth = "original") => ({ endpoint, keys: { p256dh: "fixture-public-key", auth } });
    for (const [owner, endpoint] of [[a, endpointA], [b, endpointB]] as const) {
      const response = await t.fetch("/api/push/subscribe", json(owner.cookie, "POST", { subscription: subscription(endpoint), label: endpoint === endpointA ? "Device A" : "Device B" }));
      expect(response.status).toBe(200);
    }
    const read = (credential: string) => t.fetch("/api/push/subscriptions", { headers: { cookie: credential } });
    for (const [owner, label] of [[a, "Device A"], [b, "Device B"]] as const) {
      const body = await (await read(owner.cookie)).json();
      expect(body.subscriptions).toHaveLength(1);
      expect(body.subscriptions[0].label).toBe(label);
      expect(body.subscriptions[0].endpointHash).toMatch(/^[0-9a-f]{16}$/);
      expect(body.subscriptions[0].endpoint).toBeUndefined();
      expect(body.subscriptions[0].keys).toBeUndefined();
    }
    const foreignDelete = await t.fetch("/api/push/unsubscribe", json(b.cookie, "POST", { endpoint: endpointA }));
    expect(await foreignDelete.json()).toEqual({ removed: false });
    expect((await (await read(a.cookie)).json()).subscriptions).toHaveLength(1);

    const listeners = new Map<string, (event: any) => void>();
    const renewals: unknown[] = [];
    const scope: PushCapableScope = {
      addEventListener: (name, handler) => { listeners.set(name, handler); },
      registration: { showNotification: async () => {}, pushManager: { subscribe: async (options) => { renewals.push(options); return subscription(endpointA, "renewed"); } } },
      clients: { matchAll: async () => [], openWindow: async () => {} },
    };
    registerPushHandlers(scope);
    let pending: Promise<unknown> | undefined;
    const requests: Array<{ path: string; status: number; body: any }> = [];
    const localTransport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = String(input);
      const requestBody = JSON.parse(String(init?.body));
      const response = await t.fetch(path, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: a.cookie } });
      requests.push({ path, status: response.status, body: requestBody });
      return response;
    }, { preconnect: fetch.preconnect });
    const transport = spyOn(globalThis, "fetch").mockImplementation(localTransport);
    try {
      listeners.get("pushsubscriptionchange")!({ oldSubscription: { options: { applicationServerKey: new Uint8Array([1, 2, 3]) } }, waitUntil: (work: Promise<unknown>) => { pending = work; } });
      expect(pending).toBeDefined();
      await pending;
      expect(renewals).toHaveLength(1);
      // The renewal reports the worker's zone, so Action notice timing survives it.
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(requests).toEqual([{ path: "/api/push/subscribe", status: 200, body: { subscription: subscription(endpointA, "renewed"), timeZone: zone } }]);
      const row = t.app.db.query("SELECT auth, principal_id, time_zone FROM push_subscriptions WHERE endpoint = ?").get(endpointA);
      expect(row).toEqual({ auth: "renewed", principal_id: a.principal.id, time_zone: zone });
    } finally { transport.mockRestore(); }
    const removed = await t.fetch("/api/push/unsubscribe", json(a.cookie, "POST", { endpoint: endpointA }));
    expect(await removed.json()).toEqual({ removed: true });
    expect((await (await read(a.cookie)).json()).subscriptions).toHaveLength(0);
    expect((await (await read(b.cookie)).json()).subscriptions).toHaveLength(1);
  } finally { await t.close(); }
});

test("share-target network fallback leaves the cross-site request body unread before authentication", async () => {
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET } });
  try {
    const request = new Request("http://localhost/share-target", { method: "POST", headers: { origin: "https://sender.example", "content-type": "text/plain" }, body: "Untrusted shared fixture" });
    const response = await t.app.fetch(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?share_error=no_worker");
    expect(request.bodyUsed).toBe(false);
    expect(t.app.db.query("SELECT id FROM inbox_threads").all()).toHaveLength(0);
  } finally { await t.close(); }
});
