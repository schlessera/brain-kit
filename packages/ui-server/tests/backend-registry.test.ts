import { describe, expect, test } from "bun:test";
import {
  createBackendRegistry,
  createStaticBackendRegistry,
  type BackendRegistry,
} from "../src/agent/backend";
import { createProviderRoutes } from "../src/routes/providers";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";

/**
 * Registries are built from explicit configuration through the real resolver —
 * ambient env vars (GEMINI_API_KEY, AGENT_BACKEND, ...) cannot leak in by
 * construction, which is itself the regression the old env-driven registry
 * tests guarded against.
 */
function registryFor(
  env: Record<string, string | undefined>,
  options: {
    getBillingOverrides?: () => Record<string, "subscription" | "api">;
  } = {}
): BackendRegistry {
  // NODE_ENV=test keeps model discovery off by default: a suite that silently
  // depends on network access is flaky by construction.
  const config = resolveServerConfig({ NODE_ENV: "test", ...env });
  return createBackendRegistry({
    brainPath: config.brainPath,
    agent: config.agent,
    ...options,
  });
}

describe("backend registry", () => {
  test("Claude-only deployment has one backend and one tagged provider", async () => {
    const registry = registryFor({});
    const backends = await registry.getBackends();
    const providers = await registry.listAllProviders();

    expect(backends.map((backend) => backend.id)).toEqual(["claude"]);
    expect(await registry.getDefaultBackendId()).toBe("claude");
    expect(providers).toEqual([
      {
        id: "claude",
        label: "Claude",
        vendor: "anthropic",
        source: "builtin",
        backendId: "claude",
        // No credential in the resolved env at all → "api" (nothing
        // subscription-billed can run without the OAuth token).
        billingMode: "api",
      },
    ]);

    const providerRoutes = createProviderRoutes({ registry });
    const response = await providerRoutes.request("/providers");
    const body = await response.json();
    expect(body.providers).toHaveLength(1);
    expect(Object.keys(body.backends)).toEqual(["claude"]);
  });

  test("a configured Gemini/Google key is ignored (native Gemini backend removed)", async () => {
    const registry = registryFor({
      GEMINI_API_KEY: "test-gemini-key",
      GOOGLE_API_KEY: "test-google-key",
    });

    expect((await registry.getBackends()).map((backend) => backend.id)).toEqual([
      "claude",
    ]);
    expect(await registry.getDefaultBackendId()).toBe("claude");
  });

  test("AGENT_BACKEND naming a removed/unknown backend fails loudly", async () => {
    const registry = registryFor({ AGENT_BACKEND: "gemini" });

    await expect(registry.getBackends()).rejects.toThrow(
      'AGENT_BACKEND="gemini" does not match any configured backend'
    );
  });

  test("pi mode remains isolated from the default Claude backend", async () => {
    const registry = registryFor({ AGENT_BACKEND: "pi" });

    try {
      expect((await registry.getBackends()).map((backend) => backend.id)).toEqual(["pi"]);
    } catch (err) {
      // The optional pi package is intentionally absent in this checkout. The
      // actionable error also proves registry construction took the pi-only
      // branch before considering any other backend.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed'
      );
    }
  });
});

describe("pi coexistence (BRAIN_UI_PI_PROFILES)", () => {
  const GPT_PROFILES = JSON.stringify([
    {
      id: "gpt-sol",
      label: "GPT-5.6 Sol",
      vendor: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    },
    { id: "gpt-api", label: "GPT (API)", vendor: "openai", model: "gpt-5.5" },
  ]);

  test("pi runs alongside claude; claude stays the default backend", async () => {
    const registry = registryFor({ BRAIN_UI_PI_PROFILES: GPT_PROFILES });
    const backends = await registry.getBackends();
    expect(backends.map((backend) => backend.id)).toEqual(["claude", "pi"]);
    expect(await registry.getDefaultBackendId()).toBe("claude");

    const providers = await registry.listAllProviders();
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get("gpt-sol")?.backendId).toBe("pi");
    expect(byId.get("claude")?.backendId).toBe("claude");
    expect((await registry.getBackendForProfile("gpt-sol"))?.id).toBe("pi");
  });

  test("pi profile billing keys on the vendor: openai-codex is subscription, others api", async () => {
    const registry = registryFor({ BRAIN_UI_PI_PROFILES: GPT_PROFILES });
    const providers = await registry.listAllProviders();
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get("gpt-sol")?.billingMode).toBe("subscription");
    expect(byId.get("gpt-api")?.billingMode).toBe("api");
  });

  test("malformed BRAIN_UI_PI_PROFILES fails at registry build, loudly", async () => {
    await expect(
      registryFor({ BRAIN_UI_PI_PROFILES: "not json" }).getBackends()
    ).rejects.toThrow("BRAIN_UI_PI_PROFILES is not valid JSON");
    await expect(
      registryFor({ BRAIN_UI_PI_PROFILES: '{"id":"x"}' }).getBackends()
    ).rejects.toThrow("must be a JSON array");
    await expect(
      registryFor({
        BRAIN_UI_PI_PROFILES: JSON.stringify([{ id: "x", label: "X", vendor: "openai-codex" }]),
      }).getBackends()
    ).rejects.toThrow("non-empty string model");
  });

  test("ids the Claude roster owns or can mint later are rejected at boot", async () => {
    for (const id of ["claude", "default", "claude-sonnet-5"]) {
      await expect(
        registryFor({
          BRAIN_UI_PI_PROFILES: JSON.stringify([
            { id, label: "X", vendor: "openai-codex", model: "gpt-5.6-sol" },
          ]),
        }).getBackends()
      ).rejects.toThrow("reserved for the Claude roster");
    }
  });

  test("an invalid thinkingLevel is rejected at boot", async () => {
    await expect(
      registryFor({
        BRAIN_UI_PI_PROFILES: JSON.stringify([
          {
            id: "gpt-sol",
            label: "X",
            vendor: "openai-codex",
            model: "gpt-5.6-sol",
            thinkingLevel: "ultra",
          },
        ]),
      }).getBackends()
    ).rejects.toThrow('invalid thinkingLevel "ultra"');
  });
});

describe("billing classification", () => {
  // Credential PRESENCE resolves from the env record handed to the resolver,
  // never from the test process's environment — registries are built from
  // explicit configuration by construction (see registryFor).

  test("ambient profiles are subscription-billed with only the OAuth token", async () => {
    const registry = registryFor({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
    const providers = await registry.listAllProviders();
    expect(providers[0]?.billingMode).toBe("subscription");
  });

  test("ANTHROPIC_API_KEY wins over the OAuth token (the Agent SDK's precedence)", async () => {
    const registry = registryFor({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      ANTHROPIC_API_KEY: "sk-ant-api03-test",
    });
    const providers = await registry.listAllProviders();
    expect(providers[0]?.billingMode).toBe("api");
  });

  test("a declared profile with its own credential env var is api-billed under the subscription token", async () => {
    // The declared profile's availability filter reads the REAL process env
    // for its credential var (that is where the token would live at run
    // time), so set one for the duration and restore after.
    const key = "BRAIN_UI_TEST_OPENROUTER_KEY";
    const saved = process.env[key];
    process.env[key] = "test-openrouter-token";
    try {
      const registry = registryFor({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
        BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
          {
            id: "openrouter-glm",
            label: "GLM 4.7 (OpenRouter)",
            baseUrl: "https://openrouter.example/api",
            authTokenEnv: key,
          },
        ]),
      });
      const providers = await registry.listAllProviders();
      const byId = new Map(providers.map((provider) => [provider.id, provider]));
      // The declared profile brings its own credential → api, while the
      // built-in default on ambient credentials stays subscription.
      expect(byId.get("openrouter-glm")?.billingMode).toBe("api");
      expect(byId.get("claude")?.billingMode).toBe("subscription");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a settings override is consulted last and wins", async () => {
    const registry = registryFor(
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
      { getBillingOverrides: () => ({ claude: "api" }) }
    );
    const providers = await registry.listAllProviders();
    expect(providers[0]?.billingMode).toBe("api");
  });
});

describe("GET /providers", () => {
  test("returns tagged providers and a per-backend capabilities map", async () => {
    const registry = registryFor({});
    const providerRoutes = createProviderRoutes({ registry });

    const response = await providerRoutes.request("/providers");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers.map((provider: { backendId: string }) => provider.backendId))
      .toEqual(["claude"]);
    expect(Object.keys(body.backends)).toEqual(["claude"]);
    expect(body.backends.claude.id).toBe("claude");
    expect(typeof body.backends.claude.capabilities.followUp).toBe("boolean");
    expect(body.backend).toBeUndefined();
  });
});

describe("static registry (test/embedder seam)", () => {
  test("orders the default backend first and resolves sessions to it", async () => {
    const registry = createStaticBackendRegistry(
      [makeFakeBackend({ id: "a" }), makeFakeBackend({ id: "b" })],
      "b"
    );

    expect((await registry.getBackends()).map((backend) => backend.id)).toEqual([
      "b",
      "a",
    ]);
    expect((await registry.getBackendForSession(null)).id).toBe("b");
    expect((await registry.getBackendForSession("a")).id).toBe("a");
    expect((await registry.getBackendForSession("missing")).id).toBe("b");
  });
});
