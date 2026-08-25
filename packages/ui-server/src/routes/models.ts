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
  getHiddenModelIds,
  setBillingOverrides,
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
  return {
    models,
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
