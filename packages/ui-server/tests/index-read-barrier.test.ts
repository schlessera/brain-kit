import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createIndexBatch } from "../src/brain/index-batch.js";
import { INDEX_READ_ROUTES, indexReadBarrier } from "../src/routes/index-barrier.js";

// #2835: the host's HTTP index readers wait for queued application updates,
// and a failed update answers 503 index_stale instead of a stale result.
function app(index: (paths: readonly string[]) => Promise<void>) {
  const batch = createIndexBatch({ index });
  const reads: string[] = [];
  const hono = new Hono();
  for (const path of INDEX_READ_ROUTES) hono.use(path, indexReadBarrier(batch));
  hono.get("/api/brain/search", c => { reads.push("search"); return c.json({ results: [] }); });
  hono.get("/api/graph/meta", c => { reads.push("graph"); return c.json({}); });
  hono.get("/api/activity/stats", c => { reads.push("activity"); return c.json({}); });
  return { batch, hono, reads };
}

test("index read routes run only after the queued update completes", async () => {
  const { batch, hono, reads } = app(async paths => { reads.push(`index ${paths.join(",")}`); });
  batch.queue(["notes/scheria.md"]);
  expect((await hono.request("/api/brain/search?q=Nausicaa")).status).toBe(200);
  batch.queue(["notes/ithaca.md"]);
  expect((await hono.request("/api/graph/meta")).status).toBe(200);
  expect((await hono.request("/api/brain/search?q=Nausicaa")).status).toBe(200);
  expect(reads).toEqual(["index notes/scheria.md", "search", "index notes/ithaca.md", "graph", "search"]);
});

test("a failed update answers 503 index_stale, runs no read, and is retried by the next request", async () => {
  let failure: string | undefined = "maintenance worker timed out";
  const { batch, hono, reads } = app(async () => { if (failure) throw new Error(failure); });
  batch.queue(["notes/scheria.md"]);
  // A route that does not read the index never waits.
  expect((await hono.request("/api/activity/stats")).status).toBe(200);
  const refused = await hono.request("/api/brain/search?q=Nausicaa");
  expect(refused.status).toBe(503);
  const body = await refused.json() as { code: string; error: string };
  expect(body.code).toBe("index_stale");
  expect(body.error).toContain("notes/scheria.md");
  expect(body.error).toContain("maintenance worker timed out");
  expect(reads).toEqual(["activity"]);
  failure = undefined;
  expect((await hono.request("/api/brain/search?q=Nausicaa")).status).toBe(200);
  expect(reads).toEqual(["activity", "search"]);
});
