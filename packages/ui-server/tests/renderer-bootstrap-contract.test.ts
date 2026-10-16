import { expect, test } from "bun:test";
import { createStatusRoutes } from "../src/routes/health.js";

test("authenticated status wire carries renderer declarations and versions without import specifiers", async () => {
  const contentRenderers = [{ module: "voyage", version: "0.43.1", name: "voyage-map", fences: ["voyage"], extensions: [".voyage"] }];
  const app = createStatusRoutes({ sourceCommit: "dev", getCronStatus: () => [], isTurnActive: () => false,
    getContentRenderers: async () => contentRenderers } as Parameters<typeof createStatusRoutes>[0]);
  const response = await app.request("/status");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.contentRenderers, "STATUS_WIRE_DECLARES_CONFIGURED_RENDERERS").toEqual(contentRenderers);
  expect(body).toMatchObject({ healthy: true, cronJobs: [], activeSession: false });
});

test("status remains usable when an older CLI has no declarations or metadata lookup fails", async () => {
  for (const getContentRenderers of [undefined, async () => { throw Error("unavailable"); }]) {
    const response = await createStatusRoutes({ sourceCommit: "dev", getCronStatus: () => [], isTurnActive: () => false, getContentRenderers }).request("/status");
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("contentRenderers");
  }
});

import { declaredContentRenderers } from "../src/brain/content-renderers.js";
test("bootstrap projects only active module metadata, with unknown versions explicit and no executable specifiers", () => {
  const renderer = { fences: ["voyage"], extensions: [".voyage"], client: "https://untrusted.invalid/never-import.js", static: "./never-import.js" };
  expect(declaredContentRenderers([
    { name: "voyage", key: "voyage", version: "0.43.1", description: null, renderers: { map: renderer } },
    { name: "local", key: "local", description: null, renderers: { chart: renderer } },
    { name: "dormant", key: "dormant", state: "dormant", description: null, renderers: { map: renderer } },
    { name: "unavailable", key: "unavailable", state: "unavailable", description: null, renderers: { map: renderer } },
  ]), "DECLARATIONS_ARE_METADATA_NOT_CODE").toEqual([
    { module: "voyage", version: "0.43.1", name: "map", fences: ["voyage"], extensions: [".voyage"] },
    { module: "local", version: null, name: "chart", fences: ["voyage"], extensions: [".voyage"] },
  ]);
});
