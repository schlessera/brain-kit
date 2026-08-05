import { Hono } from "hono";
import { getBackendsInfo, listAllProviders } from "../agent/backend.js";

export const providerRoutes = new Hono().get("/providers", async (c) => {
  return c.json({
    providers: await listAllProviders(),
    backends: await getBackendsInfo(),
  });
});
