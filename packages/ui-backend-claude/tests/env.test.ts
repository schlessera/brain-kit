import { describe, expect, test } from "bun:test";

import { ENV_VARS, readEnvVar, resolveEnv } from "../src/config/env";

describe("config/env resolveEnv", () => {
  test("empty environment yields the documented defaults", () => {
    const env = resolveEnv({});
    expect(env.anthropicApiKey).toBeUndefined();
    expect(env.claudeCodeOauthToken).toBeUndefined();
    expect(env.reverseGeocodeEnabled).toBe(true);
    expect(env.nominatimUrl).toBe("https://nominatim.openstreetmap.org");
    expect(env.nominatimUserAgent).toBe("brain-kit-ui/1.0");
  });

  test("reverse geocoding disables on the shared falsy token set, case-insensitively", () => {
    // envFlag's falsy set — "no" and surrounding whitespace now count too.
    for (const v of ["0", "off", "false", "no", "OFF", "False", " off "]) {
      expect(resolveEnv({ BRAIN_UI_REVERSE_GEOCODE: v }).reverseGeocodeEnabled).toBe(false);
    }
    // Truthy tokens, empty, and unrecognised values keep the on-by-default.
    for (const v of ["1", "on", "yes", "", "banana"]) {
      expect(resolveEnv({ BRAIN_UI_REVERSE_GEOCODE: v }).reverseGeocodeEnabled).toBe(true);
    }
  });

  test("Nominatim endpoint and UA are overridable", () => {
    const env = resolveEnv({
      NOMINATIM_URL: "https://nominatim.example",
      NOMINATIM_USER_AGENT: "test-agent/1",
    });
    expect(env.nominatimUrl).toBe("https://nominatim.example");
    expect(env.nominatimUserAgent).toBe("test-agent/1");
  });
});

describe("config/env descriptor", () => {
  test("every statically-read variable is described exactly once", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "BRAIN_UI_REVERSE_GEOCODE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "NOMINATIM_URL",
        "NOMINATIM_USER_AGENT",
      ].sort()
    );
  });
});

describe("config/env readEnvVar", () => {
  test("reads a profile-declared variable from the given environment", () => {
    expect(readEnvVar("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "sk" })).toBe("sk");
    expect(readEnvVar("OPENROUTER_API_KEY", {})).toBeUndefined();
  });
});
