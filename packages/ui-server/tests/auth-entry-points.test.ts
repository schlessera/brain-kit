/**
 * The HTTP guard and the WebSocket upgrade resolve one principal the same way
 * (#4758). For each auth mode, one admitted and one refused request go
 * through the mounted app's `/api` guard and its `/ws` route, and through
 * `isWsAuthorized` itself; the three must agree with the table.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/app-env";
import { isWsAuthorized, type AuthMode } from "../src/middleware/auth";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

const PASSWORD = "the loom is unwoven at night";
let HASH = "";
beforeAll(async () => { HASH = await Bun.password.hash(PASSWORD); });

/** What the guard answers when no principal resolves. */
const NOT_SIGNED_IN = { error: "Authentication required", authRequired: true };

interface Row {
  mode: AuthMode;
  env: () => Record<string, string>;
  /** Headers of an admitted request; password mode signs in first. */
  admitted: (t: HttpContractApp) => Promise<Record<string, string>>;
  label: string;
  /** Headers of a refused request and the guard's answer; `none` refuses nothing. */
  refused?: { headers: Record<string, string>; status: number; body: unknown };
}

const rows: Row[] = [
  { mode: "none", env: () => ({}), admitted: async () => ({}), label: "No authentication" },
  { mode: "tailscale", env: () => ({ AUTH_MODE: "tailscale", TRUST_PROXY: "1" }),
    admitted: async () => ({ "x-forwarded-for": "100.64.0.7" }), label: "100.64.0.7",
    refused: { headers: { "x-forwarded-for": "192.168.1.1" }, status: 403, body: { error: "VPN access required" } } },
  { mode: "proxy", env: () => ({ AUTH_MODE: "proxy", TRUST_PROXY: "1" }),
    admitted: async () => ({ "x-forwarded-user": "Odysseus" }), label: "Odysseus",
    refused: { headers: {}, status: 401, body: NOT_SIGNED_IN } },
  { mode: "password", env: () => ({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: HASH, COOKIE_SECRET: "fixture-cookie-secret-0123456789abcdef" }),
    admitted: async (t) => {
      const login = await t.fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      expect(cookie).toBeTruthy();
      return { cookie: cookie! };
    },
    label: "",
    refused: { headers: {}, status: 401, body: NOT_SIGNED_IN } },
];

for (const row of rows) {
  describe(`${row.mode} mode`, () => {
    let t: HttpContractApp;
    let admitted: Record<string, string>;
    /** isWsAuthorized against a real Hono context carrying the given headers. */
    let direct: (headers: Record<string, string>) => Promise<unknown>;
    beforeAll(async () => {
      t = await httpContractApp({ env: row.env() });
      const runtime = { ...t.app.config.auth, host: t.app.config.host };
      const probe = new Hono<AppEnv>().get("/probe", async (c) =>
        c.json({ principal: await isWsAuthorized(c, row.mode, runtime, t.app.db) }));
      direct = async (headers) => (await (await probe.request("/probe", { headers })).json()).principal;
      admitted = await row.admitted(t);
    });
    afterAll(async () => { await t.close(); });

    test("HTTP: the guard admits a signed-in request and sets its principal", async () => {
      expect(t.app.authMode).toBe(row.mode);
      expect((await t.fetch("/api/voice/dictation/settings", { headers: admitted })).status).toBe(200);
    });

    test("WebSocket: /ws admits the same request and isWsAuthorized returns its principal", async () => {
      const ws = await t.fetch("/ws", { headers: admitted });
      // Admitted: past authentication, refused only for not being an upgrade.
      expect({ status: ws.status, body: await ws.json() }).toEqual({ status: 400, body: { error: "WebSocket upgrade required" } });
      expect(await direct(admitted)).toMatchObject(row.mode === "password" ? { kind: "owner" } : { kind: "ambient", label: row.label });
    });

    if (!row.refused) return;
    const refused = row.refused;

    test(`HTTP: the guard refuses an unauthenticated request with ${refused.status}`, async () => {
      const response = await t.fetch("/api/voice/dictation/settings", { headers: refused.headers });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: refused.status, body: refused.body });
    });

    test("WebSocket: /ws refuses the same request with 401 and isWsAuthorized returns null", async () => {
      const ws = await t.fetch("/ws", { headers: refused.headers });
      expect({ status: ws.status, body: await ws.json() }).toEqual({ status: 401, body: { error: "Authentication required" } });
      expect(await direct(refused.headers)).toBeNull();
    });
  });
}
