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
  getHiddenModelIds as readHiddenModelIds,
  setBillingOverrides,
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
          { id: "claude-opus-5", label: "Claude Opus 5", vendor: "anthropic" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", vendor: "anthropic" },
        ],
      }),
    ],
    "claude",
    { getHiddenModelIds, getBillingOverrides }
  );
  modelRoutes = createModelRoutes({ registry, db });
  providerRoutes = createProviderRoutes({ registry });
});

afterEach(() => {
  db.close();
});

describe("model catalog routes", () => {
  test("GET /models lists every profile, none hidden by default", async () => {
    const response = await modelRoutes.request("/models");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-5",
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
      "claude-opus-5",
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
      "claude-opus-5",
      "claude-haiku-4-5",
    ]);
  });

  test("PUT /models/hidden rejects a malformed body", async () => {
    for (const body of ['{"hidden":"claude-opus-5"}', '{"hidden":[1,2]}', "{}"]) {
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
});

describe("billing overrides", () => {
  test("the accessors round-trip and drop garbage values", () => {
    setBillingOverrides(db, { "claude-opus-5": "subscription", "claude-haiku-4-5": "api" });
    expect(getBillingOverrides()).toEqual({
      "claude-opus-5": "subscription",
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

  test("PUT /models/billing persists the record and the catalog reflects it", async () => {
    const response = await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: { "claude-opus-5": "subscription" } }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    const opus = body.models.find((m: { id: string }) => m.id === "claude-opus-5");
    expect(opus.billingMode).toBe("subscription");
    expect(opus.billingOverride).toBe("subscription");
    // The un-overridden row stays auto — the static registry has no
    // classifier, so auto renders as "no mode", never a guessed one.
    const haiku = body.models.find((m: { id: string }) => m.id === "claude-haiku-4-5");
    expect(haiku.billingMode).toBeUndefined();
    expect(haiku.billingOverride).toBeUndefined();
    expect(getBillingOverrides()).toEqual({ "claude-opus-5": "subscription" });
  });

  test("clearing the record returns every profile to auto", async () => {
    await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: { "claude-opus-5": "api" } }),
    });
    const response = await modelRoutes.request("/models/billing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billing: {} }),
    });
    const body = await response.json();

    expect(getBillingOverrides()).toEqual({});
    const opus = body.models.find((m: { id: string }) => m.id === "claude-opus-5");
    expect(opus.billingMode).toBeUndefined();
    expect(opus.billingOverride).toBeUndefined();
  });

  test("PUT /models/billing rejects a malformed body", async () => {
    for (const body of [
      '{"billing":"api"}',
      '{"billing":["api"]}',
      '{"billing":{"claude-opus-5":"free"}}',
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
