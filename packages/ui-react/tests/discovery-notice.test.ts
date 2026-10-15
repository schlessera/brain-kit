import { expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import type { GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";
const base: GraphSubgraphResponse = {
  nodes: [
    {
      id: 0,
      path: "AGENTS.md",
      title: "Ithaca",
      type: "index",
      distance: 0,
      inDegree: 0,
      outDegree: 1,
    },
    {
      id: 1,
      path: "people/athena.md",
      title: "Athena",
      type: "person",
      distance: 1,
      inDegree: 1,
      outDegree: 0,
    },
  ],
  edges: [{ source: 0, target: 1 }],
  truncated: false,
};
test("DISCOVERY_LAYOUT_NOTICE: changed data announces once while retaining identity selection", async () => {
  let response = base;
  const ui = createBrainUiRoot({
    storage: null,
    request: async () => Response.json(response),
  });
  const store = ui.stores.graph;
  try {
    store.setState({
      mode: "discovery",
      subgraph: base,
      dataState: "done",
      selectedId: 1,
    });
    response = {
      ...base,
      nodes: [
        ...base.nodes,
        { ...base.nodes[1]!, id: 2, path: "people/circe.md", title: "Circe" },
      ],
      edges: [...base.edges, { source: 0, target: 2 }],
    };
    await store.getState().fetchScene();
    expect(store.getState().layoutNotice).not.toBeNull();
    expect(store.getState().selectedId).toBe(1);
    const notice = store.getState().layoutNotice;
    store.getState().setDiscoveryColorBy("topic");
    store.getState().setClustersSizeBy("pagerank");
    store.getState().select(1);
    expect(store.getState().layoutNotice).toBe(notice);
    store.clearSceneCache();
    response = {
      ...response,
      nodes: [...response.nodes].reverse(),
      edges: [...response.edges].reverse(),
    };
    await store.getState().fetchScene();
    expect(store.getState().layoutNotice).toBeNull();
    store.clearSceneCache();
    response = base;
    await store.getState().fetchScene();
    expect(store.getState().layoutNotice).toBeGreaterThan(notice!);
    store.getState().select(0);
    expect(store.getState().layoutNotice).toBeNull();
    store.getState().select(1);
    store.clearSceneCache();
    response = { ...base, nodes: base.nodes.slice(0, 1), edges: [] };
    await store.getState().fetchScene();
    expect(store.getState().selectedId).toBeNull();
    expect(store.getState().layoutNotice).toBeNull();
  } finally {
    ui.dispose();
  }
});

test("DISCOVERY_NOTICE_CAPABILITY_FAILURE_CLEARS: unavailable scenes do not retain a layout status", async () => {
  let failure = false;
  const addition = {
    ...base,
    nodes: [
      ...base.nodes,
      { ...base.nodes[1]!, id: 2, path: "people/circe.md", title: "Circe" },
    ],
  };
  const ui = createBrainUiRoot({
    storage: null,
    request: async () =>
      failure
        ? Response.json(
            { error: "graph_unavailable", reason: "core_unavailable" },
            { status: 503 }
          )
        : Response.json(addition),
  });
  try {
    ui.stores.graph.setState({
      mode: "discovery",
      subgraph: base,
      selectedId: 1,
      dataState: "done",
    });
    await ui.stores.graph.getState().fetchScene();
    expect(ui.stores.graph.getState().layoutNotice).not.toBeNull();
    ui.stores.graph.clearSceneCache();
    failure = true;
    await ui.stores.graph.getState().fetchScene();
    expect(ui.stores.graph.getState().subgraph).toBeNull();
    expect(ui.stores.graph.getState().layoutNotice).toBeNull();
  } finally {
    ui.dispose();
  }
});

test("DISCOVERY_EFFECTIVE_ROOT_CHANGE: a changed default root clears survivor selection without a notice", async () => {
  const next = {
    ...base,
    nodes: [
      {
        ...base.nodes[1]!,
        id: 4,
        path: "people/poseidon.md",
        title: "Poseidon",
        distance: 0,
      },
      { ...base.nodes[0]!, distance: 1 },
      { ...base.nodes[1]!, distance: 2 },
    ],
    edges: [
      { source: 4, target: 0 },
      { source: 0, target: 1 },
    ],
  };
  const ui = createBrainUiRoot({
    storage: null,
    request: async () => Response.json(next),
  });
  try {
    ui.stores.graph.setState({
      mode: "discovery",
      subgraph: base,
      dataState: "done",
      selectedId: 1,
    });
    await ui.stores.graph.getState().fetchScene();
    expect(ui.stores.graph.getState().selectedId).toBeNull();
    expect(ui.stores.graph.getState().layoutNotice).toBeNull();
  } finally {
    ui.dispose();
  }
});
