import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import {
  createStaticBackendRegistry,
  type BackendRegistry,
} from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import {
  getBillingOverrides as readBillingOverrides,
  getCustomOpenRouterModels as readCustomModels,
  getDefaultModelId as readDefaultModelId,
  getHiddenModelIds as readHiddenModelIds,
  setBillingOverrides,
  setDefaultModelId,
  setSetting,
} from "../src/db/settings";
import { createModelRoutes } from "../src/routes/models";
import { createProviderRoutes } from "../src/routes/providers";
import { makeFakeBackend } from "./helpers/fake-backend";

let db: Database;
let registry: BackendRegistry;
let modelRoutes: Hono;
let providerRoutes: Hono;

const getHiddenModelIds = () => readHiddenModelIds(db);
const getBillingOverrides = () => readBillingOverrides(db);

beforeEach(() => {
  db = createUiDb(":memory:");
  /** Two profiles on one backend, so hiding one still leaves a picker entry. */
  registry = createStaticBackendRegistry(
    [
      makeFakeBackend({
        id: "claude",
        profiles: [
          { id: "claude-opus-5-5", label: "Claude Opus 5.5", vendor: "anthropic" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", vendor: "anthropic" },
        ],
      }),
    ],
    "claude",
    {
      getHiddenModelIds,
      getBillingOverrides,
      getDefaultModelId: () => readDefaultModelId(db),
    }
  );
  modelRoutes = createModelRoutes({ registry, db });
  providerRoutes = createProviderRoutes({ registry });
});

afterEach(() => {
  db.close();
});

describe("model catalog routes", () => {
  test("PUT /models/hidden rejects a 257 KiB JSON body before parsing it", async () => {
    const targetBytes = 257 * 1024;
    const emptyBody = JSON.stringify({ hidden: [""] });
    const body = JSON.stringify({
      hidden: ["x".repeat(targetBytes - Buffer.byteLength(emptyBody))],
    });
    expect(Buffer.byteLength(body)).toBe(targetBytes);

    const response = await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(413);
  });

  test("GET /models lists every profile, none hidden by default", async () => {
    const response = await modelRoutes.request("/models");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
    expect(body.models.every((m: { hidden: boolean }) => !m.hidden)).toBe(true);
    // No model source on a fake backend — discovery reports itself unavailable
    // rather than pretending it refreshed.
    expect(body.refreshedAt).toBeNull();
    expect(body.discovery.enabled).toBe(false);
  });

  test("PUT /models/hidden persists the set and drops it from the picker", async () => {
    const response = await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.models.find((m: { id: string }) => m.id === "claude-haiku-4-5").hidden
    ).toBe(true);
    expect(getHiddenModelIds()).toEqual(["claude-haiku-4-5"]);

    // The picker route reflects it immediately — the profile memo is dropped on
    // write, so this must not need a restart.
    const providers = await (
      await providerRoutes.request("/providers")
    ).json();
    expect(providers.providers.map((p: { id: string }) => p.id)).toEqual([
      "claude-opus-5-5",
    ]);
  });

  test("a hidden profile still resolves for sessions pinned to it", async () => {
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });

    expect(await registry.getBackendForProfile("claude-haiku-4-5")).toBeDefined();
    expect(
      (await registry.listAllProviders({ includeHidden: true })).map((p: { id: string }) => p.id)
    ).toContain("claude-haiku-4-5");
  });

  test("unhiding restores the profile to the picker", async () => {
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: [] }),
    });

    expect(getHiddenModelIds()).toEqual([]);
    expect((await registry.listAllProviders()).map((p: { id: string }) => p.id)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
  });

  test("PUT /models/hidden rejects a malformed body", async () => {
    for (const body of ['{"hidden":"claude-opus-5-5"}', '{"hidden":[1,2]}', "{}"]) {
      const response = await modelRoutes.request("/models/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(getHiddenModelIds()).toEqual([]);
  });

  test("POST /models/refresh answers 409 when the backend has no discovery", async () => {
    const response = await modelRoutes.request("/models/refresh", {
      method: "POST",
    });
    expect(response.status).toBe(409);
  });

  test("GET /models/pricing 404s when the host provided no pricing instance", async () => {
    // The default modelRoutes above is built without one — old and opted-out
    // servers degrade alike (the client hides the indicator on rejection).
    const response = await modelRoutes.request("/models/pricing");
    expect(response.status).toBe(404);
  });

  test("GET /models/pricing serves the state and kicks a background refresh", async () => {
    const calls: string[] = [];
    const state = {
      enabled: true,
      fetchedAt: 1_700_000_000_000,
      stale: false,
      source: "remote" as const,
      litellmFetchedAt: 1_700_000_000_000,
      openrouterFetchedAt: null,
    };
    const routes = createModelRoutes({
      registry,
      db,
      pricing: {
        state: () => state,
        ensureFresh: async () => {
          calls.push("ensureFresh");
        },
      },
    });

    const response = await routes.request("/models/pricing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(calls).toEqual(["ensureFresh"]); // reading the state also heals it
  });
});

describe("billing overrides", () => {
  test("the accessors round-trip and drop garbage values", () => {
    setBillingOverrides(db, { "claude-opus-5-5": "subscription", "claude-haiku-4-5": "api" });
    expect(getBillingOverrides()).toEqual({
      "claude-opus-5-5": "subscription",
      "claude-haiku-4-5": "api",
    });

    // Garbage written around the typed setter degrades to auto per entry —
    // never to a wrong mode, never to a throw.
    setSetting(db, "models.billing", { a: "free", b: "api", c: 3, d: null });
    expect(getBillingOverrides()).toEqual({ b: "api" });
    setSetting(db, "models.billing", ["api"]);
    expect(getBillingOverrides()).toEqual({});
    setSetting(db, "models.billing", "api");
    expect(getBillingOverrides()).toEqual({});
  });

  test("the override record is prototype-safe against hostile profile ids", () => {
    // A stored "__proto__" key (JSON round-trips it as an own property) must
    // neither pollute nor make prototype member names look like overrides.
    setSetting(db, "models.billing", JSON.parse('{"__proto__": "api", "real": "api"}'));
    const overrides = getBillingOverrides();
    expect(overrides["real"]).toBe("api");
    expect(({} as any).real).toBeUndefined();
    expect(overrides["constructor"]).toBeUndefined();
    expect(overrides["toString"]).toBeUndefined();
  });

  test("PUT /models/billing persists the record and the catalog reflects it", async () => {
    const response = await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: { "claude-opus-5-5": "subscription" } }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    const opus = body.models.find((m: { id: string }) => m.id === "claude-opus-5-5");
    expect(opus.billingMode).toBe("subscription");
    expect(opus.billingOverride).toBe("subscription");
    // The un-overridden row stays auto — the static registry has no
    // classifier, so auto renders as "no mode", never a guessed one.
    const haiku = body.models.find((m: { id: string }) => m.id === "claude-haiku-4-5");
    expect(haiku.billingMode).toBeUndefined();
    expect(haiku.billingOverride).toBeUndefined();
    expect(getBillingOverrides()).toEqual({ "claude-opus-5-5": "subscription" });
  });

  test("clearing the record returns every profile to auto", async () => {
    await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: { "claude-opus-5-5": "api" } }),
    });
    const response = await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: {} }),
    });
    const body = await response.json();

    expect(getBillingOverrides()).toEqual({});
    const opus = body.models.find((m: { id: string }) => m.id === "claude-opus-5-5");
    expect(opus.billingMode).toBeUndefined();
    expect(opus.billingOverride).toBeUndefined();
  });

  test("PUT /models/billing rejects a malformed body", async () => {
    for (const body of [
      '{"billing":"api"}',
      '{"billing":["api"]}',
      '{"billing":{"claude-opus-5-5":"free"}}',
      "{}",
    ]) {
      const response = await modelRoutes.request("/models/billing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(getBillingOverrides()).toEqual({});
  });
});

describe("default model routes", () => {
  test("PUT /models/default stores a known profile and resolves it", async () => {
    const response = await modelRoutes.request("/models/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultId: "claude-haiku-4-5" }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.defaultModelId).toBe("claude-haiku-4-5");
    expect(body.resolvedDefaultId).toBe("claude-haiku-4-5");
    expect(readDefaultModelId(db)).toBe("claude-haiku-4-5");

    // The picker lists the default first.
    const providers = await (await providerRoutes.request("/providers")).json();
    expect(providers.providers[0].id).toBe("claude-haiku-4-5");
  });

  test("PUT /models/default rejects an unknown profile id", async () => {
    const response = await modelRoutes.request("/models/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultId: "nope" }),
    });
    expect(response.status).toBe(400);
  });

  test("PUT /models/default null resets to auto", async () => {
    setDefaultModelId(db, "claude-haiku-4-5");
    const response = await modelRoutes.request("/models/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultId: null }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.defaultModelId).toBeNull();
    expect(readDefaultModelId(db)).toBeNull();
  });
});

describe("custom OpenRouter model routes", () => {
  test("PUT /models/custom stores well-formed ids", async () => {
    const response = await modelRoutes.request("/models/custom", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["z.ai/glm-5.3-flash", "openai/gpt-oss-120b:nitro"] }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.customModels).toEqual(["z.ai/glm-5.3-flash", "openai/gpt-oss-120b:nitro"]);
    expect(readCustomModels(db)).toEqual([
      "z.ai/glm-5.3-flash",
      "openai/gpt-oss-120b:nitro",
    ]);
  });

  test("PUT /models/custom rejects ids that are not <org>/<model>", async () => {
    for (const bad of ["no-slash", "/leading", "a b/c", "a/../b"]) {
      const response = await modelRoutes.request("/models/custom", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models: [bad] }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("removing the model behind the stored default resets the default to auto", async () => {
    setDefaultModelId(db, "openrouter:z.ai/glm-5.3-flash");
    const response = await modelRoutes.request("/models/custom", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [] }),
    });
    expect(response.status).toBe(200);
    expect(readDefaultModelId(db)).toBeNull();
  });
});

describe("custom OpenRouter collision guard", () => {
  test("a generated id owned by another source is refused before persisting", async () => {
    const collidingRegistry = createStaticBackendRegistry(
      [
        makeFakeBackend({
          id: "pi",
          profiles: [{ id: "openrouter:z.ai/glm-5.3-flash", label: "Taken", vendor: "openrouter" }],
        }),
      ],
      "pi"
    );
    const routes = createModelRoutes({ registry: collidingRegistry, db });
    const response = await routes.request("/models/custom", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["z.ai/glm-5.3-flash"] }),
    });
    expect(response.status).toBe(400);
    expect(readCustomModels(db)).toEqual([]);
  });
});

describe("thinking override routes", () => {
  function thinkingRoutes() {
    const registry = createStaticBackendRegistry(
      [
        makeFakeBackend({
          id: "pi",
          profiles: [
            { id: "gpt-sol", label: "Sol", vendor: "openai-codex", thinkingLevel: "xhigh" },
          ],
        }),
        makeFakeBackend({
          id: "claude",
          profiles: [{ id: "claude", label: "Claude", vendor: "anthropic" }],
        }),
      ],
      "claude"
    );
    return createModelRoutes({ registry, db });
  }

  test("PUT /models/thinking stores overrides for effort-capable rows and tags the catalog", async () => {
    const routes = thinkingRoutes();
    const response = await routes.request("/models/thinking", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thinking: { "gpt-sol": "low" } }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    const sol = body.models.find((m: { id: string }) => m.id === "gpt-sol");
    expect(sol.thinkingOverride).toBe("low");
  });

  test("PUT /models/thinking rejects invalid levels and effort-less profiles", async () => {
    const routes = thinkingRoutes();
    expect(
      (
        await routes.request("/models/thinking", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thinking: { "gpt-sol": "ultra" } }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await routes.request("/models/thinking", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thinking: { claude: "high" } }),
        })
      ).status
    ).toBe(400);
  });
});
