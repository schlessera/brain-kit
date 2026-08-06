import { Hono } from "hono";
import {
  getBackendsInfo,
  getModelSource,
  listAllProviders,
} from "../agent/backend.js";

export const providerRoutes = new Hono().get("/providers", async (c) => {
  // Keeps the roster current without a restart: serves the cached list and
  // refreshes behind the response when it has gone stale. Only a cold start
  // (nothing cached yet) waits on the Models API.
  const source = await getModelSource();
  await source?.ensureFresh();

  return c.json({
    providers: await listAllProviders(),
    backends: await getBackendsInfo(),
  });
});
