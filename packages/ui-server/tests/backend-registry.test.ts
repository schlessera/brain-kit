import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@schlessera/brain-ui-sdk";
import {
  defineBackendModule,
  type BackendModelSource,
  type BackendModuleContext,
} from "@schlessera/brain-ui-sdk/server";
import {
  createBackendRegistry,
  createStaticBackendRegistry,
  type BackendRegistry,
} from "../src/agent/backend";
import { createProviderRoutes } from "../src/routes/providers";
import { createModelRoutes } from "../src/routes/models";
import { createUiDb } from "../src/db/client";
import { getDefaultModelId, getThinkingOverrides, setDefaultModelId } from "../src/db/settings";
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
    getDefaultModelId?: () => string | null;
    getCustomOpenRouterModels?: () => string[];
    getThinkingOverrides?: () => Record<string, ThinkingLevel>;
    getHiddenModelIds?: () => string[];
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
        thinkingLevel: "medium",
        supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        backendId: "claude",
        // A profile without its own credential runs on the subscription or
        // is refused before its prompt is sent (#253), so it is never "api"
        // — not even with no credential in the environment at all.
        billingMode: "subscription",
        // No baseUrl, so the turn goes to Anthropic's own endpoint and is
        // billed at Anthropic's rates — the "direct" pricing catalog.
        pricingRoute: "direct",
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

  test("pi profile pricing route keys on the vendor: only openrouter resells (#57)", async () => {
    const registry = registryFor({
      BRAIN_UI_PI_PROFILES: JSON.stringify([
        { id: "gpt-sol", label: "GPT", vendor: "openai-codex", model: "gpt-5.6-sol" },
        { id: "or-glm", label: "GLM", vendor: "openrouter", model: "z-ai/glm-4.7" },
      ]),
    });
    const byId = new Map(
      (await registry.listAllProviders()).map((provider) => [provider.id, provider])
    );
    // A pi vendor IS the provider endpoint, so it names the route — but only
    // for providers we can actually place.
    expect(byId.get("or-glm")?.pricingRoute).toBe("openrouter");
    expect(byId.get("gpt-sol")?.pricingRoute).toBe("direct");
  });

  test("pi aggregators and inference hosts get no route, not a guessed one (#57)", async () => {
    const registry = registryFor({
      BRAIN_UI_PI_PROFILES: JSON.stringify([
        // Aggregators: they resell, and neither catalog carries their rates.
        { id: "via-vercel", label: "V", vendor: "vercel-ai-gateway", model: "anthropic/claude-sonnet-4.5" },
        { id: "via-opencode", label: "O", vendor: "opencode", model: "anthropic/claude-sonnet-4.5" },
        // An inference host serving someone else's open weights at its own
        // price — not the model vendor, so not the vendor's rate either.
        { id: "via-groq", label: "G", vendor: "groq", model: "openai/gpt-oss-120b" },
      ]),
    });
    const byId = new Map(
      (await registry.listAllProviders()).map((provider) => [provider.id, provider])
    );

    // Present in the roster, but deliberately unrouted: calling any of these
    // "direct" would make a vendor list price authoritative for a run that was
    // never billed at it. No route means pricing falls back to model id, which
    // is what every run did before routes existed.
    for (const id of ["via-vercel", "via-opencode", "via-groq"]) {
      expect(byId.get(id)).toBeDefined();
      expect(byId.get(id)?.pricingRoute).toBeUndefined();
    }
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

  test("a collision with a declared Claude profile id is rejected at boot", async () => {
    await expect(
      registryFor({
        BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
          { id: "fast", label: "Fast (Anthropic)" },
        ]),
        BRAIN_UI_PI_PROFILES: JSON.stringify([
          { id: "fast", label: "Fast (OpenAI)", vendor: "openai-codex", model: "gpt-5.5" },
        ]),
      }).getBackends()
    ).rejects.toThrow('collides with a BRAIN_UI_CLAUDE_PROFILES entry');
  });

  test("pi-primary validates collisions against the inactive Claude roster", async () => {
    await expect(
      registryFor({
        AGENT_BACKEND: "pi",
        BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
          { id: "shared", label: "Shared (Anthropic)" },
        ]),
        BRAIN_UI_PI_PROFILES: JSON.stringify([
          {
            id: "shared",
            label: "Shared (OpenAI)",
            vendor: "openai-codex",
            model: "gpt-5.5",
          },
        ]),
      }).getBackends()
    ).rejects.toThrow('collides with a BRAIN_UI_CLAUDE_PROFILES entry');
  });

  test("pi-primary registry ignores malformed inactive Claude roster entries", async () => {
    for (const inactiveRoster of ["not json", JSON.stringify([{}])]) {
      const registry = registryFor({
        AGENT_BACKEND: "pi",
        BRAIN_UI_CLAUDE_PROFILES: inactiveRoster,
        BRAIN_UI_PI_PROFILES: JSON.stringify([
          {
            id: "gpt-test",
            label: "GPT Test",
            vendor: "openai-codex",
            model: "gpt-5.5",
          },
        ]),
      });

      expect((await registry.getBackends()).map((backend) => backend.id)).toEqual(["pi"]);
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

describe("configured GPT-6 profiles", () => {
  test("the real pi descriptor feeds the catalog and picker without changing a stored default", async () => {
    const profiles = [
      { id: "existing-sol", label: "Existing Sol", vendor: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "high" },
      ...["openai", "openai-codex"].flatMap((vendor) =>
        ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"].map((model) => ({
          id: `configured-${vendor}-${model}`,
          label: `${model} (${vendor})`,
          vendor,
          model,
          thinkingLevel: "xhigh",
        }))
      ),
    ];
    expect(profiles).toHaveLength(9);
    const db = createUiDb(":memory:");
    try {
      setDefaultModelId(db, "existing-sol");
      const registry = registryFor({
        AGENT_BACKEND: "pi",
        BRAIN_UI_PI_PROFILES: JSON.stringify(profiles),
      }, {
        getDefaultModelId: () => getDefaultModelId(db),
        getThinkingOverrides: () => getThinkingOverrides(db),
      });
      const providers = createProviderRoutes({ registry });
      const models = createModelRoutes({ registry, db });
      const expected = profiles.map(({ id, label, vendor, model, thinkingLevel }) => ({
        id, label, vendor, thinkingLevel, backendId: "pi",
        supportedThinkingLevels: [
          ...(["gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna"].includes(model) ? ["off"] : []),
          ...(vendor === "openai-codex" ? ["minimal"] : []),
          "low", "medium", "high", "xhigh", "max",
        ],
        billingMode: vendor === "openai-codex" ? "subscription" : "api",
        pricingRoute: "direct",
      }));
      const pickerResponse = await providers.request("/providers");
      expect(pickerResponse.status).toBe(200);
      expect((await pickerResponse.json()).providers).toEqual(expected);
      const catalogResponse = await models.request("/models");
      expect(catalogResponse.status).toBe(200);
      const catalog = await catalogResponse.json();
      expect(catalog.models).toEqual(expected.map((row) => ({ ...row, hidden: false })));
      expect(catalog.defaultModelId).toBe("existing-sol");
      expect(catalog.resolvedDefaultId).toBe("existing-sol");
      expect(catalog.discovery.enabled).toBe(false);
      expect((await registry.getBackendForProfile("configured-openai-gpt-6.1-sol"))?.id).toBe("pi");

      const changed = await models.request("/models/thinking", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinking: { "configured-openai-gpt-6.1-sol": "low" } }),
      });
      expect(changed.status).toBe(200);
      expect(getThinkingOverrides(db)).toEqual({ "configured-openai-gpt-6.1-sol": "low" });
      const updatedPicker = (await (await providers.request("/providers")).json()).providers;
      expect(updatedPicker).toEqual(expected.map((row) =>
        row.id === "configured-openai-gpt-6.1-sol" ? { ...row, thinkingLevel: "low" } : row
      ));
      expect(getDefaultModelId(db)).toBe("existing-sol");
    } finally {
      db.close();
    }
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

  test("an ambient ANTHROPIC_API_KEY no longer makes a credential-free profile api-billed (#253)", async () => {
    // The CLI would prefer the key; the backend clears it and checks the
    // account before the prompt is sent, so the turn bills the subscription.
    const registry = registryFor({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      ANTHROPIC_API_KEY: "sk-ant-api03-test",
    });
    const providers = await registry.listAllProviders();
    expect(providers[0]?.billingMode).toBe("subscription");
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

  test("a profile's pricing route follows its declared endpoint (#57)", async () => {
    const key = "BRAIN_UI_TEST_ROUTE_KEY";
    const saved = process.env[key];
    process.env[key] = "test-token";
    try {
      const registry = registryFor({
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
        BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
          {
            id: "via-openrouter",
            label: "GLM 4.7 (OpenRouter)",
            baseUrl: "https://openrouter.ai/api",
            authTokenEnv: key,
          },
          {
            id: "via-openrouter-subdomain",
            label: "GLM 4.7 (OpenRouter, regional)",
            baseUrl: "https://eu.openrouter.ai/api",
            authTokenEnv: key,
          },
          {
            id: "via-unknown-proxy",
            label: "Something behind a gateway",
            baseUrl: "https://gateway.example/api",
            authTokenEnv: key,
          },
        ]),
      });
      const byId = new Map(
        (await registry.listAllProviders()).map((provider) => [provider.id, provider])
      );

      // Routed through OpenRouter, so OpenRouter's resale rates apply.
      expect(byId.get("via-openrouter")?.pricingRoute).toBe("openrouter");
      expect(byId.get("via-openrouter-subdomain")?.pricingRoute).toBe("openrouter");
      // No baseUrl: Anthropic's own endpoint, billed at Anthropic's rates.
      expect(byId.get("claude")?.pricingRoute).toBe("direct");
      // Some other Anthropic-compatible proxy may resell at rates neither
      // catalog describes. Claiming "direct" would freeze a rate this run was
      // never billed at, so the route is left absent and pricing falls back to
      // resolving by model id — what it did before routes existed.
      expect(byId.get("via-unknown-proxy")).toBeDefined();
      expect(byId.get("via-unknown-proxy")?.pricingRoute).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a custom OpenRouter model routes to openrouter, listed or re-listed (#57)", async () => {
    // Custom models are minted inside the backend's memoized profiles()
    // closure, so their route is learned on the FIRST listing and must
    // survive the cache hit on every later one. classifyBilling has the same
    // dependency; this pins it for the route too.
    //
    // A custom profile declares OPENROUTER_API_KEY, and profile availability
    // reads the REAL process env for it. Set it here rather than inheriting
    // whatever the machine happens to have: on a developer box that exports a
    // real key this passed for the wrong reason, and the roster came back
    // empty as soon as another suite cleared it.
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const registry = registryFor(
        { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        { getCustomOpenRouterModels: () => ["z-ai/glm-4.7"] }
      );

      const routeOnListing = async () => {
        const providers = await registry.listAllProviders();
        const custom = providers.find((p) => p.id === "openrouter:z-ai/glm-4.7");
        expect(custom).toBeDefined();
        return custom?.pricingRoute;
      };

      // First listing mints the profile; the second is served from the
      // closure's merge cache, which skips the branch that learned the route.
      expect(await routeOnListing()).toBe("openrouter");
      expect(await routeOnListing()).toBe("openrouter");
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  test("an inherited ANTHROPIC_BASE_URL decides the route, not the missing override (#57)", async () => {
    // A profile that declares no baseUrl does not thereby reach Anthropic:
    // buildEnv() sets nothing and the host's own ANTHROPIC_BASE_URL rides the
    // subprocess env allowlist into the turn. An operator who pointed that at
    // OpenRouter would otherwise have every run frozen at Anthropic's rates —
    // exactly the mispricing this issue is about, one level up.
    const saved = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
      const viaEnv = new Map(
        (await registryFor({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" })
          .listAllProviders())
          .map((provider) => [provider.id, provider])
      );
      expect(viaEnv.get("claude")?.pricingRoute).toBe("openrouter");

      // An inherited endpoint nobody can place is no route at all.
      process.env.ANTHROPIC_BASE_URL = "https://gateway.example/api";
      const viaProxy = new Map(
        (await registryFor({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" })
          .listAllProviders())
          .map((provider) => [provider.id, provider])
      );
      expect(viaProxy.get("claude")).toBeDefined();
      expect(viaProxy.get("claude")?.pricingRoute).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
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
  test("orders the default backend first and rejects unknown stored backend ids", async () => {
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
    await expect(registry.getBackendForSession("missing")).rejects.toThrow(
      'Stored backend id "missing" is not configured.'
    );
  });

  test("keeps a by-value descriptor resolution's hooks and model source", async () => {
    const backend = makeFakeBackend({
      id: "custom",
      profiles: [{ id: "custom-pro", label: "Custom Pro", vendor: "acme" }],
    });
    const modelSource: BackendModelSource = {
      list: () => [{ id: "custom-pro", label: "Custom Pro", vendor: "acme" }],
      state: () => ({ enabled: true, refreshedAt: 1, stale: false }),
      ensureFresh: async () => {},
      refresh: async () => {},
    };
    const customModule = defineBackendModule({
      id: "custom",
      profileSchema: {
        source: "BRAIN_UI_CUSTOM_PROFILES",
        parse() {
          return {
            ok: true,
            profiles: [{ id: "custom-pro", label: "Custom Pro", vendor: "acme" }],
          };
        },
      },
      settingsHooks: { defaultModelId: true, billingOverrides: true },
      modelSource: () => modelSource,
      resolveFromEnv(context) {
        const preferredId = context.settings.getDefaultModelId?.() ?? null;
        return {
          ok: true,
          value: {
            backend,
            classifyBilling: () => "subscription",
            preferredProfile: {
              matches: (profile) => profile.id === preferredId,
              hasCredential: () => true,
            },
          },
        };
      },
    });
    const parsed = customModule.profileSchema.parse(null, {
      occupiedProfiles: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors[0]?.message);
    const base: BackendModuleContext = {
      brainPath: "/tmp/brain",
      config: {},
      profiles: parsed.profiles,
      confirmBashPatterns: null,
      settings: {
        getDefaultModelId: () => "custom-pro",
        getBillingOverrides: () => ({}),
      },
    };
    const source = customModule.modelSource?.(base) ?? null;
    const resolution = await customModule.resolveFromEnv({
      ...base,
      ...(source ? { modelSource: source } : {}),
    });
    if (!resolution.ok) throw resolution.error;

    const registry = createStaticBackendRegistry(
      [resolution.value],
      resolution.value.backend.id,
      { modelSource: source }
    );
    expect((await registry.listAllProviders())[0]?.billingMode).toBe("subscription");
    expect(await registry.getPreferredProfileId()).toBe("custom-pro");
    expect(await registry.getModelSource()).toBe(modelSource);
  });
});

describe("preferred default profile", () => {
  const GPT = JSON.stringify([
    { id: "gpt-sol", label: "Sol", vendor: "openai-codex", model: "gpt-5.6-sol" },
  ]);

  /** Point pi's auth store at a temp dir, with or without a codex credential. */
  async function withPiAuthDir(
    credential: boolean,
    fn: () => Promise<void>
  ): Promise<void> {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/pi-auth-test-${Math.random().toString(36).slice(2)}`;
    const { mkdirSync, writeFileSync, rmSync } = await import("fs");
    mkdirSync(`${dir}/agent`, { recursive: true });
    if (credential) {
      writeFileSync(
        `${dir}/agent/auth.json`,
        JSON.stringify({ "openai-codex": { type: "oauth", access: "x", refresh: "y", expires: 1 } })
      );
    }
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = `${dir}/agent`;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a stored default wins and leads the provider list", async () => {
    const registry = registryFor(
      { BRAIN_UI_PI_PROFILES: GPT },
      { getDefaultModelId: () => "gpt-sol" }
    );
    expect(await registry.getPreferredProfileId()).toBe("gpt-sol");
    expect((await registry.listAllProviders())[0]?.id).toBe("gpt-sol");
  });

  test("a stored default naming a vanished profile falls through", async () => {
    await withPiAuthDir(false, async () => {
      const registry = registryFor(
        { BRAIN_UI_PI_PROFILES: GPT },
        { getDefaultModelId: () => "gone" }
      );
      expect(await registry.getPreferredProfileId()).toBeNull();
    });
  });

  test("auto prefers a CONNECTED openai-codex profile, else none", async () => {
    await withPiAuthDir(true, async () => {
      const registry = registryFor({ BRAIN_UI_PI_PROFILES: GPT });
      expect(await registry.getPreferredProfileId()).toBe("gpt-sol");
      expect((await registry.listAllProviders())[0]?.id).toBe("gpt-sol");
    });
    await withPiAuthDir(false, async () => {
      const registry = registryFor({ BRAIN_UI_PI_PROFILES: GPT });
      expect(await registry.getPreferredProfileId()).toBeNull();
      expect((await registry.listAllProviders())[0]?.id).toBe("claude");
    });
  });

  test("a hidden codex profile is not auto-preferred", async () => {
    await withPiAuthDir(true, async () => {
      const registry = registryFor(
        { BRAIN_UI_PI_PROFILES: GPT },
        { getHiddenModelIds: () => ["gpt-sol"] }
      );
      expect(await registry.getPreferredProfileId()).toBeNull();
    });
  });
});

describe("custom OpenRouter models", () => {
  test("stored ids join the Claude roster as api-billed declared profiles", async () => {
    const key = "OPENROUTER_API_KEY";
    const saved = process.env[key];
    process.env[key] = "test-openrouter-token";
    try {
      const registry = registryFor(
        { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" },
        { getCustomOpenRouterModels: () => ["z.ai/glm-5.3-flash"] }
      );
      const providers = await registry.listAllProviders();
      const custom = providers.find((p) => p.id === "openrouter:z.ai/glm-5.3-flash");
      expect(custom).toBeDefined();
      expect(custom?.backendId).toBe("claude");
      expect(custom?.billingMode).toBe("api");
      // The ambient default stays subscription-billed.
      expect(providers.find((p) => p.id === "claude")?.billingMode).toBe("subscription");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a list change is visible after invalidateProfiles", async () => {
    const key = "OPENROUTER_API_KEY";
    const saved = process.env[key];
    process.env[key] = "test-openrouter-token";
    try {
      let models: string[] = [];
      const registry = registryFor({}, { getCustomOpenRouterModels: () => models });
      expect(
        (await registry.listAllProviders()).some((p) => p.id.startsWith("openrouter:"))
      ).toBe(false);
      models = ["z.ai/glm-5.3-flash"];
      registry.invalidateProfiles();
      expect(
        (await registry.listAllProviders()).some(
          (p) => p.id === "openrouter:z.ai/glm-5.3-flash"
        )
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});

describe("per-profile thinking overrides", () => {
  const GPT = JSON.stringify([
    {
      id: "gpt-sol",
      label: "Sol",
      vendor: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    },
  ]);

  test("an override replaces the configured level at read time, live after invalidate", async () => {
    let overrides: Record<string, "low" | "max"> = {};
    const registry = registryFor(
      { BRAIN_UI_PI_PROFILES: GPT },
      { getThinkingOverrides: () => overrides }
    );
    const before = await registry.listAllProviders();
    expect(before.find((p) => p.id === "gpt-sol")?.thinkingLevel).toBe("xhigh");

    overrides = { "gpt-sol": "low" };
    registry.invalidateProfiles();
    const after = await registry.listAllProviders();
    expect(after.find((p) => p.id === "gpt-sol")?.thinkingLevel).toBe("low");
  });

  test("claude rows expose the built-in effort default and native supported levels", async () => {
    const registry = registryFor({ BRAIN_UI_PI_PROFILES: GPT });
    const providers = await registry.listAllProviders();
    expect(providers.find((p) => p.id === "claude")).toMatchObject({ thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] });
  });
});
