import { expect, test } from "bun:test";
import { httpContractApp } from "./helpers/http-contract-app";

test("Storage inventory is mounted for the authenticated human without starting a scan on read", async () => {
  const fixture = await httpContractApp();
  try {
    const response = await fixture.fetch("/api/storage");
    expect(response.status, "STORAGE_OWNER_ROUTE").toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, state: "idle", snapshot: null });
  } finally { await fixture.close(); }
});

test("mounted Storage routes reject delegated and revoked principals and arbitrary roots", async () => {
  const { generateSignedCookie } = await import("hono/cookie");
  const { createPrincipal } = await import("../src/db/principals");
  const secret = "storage-odysseus-cookie-secret-0123456789";
  const fixture = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: secret, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  try {
    const owner = createPrincipal(fixture.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const agent = createPrincipal(fixture.app.db, { authMethod: "delegated", createdBy: owner.id, label: "Athena", ttlSeconds: 3600 });
    const cookie = async (id: string) => (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]!;
    const ownerCookie = await cookie(owner.id), agentCookie = await cookie(agent.id);
    for (const [method, path] of [["GET", "/api/storage"], ["POST", "/api/storage/scans"], ["DELETE", "/api/storage/scans/unknown"], ["GET", "/api/storage/scans/unknown/entries"], ["GET", "/api/storage/scans/unknown/entries/unknown/references"]]) {
      const response = await fixture.fetch(path!, { method, headers: { cookie: agentCookie, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status, "STORAGE_DELEGATED_DENIED").toBe(403);
      expect((await fixture.fetch(path!, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) })).status).toBe(401);
    }
    const post = (body: unknown) => fixture.fetch("/api/storage/scans", { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await fixture.fetch("/api/storage/scans", { method: "POST", headers: { cookie: ownerCookie, "content-type": "text/plain" }, body: "{}" })).status, "STORAGE_SCAN_REQUIRES_JSON").toBe(415);
    expect((await fixture.fetch("/api/storage/scans", { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json", origin: "https://troy.example" }, body: "{}" })).status, "STORAGE_SCAN_ORIGIN_GUARD").toBe(403);
    expect((await post({ root: "/" })).status, "STORAGE_REQUEST_CANNOT_EXPAND_ROOTS").toBe(400);
    expect((await post({})).status).toBe(202);
    let result: any;
    for (let attempts = 0; attempts < 100; attempts++) { result = await (await fixture.fetch("/api/storage", { headers: { cookie: ownerCookie } })).json(); if (result.state === "idle") break; await new Promise(done => setTimeout(done, 20)); }
    expect(result.state).toBe("idle"); expect(result.snapshot).not.toBeNull();
    const invalid = await fixture.fetch(`/api/storage/scans/${result.snapshot.id}/entries?cursor=forged`, { headers: { cookie: ownerCookie } });
    expect(invalid.status, "STORAGE_INVALID_CURSOR_IS_CLIENT_ERROR").toBe(400);
    fixture.app.db.query("UPDATE principals SET revoked_at=? WHERE id=?").run(Date.now(), owner.id);
    expect((await fixture.fetch("/api/storage", { headers: { cookie: ownerCookie } })).status, "STORAGE_REVOKED_OWNER_DENIED").toBe(401);
  } finally { await fixture.close(); }
});

test("an unavailable backend owner leaves the real inventory usable with an explicit unknown row", async () => {
  const { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const backend = makeFakeBackend({ id: "odysseus" });
  backend.storageRoots = () => { throw Error("owner scope unavailable"); };
  const fixture = await httpContractApp({ registry: createStaticBackendRegistry([backend]) });
  try {
    expect((await fixture.fetch("/api/storage/scans", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(202);
    let result: any;
    for (let i = 0; i < 100; i++) { result = await (await fixture.fetch("/api/storage")).json(); if (result.state === "idle") break; await new Promise(done => setTimeout(done, 20)); }
    expect(result.lastFailure).toBeNull();
    expect(result.snapshot.roots.some((root: {reason: string}) => root.reason === "backend-roots-unavailable"), "STORAGE_FAILED_OWNER_IS_PARTIAL").toBe(true);
    expect(result.snapshot.entries).toBeGreaterThan(0);
  } finally { await fixture.close(); }
});
