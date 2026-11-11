import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";

import { createTestApp, type TestApp, withHeaders } from "./test-app";

// Every key the helper overrides at boot, written out independently of the
// helper's own list so a key it forgets to restore shows up here.
const HELPER_ENV = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "ALLOWED_ORIGINS",
  "WEBAUTHN_ORIGINS",
  "TRUST_PROXY",
  "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
  "HOST",
  "NODE_ENV",
  "DB_PATH",
  "BRAIN_PATH",
  "BRAIN_UI_PRICING_DISCOVERY",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_CODE_PATH",
  "BRAIN_UI_NATIVE_BRAIN_SOCKET",
  "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH",
  "BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS",
  "BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES",
  "SOURCE_COMMIT",
] as const;
const helperEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(HELPER_ENV.map((key) => [key, process.env[key]]));
let testApp: TestApp;

describe("test-app helper", () => {
  beforeAll(async () => {
    testApp = await createTestApp({
      env: {
        SOURCE_COMMIT: "test-app-helper",
      },
    });
  });

  afterAll(async () => {
    await testApp.teardown();
  });

  test("boots once and serves a real GET", async () => {
    expect(existsSync(testApp.dbPath)).toBe(true);
    expect(testApp.app.config.brainPath).toBe(testApp.brainPath);
    expect(testApp.app.config.sourceCommit).toBe("test-app-helper");
    expect(process.env.PI_CODING_AGENT_DIR).toBe(testApp.piAgentDir);
    expect(process.env.BRAIN_UI_PRICING_DISCOVERY).toBe("0");

    const response = await testApp.fetch("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  test("withHeaders merges base headers with per-call overrides", () => {
    const init = withHeaders(
      { authorization: "Bearer base", "x-shared": "base" },
      {
        method: "POST",
        headers: new Headers({ "x-shared": "override", "x-call": "call" }),
      }
    );
    const headers = new Headers(init.headers);

    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer base");
    expect(headers.get("x-shared")).toBe("override");
    expect(headers.get("x-call")).toBe("call");
  });
});

describe("test-app helper teardown", () => {
  test("teardown restores every overridden env value and removes the temporary state", async () => {
    // Its own app, so the claim holds in any test order.
    const envBefore = helperEnv();
    const app = await createTestApp({ env: { SOURCE_COMMIT: "test-app-teardown" } });
    try {
      expect(process.env.SOURCE_COMMIT).toBe("test-app-teardown");
      expect(existsSync(app.dbPath)).toBe(true);
    } finally {
      await app.teardown();
    }

    expect(helperEnv()).toStrictEqual(envBefore);
    expect(existsSync(app.dbPath)).toBe(false);
    expect(existsSync(app.brainPath)).toBe(false);
    expect(existsSync(app.piAgentDir)).toBe(false);
  });
});
