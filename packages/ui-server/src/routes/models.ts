// Model catalog routes — the settings screen's view of the picker.
//
// `/api/providers` answers the picker and omits hidden profiles. These routes
// answer the settings screen and therefore show everything, each row tagged
// with its visibility, plus discovery freshness so the UI can say when the list
// was last refreshed and why it might be stale.

import { Hono } from "hono";
import type {
  ModelCatalogEntry,
  ModelCatalogResponse,
} from "@schlessera/brain-ui-sdk";
import {
  getModelSource,
  invalidateProfiles,
  listAllProviders,
} from "../agent/backend.js";
import { getHiddenModelIds, setHiddenModelIds } from "../db/settings.js";

async function buildCatalog(): Promise<ModelCatalogResponse> {
  const source = await getModelSource();
  const hidden = new Set(getHiddenModelIds());
  const models: ModelCatalogEntry[] = (
    await listAllProviders({ includeHidden: true })
  ).map((profile) => ({ ...profile, hidden: hidden.has(profile.id) }));

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

export const modelRoutes = new Hono()
  .get("/models", async (c) => {
    // Serves the cached roster immediately and refreshes behind the response
    // when stale; only a cold start (nothing cached) waits on the network.
    const source = await getModelSource();
    await source?.ensureFresh();
    return c.json(await buildCatalog());
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

    setHiddenModelIds(hidden as string[]);
    // The picker reads through a memo — drop it so the change is immediate.
    invalidateProfiles();
    return c.json(await buildCatalog());
  })

  .post("/models/refresh", async (c) => {
    const source = await getModelSource();
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
      console.warn(
        `[models] Refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    invalidateProfiles();
    return c.json(await buildCatalog());
  });
