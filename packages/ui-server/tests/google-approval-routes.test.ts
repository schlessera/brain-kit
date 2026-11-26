import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, type Principal } from "../src/db/principals.js";
import { createGoogleAllowances } from "../src/google/allowances.js";
import { createGoogleApprovalRoutes } from "../src/routes/google-approvals.js";
import type { AppEnv } from "../src/app-env.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  mkdirSync(resolve("tmp"), { recursive: true });
  const root = mkdtempSync(resolve("tmp/google-http-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ledger = openGoogleLedger(resolve(root, "approvals.db")); cleanups.push(() => ledger.close());
  const db = createUiDb(":memory:"); cleanups.push(() => db.close());
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 });
  const agent = createPrincipal(db, { authMethod: "delegated", label: "Eurylochus", createdBy: owner.id, ttlSeconds: 60 });
  let principal: Principal | null = owner, authorized = true, tainted = true;
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',1,1)").run();
  const allowances = createGoogleAllowances(db), app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (principal) c.set("principal", principal); await next(); });
  app.route("/api", createGoogleApprovalRoutes({ brainId: "brain", hostEpoch: "epoch", ledger: () => ledger, allowances,
    authorized: id => authorized && id === owner.id, owns: (id, session) => id === owner.id && session === "ithaca", tainted: () => tainted, policyHash: () => "policy" }));
  app.get("/api/unrelated", c => c.text("usable"));
  const scope = { brain_id: "brain", principal_id: owner.id, account_identity: "odysseus@example.com" };
  ledger.remember(scope, "gmail.modify", ["archive"], 1);
  const request = (path: string, body?: unknown) => app.request(`/api/${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { db, ledger, allowances, tainted: (value: boolean) => { tainted = value; }, owner, agent, scope, request, principal: (p: Principal | null) => { principal = p; }, authority: (value: boolean) => { authorized = value; } };
}
test("Google approval HTTP pair requires current owner and scopes list/revoke", async () => {
  const f = fixture(); f.ledger.remember({ ...f.scope, principal_id: "penelope" }, "gmail.modify", ["archive"], 1);
  for (const principal of [null, f.agent]) {
    f.principal(principal);
    expect((await f.request("google/approvals")).status, "GOOGLE_HTTP_OWNER_ONLY").toBe(principal ? 403 : 401);
    expect((await f.request("google/approvals/revoke", { id: "unknown" })).status).toBe(principal ? 403 : 401);
    expect((await f.request("unrelated")).status, "GOOGLE_HTTP_NARROW_SCOPE").toBe(200);
  }
  f.principal(f.owner);
  const response = await f.request("google/approvals"); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const listed = await response.json(); expect(listed.approvals).toHaveLength(1);
  expect((await f.request("google/approvals/revoke", { id: listed.approvals[0].id, principal_id: "penelope" })).status).toBe(400);
  expect(await (await f.request("google/approvals/revoke", { id: listed.approvals[0].id })).json()).toEqual({ revoked: true });
  expect(f.ledger.list("brain")).toHaveLength(1);
  f.authority(false); expect((await f.request("google/approvals")).status).toBe(403);
});
test("Google session HTTP pair requires session ownership and revokes the card grant", async () => {
  const f = fixture();
  await f.allowances.grant({ sessionId: "ithaca", principalId: f.owner.id, brainId: "brain", accountIdentity: "odysseus@example.com",
    hostEpoch: "epoch", policyHash: "policy", now: Date.now(), tainted: true, authorized: true }, "gmail.modify", ["archive"], "card-ithaca");
  expect((await f.request("sessions/aeaea/google/allowances")).status, "GOOGLE_HTTP_SESSION_OWNER").toBe(404);
  expect((await f.request("sessions/aeaea/google/allowances/revoke", { id: "card-ithaca" })).status).toBe(404);
  expect((await (await f.request("sessions/ithaca/google/allowances")).json()).allowances).toHaveLength(1);
  expect(await (await f.request("sessions/ithaca/google/allowances/revoke", { id: "card-ithaca" })).json()).toEqual({ revoked: true });
  expect((await (await f.request("sessions/ithaca/google/allowances")).json()).allowances).toEqual([]);
});

test("Google allowance GET filters normal sessions without writing", async () => {
  const f = fixture();
  await f.allowances.grant({ sessionId: "ithaca", principalId: f.owner.id, brainId: "brain", accountIdentity: "odysseus@example.com",
    hostEpoch: "epoch", policyHash: "policy", now: Date.now(), tainted: true, authorized: true }, "gmail.modify", ["archive"], "card");
  const before = f.db.query("SELECT * FROM google_session_allowances").all();
  f.tainted(false);
  expect(await (await f.request("sessions/ithaca/google/allowances")).json()).toEqual({ allowances: [] });
  expect(f.db.query("SELECT * FROM google_session_allowances").all(), "GOOGLE_GET_READ_ONLY").toEqual(before);
});
