import { describe, expect, test } from "bun:test";

import { resolveServerConfig } from "../src/config/env";

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
