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
function registryFor(env: Record<string, string | undefined>): BackendRegistry {
  // NODE_ENV=test keeps model discovery off by default: a suite that silently
  // depends on network access is flaky by construction.
  const config = resolveServerConfig({ NODE_ENV: "test", ...env });
  return createBackendRegistry({
    brainPath: config.brainPath,
    agent: config.agent,
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
