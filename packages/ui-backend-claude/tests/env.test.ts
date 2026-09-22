import { afterEach, describe, expect, test } from "bun:test";

import { ENV_VARS, envSnapshot, readEnvVar, resolveEnv } from "../src/config/env";

const SUBPROCESS_KEYS = [
  "COOKIE_SECRET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "BRAIN_UI_SYNC_GITHUB_TOKEN",
  "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
  "CUSTOM_PROFILE_TOKEN",
  "CUSTOM_OPERATOR_TOKEN",
  "UNKNOWN_CHILD_VALUE",
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

describe("config/env envSnapshot", () => {
  test("strips server-only secrets while preserving agent and git credentials", () => {
    process.env.COOKIE_SECRET = "server-only-test-secret";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-test-token";
    process.env.GITHUB_TOKEN = "github-test-token";
    process.env.BRAIN_UI_SYNC_GITHUB_TOKEN = "sync-test-token";

    const env = envSnapshot();

    expect(env.COOKIE_SECRET).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test-token");
    expect(env.GITHUB_TOKEN).toBe("github-test-token");
    expect(env.BRAIN_UI_SYNC_GITHUB_TOKEN).toBe("sync-test-token");
  });

  test("admits profile names and operator extras without forwarding unknowns or the hatch", () => {
    process.env.CUSTOM_PROFILE_TOKEN = "profile-test-token";
    process.env.CUSTOM_OPERATOR_TOKEN = "operator-test-token";
    process.env.UNKNOWN_CHILD_VALUE = "must-not-pass";
    process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA =
      " CUSTOM_OPERATOR_TOKEN, ,CUSTOM_OPERATOR_TOKEN,bad-name ";

    const env = envSnapshot(["CUSTOM_PROFILE_TOKEN"]);

    expect(env.CUSTOM_PROFILE_TOKEN).toBe("profile-test-token");
    expect(env.CUSTOM_OPERATOR_TOKEN).toBe("operator-test-token");
    expect(env.UNKNOWN_CHILD_VALUE).toBeUndefined();
    expect(env.BRAIN_UI_SUBPROCESS_ENV_EXTRA).toBeUndefined();
  });
});

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
        "BRAIN_UI_EXEC_WRAPPER",
        "BRAIN_UI_REVERSE_GEOCODE",
        "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
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
