import { afterEach, describe, expect, test } from "bun:test";
import type {
  GraphMaintenanceResponse,
  GraphMetaResponse,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";
import { createGraphRoutes } from "../src/routes/graph";
import {
  computedGraph,
  createBrainFixture,
  linkedCorpus,
  removeBrainFixture,
  type FixtureOptions,
} from "./helpers/graph-fixture";

const BRAIN_PATH = `/tmp/brain-ui-graph-${process.pid}`;

const graphRoutes = createGraphRoutes({ brainRoot: BRAIN_PATH });

function useFixture(opts: FixtureOptions): void {
  createBrainFixture(BRAIN_PATH, opts);
}

/** The full v8 corpus: linked notes plus everything an index run precomputes. */
function useComputedFixture(overrides: Partial<FixtureOptions> = {}): void {
  const base = { ...linkedCorpus(), ...computedGraph() };
  useFixture({ ...base, ...overrides, metadata: { ...base.metadata, ...overrides.metadata } });
}

afterEach(() => {
  removeBrainFixture(BRAIN_PATH);
});

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await graphRoutes.request(path);
  return { status: response.status, body: (await response.json()) as T };
}

const ids = (subgraph: GraphSubgraphResponse) => subgraph.nodes.map((n) => n.id).sort((a, b) => a - b);
const paths = (nodes: { path: string }[]) => nodes.map((n) => n.path);

/**
 * A precompute that resolved no root at all: `graph_root` and
 * `graph_root_links` are ABSENT together (core deletes and rewrites these keys
 * every run), and no distances were recorded. This is the state of the real
 * brain repo, whose entry-file wiki links all sit inside code spans.
 */
const NO_ROOT_RESOLVED: Partial<FixtureOptions> = {
  rootDistances: [],
  metadata: { graph_computed_at: "2026-08-02T00:00:00.000Z" },
};

/**
 * A root that WAS resolved but reached nothing — core honours an explicitly
 * named root even when none of its links resolve, writing `graph_root` with
 * zero distance rows. Distinguishable from NO_ROOT_RESOLVED only by the
 * presence of that key, and the two states mean opposite things.
 */
const ROOT_RESOLVED_NOTHING: Partial<FixtureOptions> = {
  rootDistances: [],
  metadata: {
    graph_computed_at: "2026-08-02T00:00:00.000Z",
    graph_root: "virtual:AGENTS.md",
    graph_root_links: "[]",
  },
};

describe("GET /graph/meta", () => {
  test("a schema-7 repo reports itself unavailable but still counts the corpus", async () => {
    useFixture({ schemaVersion: 7, ...linkedCorpus() });

    const { status, body } = await get<GraphMetaResponse>("/graph/meta");

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toBe("schema");
    expect(body.schemaVersion).toBe(7);
    // The non-markdown asset is not a graph node, and the broken link is no edge.
    expect(body.nodeCount).toBe(4);
    expect(body.edgeCount).toBe(3);
    expect(body.defaultRoot).toBeNull();
  });

  test("a db claiming v8 without the graph tables is treated as schema-unavailable", async () => {
    useFixture({ schemaVersion: 8, graphTables: false, ...linkedCorpus() });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.available).toBe(false);
    expect(body.reason).toBe("schema");
  });

  test("a missing brain.db reads as an unavailable graph, not a crash", async () => {
    process.env.BRAIN_PATH = `${BRAIN_PATH}-nonexistent`;

    const { status, body } = await get<GraphMetaResponse>("/graph/meta");

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.reason).toBe("schema");
    expect(body.schemaVersion).toBe(0);
  });

  test("v8 tables that no index run has filled report not_computed", async () => {
    useFixture({ ...linkedCorpus() });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.available).toBe(false);
    expect(body.reason).toBe("not_computed");
    expect(body.schemaVersion).toBe(8);
  });

  test("a computed graph reports its communities, root and freshness", async () => {
    useComputedFixture();

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.available).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.computedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(body.stale).toBe(false);
    expect(body.nodeCount).toBe(4);
    expect(body.edgeCount).toBe(3);
    expect(body.communities).toEqual([
      { community: 0, size: 2, label: "index", topTerms: ["index", "alpha"] },
      { community: 1, size: 2, label: "beta", topTerms: ["beta"] },
    ]);
    expect(body.defaultRoot).toEqual({ path: "AGENTS.md", virtual: true });
    expect(body.layoutSkipped).toBeUndefined();
  });

  test("an index run newer than the graph marks it stale", async () => {
    useComputedFixture({ metadata: { graph_computed_at: "2026-07-01T00:00:00.000Z" } });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.available).toBe(true);
    expect(body.stale).toBe(true);
  });

  test("a skipped layout is surfaced so clusters can fall back", async () => {
    useComputedFixture({ metadata: { graph_layout_skipped: "1" } });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.layoutSkipped).toBe(true);
  });

  test("counts one edge per document pair, ignoring duplicates and self-links", async () => {
    // Two wiki links resolving to the same note are one edge, and a note that
    // links to itself is none — the rule `brain graph stats` counts by.
    const corpus = linkedCorpus();
    corpus.links = [
      ...corpus.links!,
      { sourceId: 1, target: "the alpha note", targetId: 2 },
      { sourceId: 1, target: "index", targetId: 1 },
    ];
    useFixture({ ...corpus, ...computedGraph() });

    const meta = await get<GraphMetaResponse>("/graph/meta");
    const clusters = await get<GraphSubgraphResponse>("/graph/clusters");

    expect(meta.body.edgeCount).toBe(3);
    expect(clusters.body.edges).toHaveLength(3);
    expect(clusters.body.edges).not.toContainEqual({ source: 1, target: 1 });
  });

  test("a non-virtual root is reported as an ordinary document", async () => {
    useComputedFixture({ metadata: { graph_root: "index.md", graph_root_links: "[]" } });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.defaultRoot).toEqual({ path: "index.md", virtual: false });
  });
});

describe("GET /graph/clusters", () => {
  test("returns the linked corpus with its precomputed metrics and layout", async () => {
    useComputedFixture();

    const { status, body } = await get<GraphSubgraphResponse>("/graph/clusters");

    expect(status).toBe(200);
    expect(ids(body)).toEqual([1, 2, 3]); // the orphan is an isolate
    expect(body.truncated).toBe(false);
    expect(body.edges).toHaveLength(3);
    const index = body.nodes.find((n) => n.id === 1)!;
    expect(index).toMatchObject({ path: "index.md", title: "Index", inDegree: 1, outDegree: 1, community: 0 });
    expect(index.pagerank).toBeCloseTo(0.3);
    expect([index.x, index.y]).toEqual([1, 2]);
  });

  test("isolates=1 adds the unlinked notes", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/clusters?isolates=1");

    expect(ids(body)).toEqual([1, 2, 3, 4]);
    // Still no edges to the isolate, and the image asset never becomes a node.
    expect(body.edges).toHaveLength(3);
  });

  test("community filters down to one cluster", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/clusters?community=1&isolates=1");

    expect(ids(body)).toEqual([3, 4]);
  });

  test("drops the lowest-pagerank nodes past the cap and says so", async () => {
    const docs = Array.from({ length: 5001 }, (_, i) => ({
      id: i + 1,
      path: `note-${i + 1}.md`,
      title: `Note ${i + 1}`,
    }));
    const metrics = docs.map((doc) => ({
      documentId: doc.id,
      inDegree: 0,
      outDegree: 0,
      // note-1 is the least important, so it is the one that must be dropped.
      pagerank: doc.id / 10_000,
    }));
    useFixture({ docs, metrics, metadata: computedGraph().metadata });

    const { body } = await get<GraphSubgraphResponse>("/graph/clusters?isolates=1");

    expect(body.truncated).toBe(true);
    expect(body.nodes).toHaveLength(5000);
    expect(body.nodes.some((n) => n.id === 1)).toBe(false);
  });

  test("refuses with 503 when the graph has never been computed", async () => {
    useFixture({ schemaVersion: 7, ...linkedCorpus() });

    const { status, body } = await get<{ error: string; reason: string }>("/graph/clusters");

    expect(status).toBe(503);
    expect(body).toEqual({ error: "graph_unavailable", reason: "schema" });
  });

  test("rejects a non-numeric community", async () => {
    useComputedFixture();

    const { status, body } = await get<{ error: string; param: string }>("/graph/clusters?community=abc");

    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid_param", param: "community" });
  });
});

describe("GET /graph/neighborhood", () => {
  test("works against a schema-7 repo, since it only needs the links table", async () => {
    useFixture({ schemaVersion: 7, ...linkedCorpus() });

    const { status, body } = await get<GraphSubgraphResponse>("/graph/neighborhood?center=alpha.md");

    expect(status).toBe(200);
    expect(ids(body)).toEqual([1, 2, 3]);
    // No precomputed tables to read, so the analytical fields stay empty.
    const alpha = body.nodes.find((n) => n.id === 2)!;
    expect(alpha).toMatchObject({ inDegree: 0, outDegree: 0, distance: 0 });
    expect(alpha.community).toBeUndefined();
    expect(alpha.x).toBeUndefined();
  });

  test("enriches nodes with metrics and layout when they exist", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/neighborhood?center=alpha.md&depth=1");

    const alpha = body.nodes.find((n) => n.id === 2)!;
    expect(alpha).toMatchObject({ inDegree: 1, outDegree: 1, community: 0, distance: 0 });
    expect(body.nodes.find((n) => n.id === 3)!.distance).toBe(1);
  });

  test("direction=out follows outgoing links only", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/neighborhood?center=alpha.md&direction=out");

    expect(ids(body)).toEqual([2, 3]);
    expect(body.edges).toEqual([{ source: 2, target: 3 }]);
  });

  test("direction=in follows backlinks only", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/neighborhood?center=alpha.md&direction=in");

    expect(ids(body)).toEqual([1, 2]);
  });

  test("depth widens the ring", async () => {
    useComputedFixture();

    const shallow = await get<GraphSubgraphResponse>("/graph/neighborhood?center=index.md&depth=1&direction=out");
    const deeper = await get<GraphSubgraphResponse>("/graph/neighborhood?center=index.md&depth=2&direction=out");

    expect(ids(shallow.body)).toEqual([1, 2]);
    expect(ids(deeper.body)).toEqual([1, 2, 3]);
    expect(deeper.body.nodes.find((n) => n.id === 3)!.distance).toBe(2);
  });

  test("caps a hub neighborhood and reports the truncation", async () => {
    const docs = [
      { id: 1, path: "hub.md", title: "Hub" },
      ...Array.from({ length: 2000 }, (_, i) => ({
        id: i + 2,
        path: `leaf-${i}.md`,
        title: `Leaf ${i}`,
      })),
    ];
    const links = docs.slice(1).map((doc) => ({ sourceId: 1, target: doc.path, targetId: doc.id }));
    useFixture({ schemaVersion: 7, docs, links });

    const { body } = await get<GraphSubgraphResponse>("/graph/neighborhood?center=hub.md&direction=out");

    expect(body.truncated).toBe(true);
    expect(body.nodes).toHaveLength(1500);
  });

  test("404s on a center that is not an indexed note", async () => {
    useComputedFixture();

    const { status, body } = await get<{ error: string }>("/graph/neighborhood?center=nope.md");

    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  test("rejects a missing center and out-of-range parameters", async () => {
    useComputedFixture();

    expect((await get("/graph/neighborhood")).status).toBe(400);
    expect((await get("/graph/neighborhood?center=alpha.md&depth=4")).status).toBe(400);
    expect((await get("/graph/neighborhood?center=alpha.md&depth=0")).status).toBe(400);
    expect((await get("/graph/neighborhood?center=alpha.md&depth=two")).status).toBe(400);
    expect((await get("/graph/neighborhood?center=alpha.md&direction=sideways")).status).toBe(400);
  });
});

describe("GET /graph/discovery", () => {
  test("without a root, synthesizes the virtual entry node and its links", async () => {
    useComputedFixture();

    const { status, body } = await get<GraphSubgraphResponse>("/graph/discovery");

    expect(status).toBe(200);
    // The unreachable orphan has no precomputed distance, so it stays out.
    expect(ids(body)).toEqual([0, 1, 2, 3]);
    const root = body.nodes.find((n) => n.id === 0)!;
    expect(root).toMatchObject({ path: "AGENTS.md", title: "AGENTS.md", virtual: true, distance: 0, outDegree: 1 });
    expect(body.edges).toContainEqual({ source: 0, target: 1 });
    expect(body.nodes.find((n) => n.id === 3)!.distance).toBe(3);
  });

  test("maxDepth trims the precomputed rings", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?maxDepth=2");

    expect(ids(body)).toEqual([0, 1, 2]);
  });

  test("an explicit root walks the links table from that note", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?root=index.md");

    expect(ids(body)).toEqual([1, 2, 3]);
    expect(body.nodes.find((n) => n.id === 1)!.distance).toBe(0);
    expect(body.nodes.find((n) => n.id === 3)!.distance).toBe(2);
    // No virtual node: the walk started from a real document.
    expect(body.nodes.some((n) => n.virtual)).toBe(false);
  });

  test("an explicit root honours maxDepth", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?root=index.md&maxDepth=1");

    expect(ids(body)).toEqual([1, 2]);
  });

  test("counts reach over the whole graph, not the scene it returned", async () => {
    useComputedFixture();

    const full = await get<GraphSubgraphResponse>("/graph/discovery");
    const shallow = await get<GraphSubgraphResponse>("/graph/discovery?maxDepth=1");

    // Three notes carry a distance; only the orphan is out of reach. The scene
    // shrinks with maxDepth — the counts must not, and they must not count the
    // virtual node, which is no document.
    expect(full.body.reachableCount).toBe(3);
    expect(full.body.unreachableCount).toBe(1);
    expect(ids(shallow.body)).toEqual([0, 1]);
    expect(shallow.body.reachableCount).toBe(3);
    expect(shallow.body.unreachableCount).toBe(1);
  });

  test("an ad-hoc root is measured by a walk with no depth window", async () => {
    useComputedFixture();

    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?root=index.md&maxDepth=1");

    // The scene stops at depth 1, but index.md reaches beta.md at depth 2, so
    // only the orphan is genuinely unreachable from it.
    expect(ids(body)).toEqual([1, 2]);
    expect(body.reachableCount).toBe(3);
    expect(body.unreachableCount).toBe(1);
  });

  test("direction narrows what an ad-hoc root can reach", async () => {
    useComputedFixture();

    // alpha.md reaches beta.md and index.md following links out; the corpus is
    // a cycle, so the whole cycle is reachable either way — but the orphan
    // never is.
    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?root=orphan.md");

    expect(body.reachableCount).toBe(1); // itself, and nothing else
    expect(body.unreachableCount).toBe(3);
  });

  test("404s on an unknown root", async () => {
    useComputedFixture();

    expect((await get("/graph/discovery?root=nope.md")).status).toBe(404);
  });

  test("refuses with 503 before the graph has been computed", async () => {
    useFixture({ ...linkedCorpus() });

    const { status, body } = await get<{ error: string; reason: string }>("/graph/discovery");

    expect(status).toBe(503);
    expect(body).toEqual({ error: "graph_unavailable", reason: "not_computed" });
  });

  test("rejects an unsupported direction and an out-of-range depth", async () => {
    useComputedFixture();

    expect((await get("/graph/discovery?direction=in")).status).toBe(400);
    expect((await get("/graph/discovery?maxDepth=9")).status).toBe(400);
  });
});

describe("optional precompute state", () => {
  test("a graph with no resolved root still reports itself available", async () => {
    useFixture({ ...linkedCorpus(), ...computedGraph(), ...NO_ROOT_RESOLVED });

    const { body } = await get<GraphMetaResponse>("/graph/meta");

    expect(body.available).toBe(true);
    expect(body.defaultRoot).toBeNull();
    expect(body.layoutSkipped).toBeUndefined();
    expect(body.nodeCount).toBe(4);
  });

  test("discovery over a rootless graph is empty rather than an error", async () => {
    useFixture({ ...linkedCorpus(), ...computedGraph(), ...NO_ROOT_RESOLVED });

    // The client reads defaultRoot === null and shows its root picker; the
    // endpoint must not invent a virtual node it has no metadata for.
    const { status, body } = await get<GraphSubgraphResponse>("/graph/discovery");

    expect(status).toBe(200);
    expect(body).toEqual({ nodes: [], edges: [], truncated: false });
    // With no root, "unreachable" has no meaning, so the counts stay off.
    expect(body.reachableCount).toBeUndefined();
    expect(body.unreachableCount).toBeUndefined();
  });

  test("a root that resolved no links leaves every note unreachable", async () => {
    // The state core writes for an explicitly named root whose links all fail
    // to resolve: graph_root present, graph_root_distances empty. Reading row
    // counts instead of the key would misread this as "no root configured" and
    // report nothing wrong with a graph nothing can be reached in.
    useFixture({ ...linkedCorpus(), ...computedGraph(), ...ROOT_RESOLVED_NOTHING });

    const maintenance = await get<GraphMaintenanceResponse>("/graph/maintenance");
    const discovery = await get<GraphSubgraphResponse>("/graph/discovery");

    expect(paths(maintenance.body.unreachable).sort()).toEqual([
      "alpha.md",
      "beta.md",
      "index.md",
      "orphan.md",
    ]);
    // The scene is the virtual root alone, and it reaches nothing.
    expect(ids(discovery.body)).toEqual([0]);
    expect(discovery.body.reachableCount).toBe(0);
    expect(discovery.body.unreachableCount).toBe(4);
  });

  test("an explicit root still works on a rootless graph", async () => {
    useFixture({ ...linkedCorpus(), ...computedGraph(), ...NO_ROOT_RESOLVED });

    const { body } = await get<GraphSubgraphResponse>("/graph/discovery?root=index.md");

    expect(ids(body)).toEqual([1, 2, 3]);
  });

  test("every mode degrades rather than throwing when the graph tables are absent", async () => {
    useFixture({ schemaVersion: 8, graphTables: false, ...linkedCorpus() });

    for (const path of ["/graph/clusters", "/graph/discovery", "/graph/maintenance"]) {
      const { status, body } = await get<{ error: string; reason: string }>(path);
      expect(status).toBe(503);
      expect(body).toEqual({ error: "graph_unavailable", reason: "schema" });
    }
    // Links-only, so it keeps working with no derived tables at all.
    expect((await get("/graph/neighborhood?center=alpha.md")).status).toBe(200);
  });
});

describe("GET /graph/maintenance", () => {
  test("reports orphans, unreachable notes, broken links and stale notes", async () => {
    useComputedFixture();

    const { status, body } = await get<GraphMaintenanceResponse>("/graph/maintenance");

    expect(status).toBe(200);
    expect(body.staleDays).toBe(180);
    expect(paths(body.orphans)).toEqual(["orphan.md"]);
    expect(paths(body.unreachable)).toEqual(["orphan.md"]);
    expect(body.brokenLinks).toEqual([{ sourcePath: "alpha.md", target: "ghost" }]);
    expect(body.stale).toHaveLength(1);
    expect(body.stale[0]).toMatchObject({ path: "orphan.md", updated: "2020-01-01" });
  });

  test("a shorter staleDays catches notes the default cutoff lets through", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const corpus = linkedCorpus();
    corpus.docs = corpus.docs.map((doc) => (doc.id === 3 ? { ...doc, updated: thirtyDaysAgo } : doc));
    useFixture({ ...corpus, ...computedGraph() });

    const wide = await get<GraphMaintenanceResponse>("/graph/maintenance");
    const narrow = await get<GraphMaintenanceResponse>("/graph/maintenance?staleDays=7");

    expect(paths(wide.body.stale)).toEqual(["orphan.md"]);
    expect(paths(narrow.body.stale)).toEqual(["orphan.md", "beta.md"]);
    expect(narrow.body.staleDays).toBe(7);
  });

  test("claims nothing is unreachable when no root was ever resolved", async () => {
    useFixture({ ...linkedCorpus(), ...computedGraph(), ...NO_ROOT_RESOLVED });

    const { body } = await get<GraphMaintenanceResponse>("/graph/maintenance");

    // Without a root every note is trivially unreachable, which is noise
    // rather than a finding.
    expect(body.unreachable).toEqual([]);
    expect(paths(body.orphans)).toEqual(["orphan.md"]);
  });

  test("refuses with 503 on a schema-7 repo", async () => {
    useFixture({ schemaVersion: 7, ...linkedCorpus() });

    expect((await get("/graph/maintenance")).status).toBe(503);
  });

  test("rejects an out-of-range staleDays", async () => {
    useComputedFixture();

    expect((await get("/graph/maintenance?staleDays=0")).status).toBe(400);
    expect((await get("/graph/maintenance?staleDays=99999")).status).toBe(400);
    expect((await get("/graph/maintenance?staleDays=soon")).status).toBe(400);
  });
});
