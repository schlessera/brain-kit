import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearGraphSceneCache,
  useGraphStore,
} from "../src/stores/graph-store.js";

/** Route-matching fetch mock; records calls for cache assertions. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix));
    if (!hit) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

const META = {
  available: true,
  schemaVersion: 8,
  computedAt: "2026-08-13T00:00:00Z",
  stale: false,
  nodeCount: 4,
  edgeCount: 3,
  communities: [{ community: 0, size: 3, label: "career", topTerms: ["career"] }],
  defaultRoot: { path: "AGENTS.md", virtual: true },
};

const SUBGRAPH = {
  nodes: [
    { id: 1, path: "a.md", title: "A", type: "note", inDegree: 1, outDegree: 0, distance: 0 },
    { id: 2, path: "b.md", title: "B", type: "note", inDegree: 0, outDegree: 1, distance: 1 },
  ],
  edges: [{ source: 2, target: 1 }],
  truncated: false,
};

const MAINTENANCE = {
  orphans: [{ id: 9, path: "o.md", title: "O", type: "note", inDegree: 0, outDegree: 0 }],
  unreachable: [],
  brokenLinks: [{ sourcePath: "a.md", target: "ghost" }],
  stale: [],
  staleDays: 180,
};

const realFetch = globalThis.fetch;

function resetStore() {
  useGraphStore.setState({
    mode: "local",
    meta: null,
    metaState: "idle",
    local: { center: null, depth: 1, direction: "both" },
    discovery: { root: null, maxDepth: 8 },
    clusters: { community: null, isolates: false },
    maintenance: { staleDays: 180 },
    subgraph: null,
    findings: null,
    dataState: "idle",
    error: null,
    sceneQuery: "",
    selectedId: null,
    hoveredId: null,
  });
}

beforeEach(() => {
  resetStore();
  clearGraphSceneCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  // Two microtask hops cover the fetch → json → set chain.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("graph-store", () => {
  test("fetchMeta populates meta", async () => {
    mockFetch({ "/graph/meta": { body: META } });
    await useGraphStore.getState().fetchMeta();
    expect(useGraphStore.getState().metaState).toBe("done");
    expect(useGraphStore.getState().meta?.nodeCount).toBe(4);
  });

  test("404 on meta marks the server unsupported", async () => {
    mockFetch({});
    await useGraphStore.getState().fetchMeta();
    const s = useGraphStore.getState();
    expect(s.metaState).toBe("error");
    expect(s.error?.kind).toBe("unsupported");
  });

  test("local mode without a center fetches nothing", async () => {
    const calls = mockFetch({ "/graph/neighborhood": { body: SUBGRAPH } });
    await useGraphStore.getState().fetchScene();
    expect(calls).toHaveLength(0);
    expect(useGraphStore.getState().dataState).toBe("idle");
  });

  test("setting a local center fetches the neighborhood", async () => {
    mockFetch({ "/graph/neighborhood": { body: SUBGRAPH } });
    useGraphStore.getState().setLocalParams({ center: "a.md" });
    await settle();
    const s = useGraphStore.getState();
    expect(s.dataState).toBe("done");
    expect(s.subgraph?.nodes).toHaveLength(2);
  });

  test("mode switch to maintenance lands findings, not a subgraph", async () => {
    mockFetch({ "/graph/maintenance": { body: MAINTENANCE } });
    useGraphStore.getState().setMode("maintenance");
    await settle();
    const s = useGraphStore.getState();
    expect(s.findings?.orphans).toHaveLength(1);
    expect(s.subgraph).toBeNull();
  });

  test("clusters and discovery fetch their endpoints", async () => {
    const calls = mockFetch({
      "/graph/clusters": { body: SUBGRAPH },
      "/graph/discovery": { body: SUBGRAPH },
    });
    useGraphStore.getState().setMode("clusters");
    await settle();
    expect(useGraphStore.getState().subgraph).not.toBeNull();
    useGraphStore.getState().setMode("discovery");
    await settle();
    expect(calls.some((u) => u.includes("/graph/discovery"))).toBe(true);
  });

  test("503 surfaces the gating reason", async () => {
    mockFetch({
      "/graph/clusters": {
        status: 503,
        body: { error: "graph_unavailable", reason: "not_computed" },
      },
    });
    useGraphStore.getState().setMode("clusters");
    await settle();
    const s = useGraphStore.getState();
    expect(s.dataState).toBe("error");
    expect(s.error?.kind).toBe("unavailable");
    expect(s.error?.reason).toBe("not_computed");
  });

  test("identical scene requests hit the cache", async () => {
    const calls = mockFetch({ "/graph/neighborhood": { body: SUBGRAPH } });
    useGraphStore.getState().setLocalParams({ center: "cache-test.md" });
    await settle();
    const first = calls.length;
    // Same params again — served from cache, no second request.
    await useGraphStore.getState().fetchScene();
    await settle();
    expect(calls.length).toBe(first);
  });

  test("display-only knobs never refetch", async () => {
    const calls = mockFetch({ "/graph/clusters": { body: SUBGRAPH } });
    useGraphStore.getState().setMode("clusters");
    await settle();
    const before = calls.length;
    useGraphStore.getState().setClustersSizeBy("pagerank");
    useGraphStore.getState().setDiscoveryColorBy("folder");
    useGraphStore.getState().setMaintenanceFilters({ orphans: false });
    await settle();
    expect(calls.length).toBe(before);
  });
});
