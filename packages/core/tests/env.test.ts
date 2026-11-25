import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { ENV_VARS, readEnvVar, resolveEnv } from "../src/config/env";

describe("config/env resolveEnv", () => {
  test("empty environment yields the documented defaults", () => {
    const env = resolveEnv({});
    expect(env.brainRoot).toBeUndefined();
    expect(env.rerankMode).toBeUndefined();
    expect(env.binDir).toBe(join(homedir(), ".local", "bin"));
    expect(env.noColor).toBe(false);
    expect(env.chromeNoSandbox).toBe(false);
  });

  test("an empty BRAIN_ROOT falls back to discovery (matches the old truthy check)", () => {
    expect(resolveEnv({ BRAIN_ROOT: "" }).brainRoot).toBeUndefined();
    expect(resolveEnv({ BRAIN_ROOT: "/tmp/b" }).brainRoot).toBe("/tmp/b");
  });

  test("XDG_BIN_HOME overrides the ~/.local/bin fallback", () => {
    expect(resolveEnv({ XDG_BIN_HOME: "/opt/bin" }).binDir).toBe("/opt/bin");
  });

  test("NO_COLOR: any non-empty value suppresses color", () => {
    expect(resolveEnv({ NO_COLOR: "1" }).noColor).toBe(true);
    expect(resolveEnv({ NO_COLOR: "anything" }).noColor).toBe(true);
    expect(resolveEnv({ NO_COLOR: "" }).noColor).toBe(false);
  });

  test("chromeNoSandbox: either spelling, shared truthy token set", () => {
    expect(resolveEnv({ BRAIN_CHROME_NO_SANDBOX: "1" }).chromeNoSandbox).toBe(true);
    expect(resolveEnv({ BRAIN_UI_CHROME_NO_SANDBOX: "1" }).chromeNoSandbox).toBe(true);
    // envFlag widened the accepted tokens beyond the old `=== "1"`.
    expect(resolveEnv({ BRAIN_CHROME_NO_SANDBOX: "true" }).chromeNoSandbox).toBe(true);
    expect(resolveEnv({ BRAIN_UI_CHROME_NO_SANDBOX: "ON" }).chromeNoSandbox).toBe(true);
    expect(resolveEnv({ BRAIN_UI_CHROME_NO_SANDBOX: "0" }).chromeNoSandbox).toBe(false);
    // Unrecognised tokens fall back to the default (sandbox stays on).
    expect(resolveEnv({ BRAIN_CHROME_NO_SANDBOX: "banana" }).chromeNoSandbox).toBe(false);
  });
});

describe("config/env BRAIN_GOOGLE_ROOT_UID", () => {
  test("google root uid: a uid as the kernel prints one, anything else declares nothing", () => {
    const rootUid = (value: string | undefined) => resolveEnv(value === undefined ? {} : { BRAIN_GOOGLE_ROOT_UID: value }).google.rootUid;
    expect(rootUid(undefined)).toBeUndefined();
    expect(rootUid("65534")).toBe(65534);
    expect(rootUid(" 65534\n")).toBe(65534);
    expect(rootUid("0")).toBe(0);
    expect(rootUid("4294967294")).toBe(4294967294);
    for (const value of ["", " ", "-1", "065534", "0x fffe", "0xfffe", "6.5e4", "1e3", "65534.0", "4294967295", "99999999999", "root"]) {
      expect(rootUid(value)).toBeUndefined();
    }
  });
});

describe("config/env descriptor", () => {
  test("every statically-read variable is described exactly once", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "APIFY_TOKEN",
        "BRAIN_AGENT_RUNNER_UNAVAILABLE",
        "BRAIN_APIFY_LEDGER",
        "BRAIN_CHROME_NO_SANDBOX",
        "BRAIN_COMPUTE_STATE_DIR",
        "BRAIN_GOOGLE_GOG_PATH",
        "BRAIN_GOOGLE_HOME",
        "BRAIN_GOOGLE_KEYRING_PASSWORD",
        "BRAIN_GOOGLE_ROOT_UID",
        "BRAIN_MEDIA_PINNED_PATH_LIMIT",
        "BRAIN_MEDIA_REFERENCE_LIMITS",
        "BRAIN_PROVIDER_RELAY_SOCKET",
        "BRAIN_RERANK_MODE",
        "BRAIN_ROOT",
        "BRAIN_STORAGE_GIT_ROOTS",
        "BRAIN_UI_CHROME_NO_SANDBOX",
        "BRAIN_UI_GOG_PATH",
        "BRAIN_UI_GOOGLE_HOME",
        "BRAIN_UI_GOOGLE_KEYRING_PASSWORD",
        "BRAIN_WITHHELD_KEYS",
        "BRAIN_WORKER_CONFIG_ROOT",
        "BRAIN_WORKER_DATA_ROOT",
        "BRAIN_WORKER_OUTPUT_ALLOWANCE",
        "CLAUDE_CODE_PATH",
        "GEMINI_API_KEY",
        "NO_COLOR",
        "TYPESAFE_API_KEY",
        "XDG_BIN_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].sort()
    );
  });
});

describe("config/env readEnvVar", () => {
  test("reads a named variable from the given environment", () => {
    expect(readEnvVar("MY_PROVIDER_KEY", { MY_PROVIDER_KEY: "k" })).toBe("k");
    expect(readEnvVar("MY_PROVIDER_KEY", {})).toBeUndefined();
  });
});
