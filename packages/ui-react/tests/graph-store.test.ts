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

  test("the graph opens in Clusters, not Local", async () => {
    // Local is centred on one node and has none until the user picks one, so
    // defaulting to it landed on an empty canvas that reads as a broken graph.
    // Read from the store's INITIAL state, not the current one — resetStore()
    // below deliberately starts most cases in local mode.
    expect(useGraphStore.getInitialState().mode).toBe("clusters");
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
    expect(calls).toHaveLength(1);
    expect(useGraphStore.getState().subgraph?.nodes).toHaveLength(2);
    const first = calls.length;
    // Same params again — served from cache, no second request.
    await useGraphStore.getState().fetchScene();
    await settle();
    expect(calls.length).toBe(first);
  });

  test("a slow older response never overwrites a newer scene", async () => {
    // First request (depth=1) resolves AFTER the second (depth=2).
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const slowBody = { ...SUBGRAPH, nodes: SUBGRAPH.nodes.slice(0, 1), edges: [] };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("depth=1")) {
        await firstGate;
        return new Response(JSON.stringify(slowBody), { status: 200 });
      }
      return new Response(JSON.stringify(SUBGRAPH), { status: 200 });
    }) as typeof fetch;

    useGraphStore.getState().setLocalParams({ center: "race.md", depth: 1 });
    useGraphStore.getState().setLocalParams({ depth: 2 });
    await settle();
    expect(useGraphStore.getState().subgraph?.nodes).toHaveLength(2);

    releaseFirst();
    await settle();
    // The stale depth=1 payload (1 node) must not have replaced the scene.
    expect(useGraphStore.getState().subgraph?.nodes).toHaveLength(2);
  });

  test("a slow older ERROR never clobbers a newer scene", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("depth=1")) {
        await firstGate;
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify(SUBGRAPH), { status: 200 });
    }) as typeof fetch;

    useGraphStore.getState().setLocalParams({ center: "race2.md", depth: 1 });
    useGraphStore.getState().setLocalParams({ depth: 2 });
    await settle();
    releaseFirst();
    await settle();
    const s = useGraphStore.getState();
    expect(s.dataState).toBe("done");
    expect(s.error).toBeNull();
  });

  test("a slow older meta response never restores a stale computedAt", async () => {
    // First /meta call (pre-sync generation) resolves AFTER the second
    // (post-sync) — the classic leave-and-re-enter-during-sync interleaving.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const staleMeta = { ...META, computedAt: "2026-08-12T00:00:00Z" };
    let call = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      call += 1;
      if (call === 1) {
        await firstGate;
        return new Response(JSON.stringify(staleMeta), { status: 200 });
      }
      return new Response(JSON.stringify(META), { status: 200 });
    }) as typeof fetch;

    const first = useGraphStore.getState().fetchMeta(true);
    const second = useGraphStore.getState().fetchMeta(true);
    await second;
    expect(useGraphStore.getState().meta?.computedAt).toBe(META.computedAt);

    releaseFirst();
    await first;
    // The older response must have been discarded.
    expect(useGraphStore.getState().meta?.computedAt).toBe(META.computedAt);
    expect(useGraphStore.getState().metaState).toBe("done");
  });

  test("forced meta refetch bypasses the done-state short-circuit", async () => {
    const calls = mockFetch({ "/graph/meta": { body: META } });
    await useGraphStore.getState().fetchMeta();
    await useGraphStore.getState().fetchMeta(); // no-op: already done
    expect(calls).toHaveLength(1);
    await useGraphStore.getState().fetchMeta(true); // mount-time force
    expect(calls).toHaveLength(2);
  });

  test("display-only knobs never refetch", async () => {
    const calls = mockFetch({ "/graph/clusters": { body: SUBGRAPH } });
    useGraphStore.getState().setMode("clusters");
    await settle();
    expect(calls).toHaveLength(1);
    expect(useGraphStore.getState().subgraph?.nodes).toHaveLength(2);
    const before = calls.length;
    useGraphStore.getState().setClustersSizeBy("pagerank");
    useGraphStore.getState().setDiscoveryColorBy("folder");
    useGraphStore.getState().setMaintenanceFilters({ orphans: false });
    await settle();
    expect(calls.length).toBe(before);
  });
});
