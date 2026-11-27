import { afterEach, describe, expect, test } from "bun:test";

import { ENV_VARS, resolveCronConfig, resolveServerConfig, resolveStandalonePricingConfig, subprocessEnv } from "../src/config/env";

const SUBPROCESS_KEYS = [
  "COOKIE_SECRET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "BRAIN_UI_SYNC_GITHUB_TOKEN",
  "BRAIN_UI_SUBPROCESS_ENV_EXTRA",
  "CUSTOM_CHILD_TOKEN",
  "UNKNOWN_CHILD_VALUE",
  "PI_CODING_AGENT_DIR",
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

  test("brain CLI children receive only their audience plus operator extras", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "nested-sync-test-token";
    process.env.GITHUB_TOKEN = "github-test-token";
    process.env.PI_CODING_AGENT_DIR = "/agent-only/pi";
    process.env.CUSTOM_CHILD_TOKEN = "custom-test-token";
    process.env.UNKNOWN_CHILD_VALUE = "must-not-pass";
    process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA =
      " CUSTOM_CHILD_TOKEN, ,CUSTOM_CHILD_TOKEN,bad-name ";

    const env = subprocessEnv("brainCli");

    expect(env.GITHUB_TOKEN).toBe("github-test-token");
    expect(env.CUSTOM_CHILD_TOKEN).toBe("custom-test-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("nested-sync-test-token");
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.UNKNOWN_CHILD_VALUE).toBeUndefined();
    expect(env.BRAIN_UI_SUBPROCESS_ENV_EXTRA).toBeUndefined();
  });
});

describe("config/env exec wrapper (#1363)", () => {
  test("both resolvers carry the wrapper of the environment they are given", () => {
    const env = { BRAIN_UI_EXEC_WRAPPER: "/configured/wrapper", BRAIN_UI_EXEC_KILLER: "/configured/killer" };
    const expected = { wrapper: "/configured/wrapper", killer: "/configured/killer" };
    expect(resolveServerConfig(env).exec).toEqual(expected);
    expect(resolveCronConfig(env).exec).toEqual(expected);
    expect(resolveServerConfig({}).exec).toEqual({ wrapper: undefined, killer: undefined });
  });

  test("a relative wrapper refuses configuration instead of a later spawn", () => {
    expect(() => resolveServerConfig({ BRAIN_UI_EXEC_WRAPPER: "wrapper" })).toThrow(/absolute path/);
  });
});

describe("config/env resolveCronConfig", () => {
  // The relay budget of a gated job prices from this config (`createModelPricing(config.pricing)`
  // in the cron bin), so its pricing cache must sit in the brain the job runs in (#4761).
  test("prices relay spend from the cron brain path when BRAIN_PATH is unset", () => {
    const env = { HOME: "/home/penelope", BRAIN_UI_PRICING_TTL_HOURS: "6", BRAIN_UI_PRICING_DISCOVERY: "1" };
    const config = resolveCronConfig(env);
    expect(config.brainPath).toBe("/data/brain");
    expect(config.pricing.brainPath).toBe(config.brainPath);
    // Only the brain path is the cron's own; the switch and TTL stay the standalone resolver's.
    expect(config.pricing).toEqual({ ...resolveStandalonePricingConfig(env), brainPath: "/data/brain" });
  });

  test("prices relay spend from BRAIN_PATH when it is set", () => {
    const config = resolveCronConfig({ HOME: "/home/penelope", BRAIN_PATH: "/srv/ithaca/brain" });
    expect(config.brainPath).toBe("/srv/ithaca/brain");
    expect(config.pricing.brainPath).toBe(config.brainPath);
  });

  test("uses the container DB default and allowlists the scheduled-job environment", () => {
    const config = resolveCronConfig({
      PATH: "/usr/bin",
      DB_PATH: "/data/db/custom.db",
      HOME: "/must/not/pass",
      CUSTOM_CRON_TOKEN: "custom",
      SECRET: "must-not-pass",
      BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CUSTOM_CRON_TOKEN",
    });
    expect(config.brainPath).toBe("/data/brain");
    expect(config.dbPath).toBe("/data/db/custom.db");
    expect(config.childEnv).toEqual({
      PATH: "/usr/bin",
      DB_PATH: "/data/db/custom.db",
      CUSTOM_CRON_TOKEN: "custom",
    });
    expect(config.subprocessEnvExtraNames).toEqual(["CUSTOM_CRON_TOKEN"]);
  });

  test("re-admits names carried by the generated cron wrapper", () => {
    const config = resolveCronConfig(
      {
        PATH: "/usr/bin",
        CUSTOM_CRON_TOKEN: "custom",
        UNKNOWN_CHILD_VALUE: "must-not-pass",
      },
      [" CUSTOM_CRON_TOKEN ", "bad-name", "CUSTOM_CRON_TOKEN"]
    );

    expect(config.childEnv).toEqual({
      PATH: "/usr/bin",
      CUSTOM_CRON_TOKEN: "custom",
    });
    expect(config.subprocessEnvExtraNames).toEqual(["CUSTOM_CRON_TOKEN"]);
  });

  test("honors DB_PATH", () => {
    expect(resolveCronConfig({ DB_PATH: "/custom/brain-ui.db" }).dbPath).toBe(
      "/custom/brain-ui.db"
    );
  });

  test("honors BRAIN_PATH", () => {
    expect(resolveCronConfig({ BRAIN_PATH: "/custom/brain" }).brainPath).toBe(
      "/custom/brain"
    );
  });
});

/**
 * Boolean flag parsing in resolveServerConfig — all of it goes through the
 * shared `envFlag` (@schlessera/brain-common/internal/env), so every flag accepts the same
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

describe("config/env default Claude model", () => {
  const declared = () =>
    ENV_VARS.find((v) => v.name === "BRAIN_UI_CLAUDE_DEFAULT_MODEL")!.default;

  test("unset resolves to Claude Opus 5.5", () => {
    expect(resolveServerConfig({}).agent.defaultModel).toBe("claude-opus-5-5");
  });

  test("the resolver's fallback is the declared default, so the two cannot drift", () => {
    expect(resolveServerConfig({}).agent.defaultModel).toBe(declared()!);
    expect(resolveServerConfig({ BRAIN_UI_CLAUDE_DEFAULT_MODEL: "  " }).agent.defaultModel).toBe(declared()!);
  });

  test("the variable still overrides it", () => {
    expect(
      resolveServerConfig({ BRAIN_UI_CLAUDE_DEFAULT_MODEL: "claude-sonnet-5" }).agent.defaultModel
    ).toBe("claude-sonnet-5");
  });
});

/**
 * Every numeric variable resolveServerConfig reads, one invalid value each,
 * and what it does today (#4822): refuse the boot naming the variable, or fall
 * back to a value. A later consolidation of the parsers is checked against it.
 */
describe("config/env numeric variables keep their invalid-value policy", () => {
  type Pick = (config: ReturnType<typeof resolveServerConfig>) => unknown;
  const NATIVE = { BRAIN_UI_NATIVE_BRAIN_SOCKET: "/run/ithaca/native.sock" };
  const falls: Array<[name: string, invalid: string, pick: Pick, fallback: unknown, base?: Record<string, string>]> = [
    ["BRAIN_UI_PRICING_TTL_HOURS", "x", c => c.pricing.ttlMs, 24 * 60 * 60 * 1000],
    ["MAX_CONCURRENT_SESSIONS", "x", c => c.maxConcurrentSessions, 3],
    ["BRAIN_UI_MODEL_TTL_HOURS", "x", c => c.agent.modelTtlMs, 24 * 60 * 60 * 1000],
    ["BRAIN_UI_ATTACHMENT_POOL_BYTES", "x", c => c.attachmentPoolBytes, resolveServerConfig({}).attachmentPoolBytes],
    ["BRAIN_UI_TURN_TIMEOUT_MS", "x", c => c.turnTimeoutMs, null],
    ["TRUST_PROXY_HOPS", "x", c => c.auth.trustProxyHops, 1],
    ["BRAIN_UI_WS_MAX_CONNECTIONS", "x", c => c.wsMaxConnections, 32],
    ["BRAIN_UI_WS_RATE", "x", c => c.wsRate.ratePerSecond, 20],
    ["BRAIN_UI_WS_BURST", "x", c => c.wsRate.burst, 60],
    ["VOICE_KEYTERM_LIMIT", "5OO", c => c.voice.keytermLimit, 500],
    ["BRAIN_UI_REFERENCE_VALIDATION_SECONDS", "", c => c.referenceSource?.validationMs, 300_000],
    ["BRAIN_UI_REFERENCE_REFRESH_SECONDS", "", c => c.referenceSource?.refreshMs, 300_000],
    ["BRAIN_UI_REFERENCE_ACQUISITIONS", "", c => c.referenceSource?.operations, 2],
  ];
  const refuses: Array<[name: string, invalid: string, message: string | RegExp, base?: Record<string, string>]> = [
    ["BRAIN_UI_WORKER_STATE_BYTES", "x", "BRAIN_UI_WORKER_STATE_BYTES"],
    ["BRAIN_UI_WORKER_STATE_BUDGET_BYTES", "x", "BRAIN_UI_WORKER_STATE_BUDGET_BYTES"],
    ["BRAIN_UI_TURN_TEMP_BYTES", "x", "BRAIN_UI_TURN_TEMP_BYTES"],
    ["BRAIN_UI_TURN_TEMP_BUDGET_BYTES", "x", "BRAIN_UI_TURN_TEMP_BUDGET_BYTES"],
    ["BRAIN_UI_OUTPUT_STAGING_BYTES", "x", "BRAIN_UI_OUTPUT_STAGING_BYTES"],
    ["BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES", "x", "BRAIN_UI_OUTPUT_STAGING_BUDGET_BYTES"],
    ["BRAIN_UI_MAINTENANCE_TEMP_BYTES", "x", "BRAIN_UI_MAINTENANCE_TEMP_BYTES"],
    ["BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES", "x", "BRAIN_UI_MAINTENANCE_TEMP_BUDGET_BYTES"],
    // The form limits go to a schema keyed by field, so the refusal names the field.
    ["BRAIN_UI_ASK_USER_FORM_MAX_DEPTH", "x", "maxDepth"],
    ["BRAIN_UI_ASK_USER_FORM_MAX_NODES", "x", "maxNodes"],
    ["BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS", "x", "maxOptions"],
    ["BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY", "x", "BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY"],
    ["BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY", "x", "BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY"],
    ["BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD", "x", "BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD"],
    ["BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS", "x", "BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS"],
    ["BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN", "x", "BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN"],
    ["MAX_AUTONOMOUS_RUNS", "x", "MAX_AUTONOMOUS_RUNS"],
    ["BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS", "x", "BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS"],
    ["BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS", "x", "BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS", NATIVE],
    ["BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS", "", "BRAIN_UI_NATIVE_BRAIN_TIMEOUT_MS", NATIVE],
    ["BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES", "x", "BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES", NATIVE],
    ["BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES", "", "BRAIN_UI_NATIVE_BRAIN_DELTA_BYTES", NATIVE],
    ["BRAIN_UI_REFERENCE_VALIDATION_SECONDS", "x", "BRAIN_UI_REFERENCE_VALIDATION_SECONDS"],
    ["BRAIN_UI_REFERENCE_REFRESH_SECONDS", "x", "BRAIN_UI_REFERENCE_REFRESH_SECONDS"],
    ["BRAIN_UI_REFERENCE_ACQUISITIONS", "x", "BRAIN_UI_REFERENCE_ACQUISITIONS"],
  ];

  for (const [name, invalid, pick, fallback, base] of falls) {
    test(`${name}=${JSON.stringify(invalid)} falls back to ${JSON.stringify(fallback)}`, () => {
      expect(pick(resolveServerConfig({ ...base, [name]: invalid }))).toEqual(fallback);
    });
  }
  for (const [name, invalid, message, base] of refuses) {
    test(`${name}=${JSON.stringify(invalid)} refuses the boot`, () => {
      expect(() => resolveServerConfig({ ...base, [name]: invalid })).toThrow(message);
    });
  }

  test("VOICE_KEYTERM_LIMIT keeps 0 as no terms, and unset or empty as the 500 default", () => {
    expect(resolveServerConfig({ VOICE_KEYTERM_LIMIT: "0" }).voice.keytermLimit).toBe(0);
    expect(resolveServerConfig({ VOICE_KEYTERM_LIMIT: "" }).voice.keytermLimit).toBe(500);
    expect(resolveServerConfig({}).voice.keytermLimit).toBe(500);
  });
});
