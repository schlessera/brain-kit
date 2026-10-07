import { expect, test } from "bun:test";
import type { CoreQueryAccess, GraphQueries, QueryCode } from "../src/core-queries";
import { createRecordingObservability } from "../src/observability";
import { createGraphRoutes } from "../src/routes/graph";

const PATHS = ["/graph/meta", "/graph/clusters", "/graph/neighborhood?center=notes/ithaca.md", "/graph/discovery?root=notes/ithaca.md", "/graph/maintenance"];

/** Every graph operation answers with the same typed failure. */
function failing(code: QueryCode): { routes: ReturnType<typeof createGraphRoutes>; logs: ReturnType<typeof createRecordingObservability>["logs"] } {
  const fail = () => ({ ok: false as const, error: { code, retryable: code === "busy_index" } });
  const queries: GraphQueries = {
    readGraphMeta: fail, readGraphClusters: fail, readGraphNeighborhood: fail, readGraphDiscovery: fail, readGraphMaintenance: fail,
  };
  const access: CoreQueryAccess = { graph: () => ({ ok: true, queries }), voice: () => ({ ok: false, reason: "not_installed" }) };
  const observability = createRecordingObservability();
  return { routes: createGraphRoutes({ brainRoot: "/srv/odysseus", log: observability.logger("graph"), queries: access }), logs: observability.logs };
}

const UNAVAILABLE_META = { available: false, reason: "schema", schemaVersion: 0, computedAt: null, stale: false, nodeCount: 0, edgeCount: 0, communities: [], defaultRoot: null };

// [code, meta, clusters, neighborhood, discovery, maintenance] as [status, body]
const table: [QueryCode, ...[number, unknown][]][] = [
  ["missing_index", [200, UNAVAILABLE_META], ...Array(4).fill([503, { error: "graph_unavailable", reason: "schema" }])],
  ["incompatible_index", [200, UNAVAILABLE_META], ...Array(4).fill([503, { error: "graph_unavailable", reason: "schema" }])],
  ["corrupt_index", [200, UNAVAILABLE_META], ...Array(4).fill([503, { error: "graph_unavailable", reason: "schema" }])],
  ["not_computed", [200, UNAVAILABLE_META], ...Array(4).fill([503, { error: "graph_unavailable", reason: "not_computed" }])],
  ["busy_index", ...Array(5).fill([503, { error: "index_busy" }])],
  ["unavailable_index", [200, UNAVAILABLE_META], ...Array(4).fill([500, { error: "internal_error" }])],
  ["not_found", [200, UNAVAILABLE_META], [500, { error: "internal_error" }], [404, { error: "not_found" }], [404, { error: "not_found" }], [500, { error: "internal_error" }]],
  ["invalid_input", [200, UNAVAILABLE_META], [500, { error: "internal_error" }], [404, { error: "not_found" }], [404, { error: "not_found" }], [500, { error: "internal_error" }]],
];

for (const [code, ...expected] of table) {
  test(`a ${code} failure keeps each route's established response`, async () => {
    const { routes, logs } = failing(code);
    for (const [i, path] of PATHS.entries()) {
      const response = await routes.request(path);
      const [status, body] = expected[i]!;
      expect([path, response.status], path).toEqual([path, status]);
      expect(await response.json(), path).toEqual(body);
    }
    // A 500 is logged by code only — no native text or root path.
    const errors = logs.find({ severity: "ERROR" });
    for (const record of errors) {
      expect(record.attributes).toEqual({ "error.code": code });
      expect(JSON.stringify(record)).not.toContain("/srv/odysseus");
    }
    expect(errors).toHaveLength(expected.filter(([status]) => status === 500).length);
  });
}

test("an unexpected thrown error is a sanitized 500, logged by name", async () => {
  const boom = () => { throw new Error("SQLITE_CORRUPT at /srv/odysseus/brain.db"); };
  const queries = { readGraphMeta: boom, readGraphClusters: boom, readGraphNeighborhood: boom, readGraphDiscovery: boom, readGraphMaintenance: boom } as unknown as GraphQueries;
  const observability = createRecordingObservability();
  const routes = createGraphRoutes({ brainRoot: "/srv/odysseus", log: observability.logger("graph"), queries: { graph: () => ({ ok: true, queries }), voice: () => ({ ok: false, reason: "not_installed" }) } });
  for (const path of PATHS) {
    const response = await routes.request(path);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  }
  const errors = observability.logs.find({ severity: "ERROR" });
  expect(errors.map((record) => record.attributes)).toEqual(Array(5).fill({ "error.code": "Error" }));
  expect(JSON.stringify(observability.logs.records())).not.toContain("/srv/odysseus");
});
