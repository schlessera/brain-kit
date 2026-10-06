import { Hono } from "hono";
import type { BackendRegistry } from "../agent/backend.js";

export function createProviderRoutes(deps: { registry: BackendRegistry }): Hono {
  const { registry } = deps;
  return new Hono().get("/providers", async (c) => {
    // Keeps the roster current without a restart: serves the cached list and
    // refreshes behind the response when it has gone stale. Only a cold start
    // (nothing cached yet) waits on the Models API.
    const source = await registry.getModelSource();
    await source?.ensureFresh();

    const providers = await registry.listAllProviders();
    const backends = await registry.getBackendsInfo();
    const unavailable = await registry.listUnavailableProviders();
    return c.json({
      providers,
      backends,
      // Configured but not runnable now (#1044), apart from the runnable
      // roster; absent when there are none, so the response is unchanged.
      ...(unavailable.length > 0 ? { unavailable } : {}),
    });
  });
}
