import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";

import { createTestApp, type TestApp, withHeaders } from "./test-app";

const HELPER_ENV = [
  "AUTH_MODE",
  "BRAIN_UI_PASSWORD_HASH",
  "COOKIE_SECRET",
  "ALLOWED_ORIGINS",
  "TRUST_PROXY",
  "BRAIN_UI_DANGEROUSLY_DISABLE_AUTH",
  "HOST",
  "NODE_ENV",
  "DB_PATH",
  "BRAIN_PATH",
  "BRAIN_UI_PRICING_DISCOVERY",
  "PI_CODING_AGENT_DIR",
  "SOURCE_COMMIT",
] as const;
const envBeforeSuite = new Map(
  HELPER_ENV.map((key) => [key, process.env[key]] as const)
);
let testApp: TestApp;

describe("test-app helper", () => {
  beforeAll(() => {
    testApp = createTestApp({
      env: {
        SOURCE_COMMIT: "test-app-helper",
      },
    });
  });

  afterAll(() => {
    testApp.teardown();
  });

  test("boots once and serves a real GET", async () => {
    expect(existsSync(testApp.dbPath)).toBe(true);
    expect(testApp.app.config.brainPath).toBe(testApp.brainPath);
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
  test("the preceding suite's afterAll restored every overridden env value", () => {
    for (const [key, value] of envBeforeSuite) {
      expect(process.env[key]).toBe(value);
    }
    expect(existsSync(testApp.dbPath)).toBe(false);
    expect(existsSync(testApp.brainPath)).toBe(false);
    expect(existsSync(testApp.piAgentDir)).toBe(false);
  });
});
