import { afterEach, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { classifySessionRecoveryResponse } from "@schlessera/brain-ui-sdk/schemas";

import { createPrincipal, revokePrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// GET /api/sessions/:id/recovery through the real composition root and
// every middleware (#964, D52 §6). Each response is also read back through
// the SDK classifier, so the status a host sends maps to the state D52 names.

const SECRET = "recovery-http-fixture-secret-0123456789";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function boot(): Promise<HttpContractApp> {
  const t = await httpContractApp({ env: {
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET,
    BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
  } });
  cleanups.push(() => t.close());
  return t;
}

async function login(t: HttpContractApp, label: string) {
  const principal = createPrincipal(t.app.db, { authMethod: "password", label, ttlSeconds: 3600 });
  const cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
  const recovery = async (sessionId: string) => {
    const response = await t.fetch(`/api/sessions/${sessionId}/recovery`, { headers: { cookie, origin: "http://localhost", host: "localhost" } });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body, result: classifySessionRecoveryResponse(response.status, body) };
  };
  return { principal, recovery };
}

test("a known session answers 200 with an envelope; an unknown one 404 SESSION_NOT_FOUND", async () => {
  const t = await boot();
  const odysseus = await login(t, "Odysseus phone");
  const known = await odysseus.recovery("fixture-session");
  expect(known.status).toBe(200);
  expect(known.result).toEqual({
    ok: true,
    recovery: {
      sessionId: "fixture-session", backendId: null, revision: 0,
      latest: { requestId: null, turnId: null, state: "unknown", outcome: null, startedAt: null, endedAt: null },
      pending: [],
    },
  });
  const missing = await odysseus.recovery("odyssey-nowhere");
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ error: "SESSION_NOT_FOUND", message: "This host has no such session." });
  expect(missing.result).toEqual({ ok: false, reason: "session_not_found" });
});

test("a revoked login gets the auth envelope and no identities", async () => {
  const t = await boot();
  const odysseus = await login(t, "Odysseus phone");
  revokePrincipal(t.app.db, odysseus.principal.id, Date.now());
  const refused = await odysseus.recovery("fixture-session");
  expect(refused.status).toBe(401);
  expect(refused.body).toEqual({ error: "Authentication required", authRequired: true });
  expect(refused.result).toEqual({ ok: false, reason: "unauthorized" });
});

test("a storage failure is a 500, never a successful unknown", async () => {
  const t = await boot();
  const odysseus = await login(t, "Odysseus phone");
  t.app.db.exec("DROP TABLE session_work");
  const failed = await odysseus.recovery("fixture-session");
  expect(failed.status).toBe(500);
  expect(failed.body).toMatchObject({ error: "SESSION_RECOVERY_FAILED" });
  expect(failed.result).toEqual({ ok: false, reason: "host_unreachable" });
});

test("a host without the route reads as too old", () => {
  // Hono's own not-found answer, as an older host sends it.
  expect(classifySessionRecoveryResponse(404, undefined)).toEqual({ ok: false, reason: "host_too_old" });
  expect(classifySessionRecoveryResponse(404, { error: "Not Found" })).toEqual({ ok: false, reason: "host_too_old" });
  expect(classifySessionRecoveryResponse(403, { error: "VPN access required" })).toEqual({ ok: false, reason: "unauthorized" });
  expect(classifySessionRecoveryResponse(502, undefined)).toEqual({ ok: false, reason: "host_unreachable" });
  // A 200 whose body contradicts itself is not an envelope.
  expect(classifySessionRecoveryResponse(200, {
    sessionId: "s", backendId: null, revision: 1, pending: [],
    latest: { requestId: null, turnId: null, state: "running", outcome: "success", startedAt: 1, endedAt: null },
  })).toEqual({ ok: false, reason: "host_unreachable" });
});
