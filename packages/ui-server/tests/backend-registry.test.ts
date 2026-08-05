import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  getBackends,
  getDefaultBackendId,
  listAllProviders,
  resetBackendForTests,
} from "../src/agent/backend";
import { providerRoutes } from "../src/routes/providers";

const ENV_KEYS = [
  "AGENT_BACKEND",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "BRAIN_UI_CLAUDE_PROFILES",
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  ) as typeof savedEnv;
  for (const key of ENV_KEYS) delete process.env[key];
  resetBackendForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetBackendForTests();
});

describe("backend registry", () => {
  test("Claude-only deployment has one backend and one tagged provider", async () => {
    const backends = await getBackends();
    const providers = await listAllProviders();

    expect(backends.map((backend) => backend.id)).toEqual(["claude"]);
    expect(await getDefaultBackendId()).toBe("claude");
    expect(providers).toEqual([
      {
        id: "claude",
        label: "Claude",
        vendor: "anthropic",
        backendId: "claude",
      },
    ]);

    const response = await providerRoutes.request("/providers");
    const body = await response.json();
    expect(body.providers).toHaveLength(1);
    expect(Object.keys(body.backends)).toEqual(["claude"]);
  });

  test("a configured Gemini/Google key is ignored (native Gemini backend removed)", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GOOGLE_API_KEY = "test-google-key";
    resetBackendForTests();

    expect((await getBackends()).map((backend) => backend.id)).toEqual([
      "claude",
    ]);
    expect(await getDefaultBackendId()).toBe("claude");
  });

  test("AGENT_BACKEND naming a removed/unknown backend fails loudly", async () => {
    process.env.AGENT_BACKEND = "gemini";
    resetBackendForTests();

    await expect(getBackends()).rejects.toThrow(
      'AGENT_BACKEND="gemini" does not match any configured backend'
    );
  });

  test("pi mode remains isolated from the default Claude backend", async () => {
    process.env.AGENT_BACKEND = "pi";
    resetBackendForTests();

    try {
      expect((await getBackends()).map((backend) => backend.id)).toEqual(["pi"]);
    } catch (err) {
      // The optional pi package is intentionally absent in this checkout. The
      // legacy actionable error also proves registry construction took the pi-
      // only branch before considering the configured Gemini key.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed'
      );
    }
  });
});

describe("GET /providers", () => {
  test("returns tagged providers and a per-backend capabilities map", async () => {
    resetBackendForTests();

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
