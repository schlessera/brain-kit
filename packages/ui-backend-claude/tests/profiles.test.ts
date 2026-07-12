import { expect, test, describe, afterEach } from "bun:test";
import {
  defineProfiles,
  DEFAULT_PROFILES,
  getProfile,
  isAvailable,
  listProfiles,
} from "../src/profiles";

const TOUCHED_ENV = [
  "OPENROUTER_API_KEY",
  "PROXY_TOKEN",
  "DIRECT_API_KEY",
];
afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
});

describe("defineProfiles / buildEnv", () => {
  test("built-in default profile is env-free and always available", () => {
    expect(DEFAULT_PROFILES).toHaveLength(1);
    const claude = DEFAULT_PROFILES[0]!;
    expect(claude.id).toBe("claude");
    expect(claude.label).toBe("Claude");
    expect(claude.vendor).toBe("anthropic");
    expect(claude.model).toBeUndefined();
    expect(claude.requiredEnvKeys).toEqual([]);
    expect(claude.buildEnv()).toEqual({});
    expect(isAvailable(claude)).toBe(true);
  });

  test("proxy profile remaps base URL, auth token, and model aliases", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-123";
    const [profile] = defineProfiles([
      {
        id: "openrouter-glm",
        label: "OpenRouter · GLM",
        vendor: "openrouter",
        model: "z-ai/glm-4.7",
        baseUrl: "https://openrouter.ai/api",
        authTokenEnv: "OPENROUTER_API_KEY",
        modelAliases: true,
      },
    ]);

    expect(profile!.requiredEnvKeys).toEqual(["OPENROUTER_API_KEY"]);
    expect(profile!.buildEnv()).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-123",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "z-ai/glm-4.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "z-ai/glm-4.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "z-ai/glm-4.7",
      CLAUDE_CODE_SUBAGENT_MODEL: "z-ai/glm-4.7",
    });
  });

  test("missing auth token yields an empty ANTHROPIC_AUTH_TOKEN", () => {
    const [profile] = defineProfiles([
      {
        id: "proxy",
        label: "Proxy",
        model: "m",
        baseUrl: "https://proxy.example",
        authTokenEnv: "PROXY_TOKEN",
      },
    ]);
    // No model aliases requested → alias envs are not emitted.
    expect(profile!.buildEnv()).toEqual({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
  });

  test("apiKeyEnv drives ANTHROPIC_API_KEY", () => {
    process.env.DIRECT_API_KEY = "sk-direct";
    const [profile] = defineProfiles([
      {
        id: "direct",
        label: "Direct",
        baseUrl: "https://api.example",
        apiKeyEnv: "DIRECT_API_KEY",
      },
    ]);
    expect(profile!.requiredEnvKeys).toEqual(["DIRECT_API_KEY"]);
    expect(profile!.buildEnv()).toEqual({
      ANTHROPIC_BASE_URL: "https://api.example",
      ANTHROPIC_API_KEY: "sk-direct",
    });
  });
});

describe("availability + listProfiles", () => {
  test("isAvailable requires every declared env key to be present and non-empty", () => {
    const [profile] = defineProfiles([
      { id: "p", label: "P", authTokenEnv: "PROXY_TOKEN" },
    ]);
    expect(isAvailable(profile!)).toBe(false);
    process.env.PROXY_TOKEN = "   ";
    expect(isAvailable(profile!)).toBe(false);
    process.env.PROXY_TOKEN = "tok";
    expect(isAvailable(profile!)).toBe(true);
  });

  test("listProfiles exposes safe metadata for available profiles only", () => {
    const profiles = defineProfiles([
      { id: "claude", label: "Claude", vendor: "anthropic" },
      {
        id: "gated",
        label: "Gated",
        vendor: "openrouter",
        authTokenEnv: "OPENROUTER_API_KEY",
      },
    ]);

    expect(listProfiles(profiles)).toEqual([
      { id: "claude", label: "Claude", vendor: "anthropic" },
    ]);

    process.env.OPENROUTER_API_KEY = "sk";
    expect(listProfiles(profiles)).toEqual([
      { id: "claude", label: "Claude", vendor: "anthropic" },
      { id: "gated", label: "Gated", vendor: "openrouter" },
    ]);
  });

  test("getProfile finds by id", () => {
    const profiles = defineProfiles([{ id: "a", label: "A" }]);
    expect(getProfile(profiles, "a")?.label).toBe("A");
    expect(getProfile(profiles, "missing")).toBeUndefined();
  });
});
