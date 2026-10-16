import { expect, test } from "bun:test";
import { httpContractApp } from "./helpers/http-contract-app";
test("Storage maintenance mounts only the three approved owner operations", async () => {
  const f = await httpContractApp();
  try {
    const response = await f.fetch("/api/storage/maintenance");
    expect(response.status, "STORAGE_MAINTENANCE_OWNER_ROUTE").toBe(200);
    const result = await response.json() as { operations: Array<{ id: string }> };
    expect(result.operations.map(value => value.id)).toEqual(["pack-git", "prune-scratch", "cleanup-staging"]);
  } finally { await f.close(); }
});

test("mounted maintenance routes enforce owner, origin, body bounds and durable receipt readback", async () => {
  const { generateSignedCookie } = await import("hono/cookie"), { createPrincipal } = await import("../src/db/principals");
  const secret = "odysseus-storage-maintenance-secret-0123456789";
  const f = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: secret, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  try {
    const owner = createPrincipal(f.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const agent = createPrincipal(f.app.db, { authMethod: "delegated", createdBy: owner.id, label: "Athena", ttlSeconds: 3600 });
    const cookie = async (id: string) => (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]!;
    const ownerCookie = await cookie(owner.id), agentCookie = await cookie(agent.id);
    const input = { id: "odysseus-cleanup-001", operation: "cleanup-staging" };
    for (const [method, path] of [["GET", "/api/storage/maintenance"], ["GET", "/api/storage/maintenance/unknown"], ["POST", "/api/storage/maintenance"], ["DELETE", "/api/storage/maintenance/unknown"]]) {
      const init = { method, headers: { cookie: agentCookie, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}) };
      expect((await f.fetch(path!, init)).status, "STORAGE_MAINTENANCE_DELEGATED_DENIED").toBe(403);
      expect((await f.fetch(path!, { ...init, headers: { "content-type": "application/json" } })).status).toBe(401);
    }
    const post = (body: unknown, headers: Record<string,string> = {}) => f.fetch("/api/storage/maintenance", { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({ ...input, operation: "scratch-clean" })).status, "STORAGE_MAINTENANCE_APPROVED_OPERATIONS_ONLY").toBe(400);
    expect((await post({ ...input, root: "/" })).status).toBe(400);
    expect((await post(input, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(input, { origin: "https://troy.example" })).status).toBe(403);
    expect((await post({ ...input, extra: "x".repeat(5000) })).status, "STORAGE_MAINTENANCE_BODY_BOUND").toBe(413);
    const first = await post(input); expect(first.status).toBe(202);
    let result: any;
    for (let i = 0; i < 150; i++) { const response = await f.fetch(`/api/storage/maintenance/${input.id}`, { headers: { cookie: ownerCookie } }); expect(response.status).toBe(200); result = await response.json(); if (!["waiting", "running"].includes(result.state)) break; await Bun.sleep(20); }
    expect(result.state, JSON.stringify(result)).toBe("complete");
    expect(await (await post(input)).json(), "STORAGE_MAINTENANCE_HTTP_RECEIPT_REPLAY").toEqual(result);
    expect((await f.fetch(`/api/storage/maintenance/${input.id}`, { method: "DELETE", headers: { cookie: ownerCookie } })).status).toBe(202);
    f.app.db.query("UPDATE principals SET revoked_at=? WHERE id=?").run(Date.now(), owner.id);
    expect((await post({ ...input, id: "odysseus-cleanup-002" })).status).toBe(401);
  } finally { await f.close(); }
});
