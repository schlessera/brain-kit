// Model catalog routes — the settings screen's view of the picker.
//
// `/api/providers` answers the picker and omits hidden profiles. These routes
// answer the settings screen and therefore show everything, each row tagged
// with its visibility, plus discovery freshness so the UI can say when the list
// was last refreshed and why it might be stale.

import type { Logger } from "@opentelemetry/api-logs";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  isBillingMode,
  type BillingMode,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
} from "@schlessera/brain-ui-sdk";
import type { BackendRegistry } from "../agent/backend.js";
import type { ModelPricingState } from "../pricing/model-pricing.js";
import {
  getBillingOverrides,
  getCustomOpenRouterModels,
  getDefaultModelId,
  getHiddenModelIds,
  setBillingOverrides,
  setCustomOpenRouterModels,
  setDefaultModelId,
  setHiddenModelIds,
} from "../db/settings.js";

export function createModelRoutes(deps: {
  registry: BackendRegistry;
  db: Database;
  /** The shared pricing instance — its state drives the client's staleness indicator. */
  pricing?: { state(): ModelPricingState; ensureFresh(): Promise<void> };
  /** Where refresh failures are reported. */
  log?: Logger;
}): Hono {
  const { registry, db, pricing } = deps;

  async function buildCatalog(): Promise<ModelCatalogResponse> {
  const source = await registry.getModelSource();
  const hidden = new Set(getHiddenModelIds(db));
  const overrides = getBillingOverrides(db);
  // `billingMode` already rides each provider entry (the registry applies the
  // override last); the catalog additionally tags WHICH rows carry an explicit
  // override, so the settings screen can render auto vs forced.
  const models: ModelCatalogEntry[] = (
    await registry.listAllProviders({ includeHidden: true })
  ).map((profile) => ({
    ...profile,
    hidden: hidden.has(profile.id),
    ...(overrides[profile.id] ? { billingOverride: overrides[profile.id] } : {}),
  }));

  const state = source?.state();
  const resolvedDefaultId = await registry.getPreferredProfileId();
  return {
    models,
    defaultModelId: getDefaultModelId(db),
    ...(resolvedDefaultId ? { resolvedDefaultId } : {}),
    customModels: getCustomOpenRouterModels(db),
    refreshedAt: state?.refreshedAt ?? null,
    stale: state?.stale ?? false,
    discovery: {
      enabled: state?.enabled ?? false,
      ...(state?.error !== undefined ? { error: state.error } : {}),
    },
  };
}

  return new Hono()
  .get("/models", async (c) => {
    // Serves the cached roster immediately and refreshes behind the response
    // when stale; only a cold start (nothing cached) waits on the network.
    const source = await registry.getModelSource();
    await source?.ensureFresh();
    return c.json(await buildCatalog());
  })

  .get("/models/pricing", async (c) => {
    // Absent instance (a host that opted out) → 404; the client hides the
    // indicator on any rejection, so old and opted-out servers degrade alike.
    if (!pricing) return c.json({ error: "pricing not available" }, 404);
    // Kick a refresh behind the response when stale — reading the state is
    // also the natural moment to heal it. Never blocks: ensureFresh awaits
    // only on a true cold start.
    void pricing.ensureFresh().catch(() => {});
    return c.json(pricing.state());
  })

  .put("/models/hidden", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const hidden = (body as { hidden?: unknown } | null)?.hidden;
    if (
      !Array.isArray(hidden) ||
      hidden.some((id) => typeof id !== "string")
    ) {
      return c.json({ error: "hidden must be an array of profile ids" }, 400);
    }

    setHiddenModelIds(db, hidden as string[]);
    // The picker reads through a memo — drop it so the change is immediate.
    registry.invalidateProfiles();
    return c.json(await buildCatalog());
  })

  .put("/models/default", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const defaultId = (body as { defaultId?: unknown } | null)?.defaultId;
    if (defaultId !== null && typeof defaultId !== "string") {
      return c.json({ error: "defaultId must be a profile id or null" }, 400);
    }
    if (typeof defaultId === "string") {
      const known = await registry.listAllProviders({ includeHidden: true });
      if (!known.some((profile) => profile.id === defaultId)) {
        return c.json({ error: `Unknown profile id: ${defaultId}` }, 400);
      }
    }

    setDefaultModelId(db, defaultId);
    registry.invalidateProfiles();
    return c.json(await buildCatalog());
  })

  .put("/models/custom", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || models.some((id) => typeof id !== "string")) {
      return c.json({ error: "models must be an array of OpenRouter model ids" }, 400);
    }
    // OpenRouter ids are "<org>/<model>", org and model from a small safe
    // charset (e.g. "z.ai/glm-5.3-flash", "openai/gpt-oss-120b:nitro").
    const ID_SHAPE = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;
    const bad = (models as string[]).find((id) => !ID_SHAPE.test(id));
    if (bad !== undefined) {
      return c.json({ error: `Not an OpenRouter model id: "${bad}"` }, 400);
    }

    // A generated id ("openrouter:<model>") that collides with a profile
    // another source owns (a pi profile, a discovered model) must be refused
    // BEFORE persisting: stored, it would 500 every roster read until the
    // setting is dug out of the database. An id the CLAUDE env already
    // declares is fine — the merge dedupes it in the declared entry's favor.
    const currentCustomIds = new Set(
      getCustomOpenRouterModels(db).map((model) => `openrouter:${model}`)
    );
    const nonCustomIds = new Set(
      (await registry.listAllProviders({ includeHidden: true }))
        .filter((profile) => !currentCustomIds.has(profile.id))
        .map((profile) => profile.id)
    );
    const collision = (models as string[])
      .map((model) => `openrouter:${model}`)
      .find((id) => nonCustomIds.has(id));
    if (collision !== undefined) {
      return c.json(
        { error: `"${collision}" collides with an existing profile id.` },
        400
      );
    }

    setCustomOpenRouterModels(db, models as string[]);
    registry.invalidateProfiles();

    // A removal that takes the stored default's profile off the roster would
    // strand the default on nothing; reset it to auto — but only when the
    // profile is actually gone (an id the env also declares survives the
    // removal of its custom duplicate).
    const currentDefault = getDefaultModelId(db);
    if (currentDefault) {
      const roster = await registry.listAllProviders({ includeHidden: true });
      if (!roster.some((profile) => profile.id === currentDefault)) {
        setDefaultModelId(db, null);
      }
    }
    return c.json(await buildCatalog());
  })

  .put("/models/billing", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const billing = (body as { billing?: unknown } | null)?.billing;
    if (
      typeof billing !== "object" ||
      billing === null ||
      Array.isArray(billing) ||
      Object.values(billing).some((mode) => !isBillingMode(mode))
    ) {
      return c.json(
        { error: 'billing must map profile ids to "subscription" or "api"' },
        400
      );
    }

    setBillingOverrides(db, billing as Record<string, BillingMode>);
    // Same memo discipline as the hidden set: the next roster read (and the
    // next run's classification) must see the override immediately.
    registry.invalidateProfiles();
    return c.json(await buildCatalog());
  })

  .post("/models/refresh", async (c) => {
    const source = await registry.getModelSource();
    if (!source) {
      return c.json(
        { error: "Model discovery is not available on this backend" },
        409
      );
    }
    try {
      await source.refresh();
    } catch (err) {
      // The previous roster is still served; report the failure in the payload
      // rather than 500ing, so the settings screen can show it inline.
      deps.log?.emit({
        severityText: "WARN",
        body: "model roster refresh failed; serving the previous roster",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    registry.invalidateProfiles();
    return c.json(await buildCatalog());
  });
}
