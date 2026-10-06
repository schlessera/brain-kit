import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createBackendRegistry, createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createProviderRoutes } from "../src/routes/providers";
import { makeFakeBackend } from "./helpers/fake-backend";

/**
 * Configured-but-unavailable profiles (#1044, ruled 2026-10-06: Option B with
 * a closed reason enum). They travel apart from the runnable roster, which
 * keeps meaning "runnable now", and carry only id, label, the enum reason and
 * the reporting backend.
 */

const KEY = "BRAIN_UI_TEST_ITHACA_PROXY_TOKEN";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

function realRegistry(hidden: string[] = []) {
  const config = resolveServerConfig({
    NODE_ENV: "test",
    BRAIN_UI_CLAUDE_PROFILES: JSON.stringify([
      { id: "ithaca-proxy", label: "Ithaca proxy", baseUrl: "https://proxy.example/api", authTokenEnv: KEY },
    ]),
    BRAIN_UI_PI_PROFILES: JSON.stringify([
      { id: "gpt-api", label: "GPT (API)", vendor: "openai", model: "gpt-5.5" },
    ]),
  });
  return createBackendRegistry({
    brainPath: config.brainPath,
    agent: config.agent,
    getHiddenModelIds: () => hidden,
  });
}

async function providersBody(registry: ReturnType<typeof realRegistry>) {
  const response = await createProviderRoutes({ registry }).request("/providers");
  expect(response.status).toBe(200);
  return { text: await response.clone().text(), body: await response.json() };
}

describe("unavailable profiles through the real Claude and pi adapters", () => {
  test("a Claude profile missing its key is listed apart, with only the enum reason", async () => {
    const registry = realRegistry();
    const runnable = (await registry.listAllProviders()).map((p) => p.id);
    expect(runnable).toEqual(["claude", "gpt-api"]);
    // Routing never sees it: it is not a valid providerId.
    expect(await registry.getBackendForProfile("ithaca-proxy")).toBeUndefined();

    const { text, body } = await providersBody(registry);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(runnable);
    expect(body.unavailable).toEqual([
      { id: "ithaca-proxy", label: "Ithaca proxy", reason: "needs-credentials", backendId: "claude" },
    ]);
    // No configuration detail leaves the host.
    expect(text).not.toContain(KEY);
  });

  test("with the key set, the profile is runnable and the field is absent", async () => {
    process.env[KEY] = "test-token";
    const registry = realRegistry();
    const { body } = await providersBody(registry);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["claude", "ithaca-proxy", "gpt-api"]);
    expect("unavailable" in body).toBe(false);
  });

  test("a hidden profile stays hidden when it is unavailable", async () => {
    const { body } = await providersBody(realRegistry(["ithaca-proxy"]));
    expect("unavailable" in body).toBe(false);
  });
});

describe("the registry admits only the closed enum", () => {
  function reporting(id: string, report: AgentBackend["listUnavailableProfiles"]): AgentBackend {
    return { ...makeFakeBackend({ id }), listUnavailableProfiles: report };
  }

  test("free text, extra fields and malformed entries never reach the wire", async () => {
    const registry = createStaticBackendRegistry([
      reporting("odysseus", () => [
        { id: "ok", label: "Ok", reason: "needs-credentials", detail: "set ODYSSEUS_KEY" } as never,
        { id: "free", label: "Free", reason: "ODYSSEUS_KEY is not set" } as never,
        { id: "", label: "Blank", reason: "needs-credentials" },
        null as never,
      ]),
    ]);
    const response = await createProviderRoutes({ registry }).request("/providers");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.unavailable).toEqual([
      { id: "ok", label: "Ok", reason: "needs-credentials", backendId: "odysseus" },
    ]);
    expect(text).not.toContain("ODYSSEUS_KEY");
    expect(body.providers).toEqual([{ id: "odysseus", label: "ODYSSEUS", backendId: "odysseus" }]);
  });

  test("a backend that throws reports none and leaves the roster and other backends intact", async () => {
    const registry = createStaticBackendRegistry([
      reporting("penelope", () => {
        throw new Error("boom");
      }),
      reporting("telemachus", async () => [{ id: "t-off", label: "T off", reason: "needs-credentials" }]),
    ]);
    const response = await createProviderRoutes({ registry }).request("/providers");
    const body = await response.json();
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["penelope", "telemachus"]);
    expect(body.unavailable).toEqual([
      { id: "t-off", label: "T off", reason: "needs-credentials", backendId: "telemachus" },
    ]);
  });

  test("a backend without the member reports none; the response is unchanged", async () => {
    const registry = createStaticBackendRegistry([makeFakeBackend({ id: "odysseus" })]);
    const response = await createProviderRoutes({ registry }).request("/providers");
    expect(Object.keys(await response.json())).toEqual(["providers", "backends"]);
  });
});
