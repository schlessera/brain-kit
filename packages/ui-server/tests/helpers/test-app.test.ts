import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";

import * as nativeAppFixture from "./native-app-fixture.js";
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
/**
 * Read the given keys from process.env, then put back their expected values,
 * so a helper that leaks one fails this test instead of every later file.
 */
const settleEnv = (expected: Record<string, string | undefined>): Record<string, string | undefined> => {
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return actual;
};
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

  test("apps torn down in boot order leave no closed app's native socket in the env (#5005)", async () => {
    // static-asset-headers.test.ts boots two apps and tears them down in this
    // order; a later file that resolves its config from process.env then
    // booted on the first app's removed manager socket.
    const envBefore = helperEnv();
    const first = await createTestApp({ env: { SOURCE_COMMIT: "test-app-first" } });
    let second: TestApp | undefined;
    try {
      second = await createTestApp();
      expect(process.env.BRAIN_UI_NATIVE_BRAIN_SOCKET).toBe(second.app.config.nativeBrain?.socketPath);
    } finally {
      await first.teardown();
      await second?.teardown();
    }

    expect(process.env.BRAIN_UI_NATIVE_BRAIN_SOCKET).toBe(envBefore.BRAIN_UI_NATIVE_BRAIN_SOCKET);
    expect(helperEnv()).toStrictEqual(envBefore);
  });

  test("an app whose native fixture fails to start still lets an older app restore the env (#5015)", async () => {
    // The native fixture makes its state directory under TMPDIR after the
    // helper has applied this app's env; a missing TMPDIR makes it throw.
    const envBefore = { ...helperEnv(), TMPDIR: process.env.TMPDIR };
    const older = await createTestApp();
    try {
      await expect(createTestApp({ env: { TMPDIR: "/odysseus-missing-tmpdir" } })).rejects.toThrow("odysseus-missing-tmpdir");
    } finally {
      await older.teardown();
    }

    expect(settleEnv(envBefore)).toStrictEqual(envBefore);
  });

  test("an app whose native close throws in teardown still lets an older app restore the env (#5015)", async () => {
    const envBefore = helperEnv();
    const older = await createTestApp();
    try {
      const realFixture = nativeAppFixture.createNativeAppFixture;
      const failingClose = spyOn(nativeAppFixture, "createNativeAppFixture").mockImplementation((brainPath) => {
        const fixture = realFixture(brainPath);
        return { ...fixture, close: async () => { await fixture.close(); throw new Error("odysseus native close failed"); } };
      });
      let newer: TestApp;
      try {
        newer = await createTestApp({ env: { SOURCE_COMMIT: "test-app-newer" } });
      } finally {
        failingClose.mockRestore();
      }
      // Awaited directly: under expect(...).rejects Bun 1.4.4 delivers no
      // Worker reply while it waits, so the storage writer's shutdown misses
      // its settlement and teardown fails on that instead (#5047, which holds
      // the standalone repro).
      const closeError = await newer.teardown().then(() => undefined, (error: unknown) => error);
      expect(closeError).toBeInstanceOf(Error);
      expect((closeError as Error).message).toBe("odysseus native close failed");
    } finally {
      await older.teardown();
    }

    expect(settleEnv(envBefore)).toStrictEqual(envBefore);
  });
});
