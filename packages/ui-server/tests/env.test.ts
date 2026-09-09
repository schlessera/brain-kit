import { afterEach, describe, expect, test } from "bun:test";

import { resolveCronConfig, resolveServerConfig, subprocessEnv } from "../src/config/env";

const SUBPROCESS_KEYS = [
  "COOKIE_SECRET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "BRAIN_UI_SYNC_GITHUB_TOKEN",
] as const;
const savedSubprocessEnv = Object.fromEntries(
  SUBPROCESS_KEYS.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const key of SUBPROCESS_KEYS) {
    const value = savedSubprocessEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("config/env subprocessEnv", () => {
  test("strips server-only secrets while preserving agent and git credentials", () => {
    process.env.COOKIE_SECRET = "server-only-test-secret";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    process.env.GITHUB_TOKEN = "github-test-token";
    process.env.BRAIN_UI_SYNC_GITHUB_TOKEN = "sync-test-token";

    const env = subprocessEnv();

    expect(env.COOKIE_SECRET).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test-token");
    expect(env.GITHUB_TOKEN).toBe("github-test-token");
    expect(env.BRAIN_UI_SYNC_GITHUB_TOKEN).toBe("sync-test-token");
  });
});

describe("config/env resolveCronConfig", () => {
  test("uses the container DB default and preserves the scheduled-job environment", () => {
    const config = resolveCronConfig({ SECRET: "still-visible" });
    expect(config.dbPath).toBe("/data/db/brain-ui.db");
    expect(config.childEnv).toEqual({ SECRET: "still-visible" });
  });

  test("honors DB_PATH", () => {
    expect(resolveCronConfig({ DB_PATH: "/custom/brain-ui.db" }).dbPath).toBe(
      "/custom/brain-ui.db"
    );
  });
});

/**
 * Boolean flag parsing in resolveServerConfig — all of it goes through the
 * shared `envFlag` (src/config/env-core.ts), so every flag accepts the same
 * token set: 1/true/on/yes vs 0/false/off/no, case-insensitive, trimmed,
 * with unset/unrecognised falling back to the flag's own default.
 */
describe("config/env resolveServerConfig flags", () => {
  test("off-by-default flags accept the shared truthy token set", () => {
    for (const v of ["1", "true", "on", "YES", " on "]) {
      const config = resolveServerConfig({
        TRUST_PROXY: v,
        BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: v,
        BRAIN_UI_ALLOW_PASSWORD: v,
        BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: v,
      });
      expect(config.auth.trustProxy).toBe(true);
      expect(config.auth.dangerouslyDisableAuth).toBe(true);
      expect(config.auth.allowPassword).toBe(true);
      expect(config.webauthn.allowLoopbackOrigin).toBe(true);
    }
  });

  test("off-by-default flags stay off on falsy, empty, and unrecognised values", () => {
    for (const v of [undefined, "0", "false", "off", "no", "", "banana"]) {
      const config = resolveServerConfig({
        TRUST_PROXY: v,
        BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: v,
        BRAIN_UI_ALLOW_PASSWORD: v,
        BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: v,
      });
      expect(config.auth.trustProxy).toBe(false);
      expect(config.auth.dangerouslyDisableAuth).toBe(false);
      expect(config.auth.allowPassword).toBe(false);
      expect(config.webauthn.allowLoopbackOrigin).toBe(false);
    }
  });

  test("model discovery: on by default, off under a test runner, falsy disables", () => {
    expect(resolveServerConfig({}).agent.modelDiscovery).toBe(true);
    expect(resolveServerConfig({ NODE_ENV: "test" }).agent.modelDiscovery).toBe(false);
    for (const v of ["0", "off", "false", "no"]) {
      expect(
        resolveServerConfig({ BRAIN_UI_MODEL_DISCOVERY: v }).agent.modelDiscovery
      ).toBe(false);
    }
    // An explicit truthy token wins over the test-runner default-off.
    for (const v of ["1", "on", "true", "yes"]) {
      expect(
        resolveServerConfig({ BRAIN_UI_MODEL_DISCOVERY: v, NODE_ENV: "test" }).agent
          .modelDiscovery
      ).toBe(true);
    }
    // An unrecognised token falls back to the contextual default.
    expect(
      resolveServerConfig({ BRAIN_UI_MODEL_DISCOVERY: "banana" }).agent.modelDiscovery
    ).toBe(true);
    expect(
      resolveServerConfig({ BRAIN_UI_MODEL_DISCOVERY: "banana", NODE_ENV: "test" }).agent
        .modelDiscovery
    ).toBe(false);
  });
});
