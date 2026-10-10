import { describe, expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import type { GraphMode } from "../src/stores/graph-state.js";

const meta = {
  available: true, schemaVersion: 8, computedAt: "2026-07-12T00:00:00Z",
  stale: false, nodeCount: 2, edgeCount: 1, communities: [],
  defaultRoot: { path: "projects/return-to-ithaca.md", virtual: false },
};
const unavailable = () => Response.json({ error: "graph_unavailable", reason: "core_unavailable" }, { status: 503 });
const modes: GraphMode[] = ["clusters", "discovery", "local", "maintenance"];

describe("graph core capability", () => {
  test("meta preserves core_unavailable across all modes without a scene request", async () => {
    const calls: string[] = [];
    const ui = createBrainUiRoot({ storage: null, request: async url => { calls.push(url); return unavailable(); } });
    try {
      const graph = ui.stores.graph;
      await graph.getState().fetchMeta(true);
      expect(graph.getState().error).toMatchObject({ kind: "unavailable", reason: "core_unavailable" });
      for (const mode of modes) {
        graph.getState().setMode(mode);
        graph.getState().setLocalParams({ center: "projects/return-to-ithaca.md" });
        await graph.getState().fetchScene();
        expect(graph.getState().error?.reason).toBe("core_unavailable");
      }
      expect(calls).toEqual(["/api/graph/meta"]);
    } finally { ui.dispose(); }
  });

  for (const mode of modes) test(`${mode}: scene 503 preserves core_unavailable after meta succeeds`, async () => {
    const ui = createBrainUiRoot({ storage: null, request: async url => url.endsWith("/meta") ? Response.json(meta) : unavailable() });
    try {
      const graph = ui.stores.graph;
      graph.setState({ mode, local: { center: "projects/return-to-ithaca.md", depth: 1, direction: "both" } });
      await graph.getState().fetchMeta(true);
      await graph.getState().fetchScene();
      expect(graph.getState().dataState).toBe("error");
      expect(graph.getState().error).toMatchObject({ kind: "unavailable", reason: "core_unavailable" });
      graph.getState().setMode(mode === "local" ? "clusters" : "local");
      await graph.getState().fetchScene();
      expect(graph.getState().error?.reason).toBe("core_unavailable");
    } finally { ui.dispose(); }
  });

  test("a successful forced meta refresh recovers after the server is repaired", async () => {
    let repaired = false;
    const calls: string[] = [];
    const ui = createBrainUiRoot({ storage: null, request: async url => {
      calls.push(url);
      if (!repaired) return unavailable();
      return Response.json(url.endsWith("/meta") ? meta : { nodes: [], edges: [], truncated: false });
    } });
    try {
      const graph = ui.stores.graph;
      await graph.getState().fetchMeta(true);
      expect(graph.getState().error?.reason).toBe("core_unavailable");
      repaired = true;
      await graph.getState().fetchMeta(true);
      await graph.getState().fetchScene();
      expect(graph.getState().error).toBeNull();
      expect(graph.getState().dataState).toBe("done");
      expect(calls).toEqual(["/api/graph/meta", "/api/graph/meta", "/api/graph/clusters"]);
    } finally { ui.dispose(); }
  });
  test("a core failure during Local expansion replaces the existing scene", async () => {
    const ui = createBrainUiRoot({ storage: null, request: async () => unavailable() });
    try {
      const graph = ui.stores.graph;
      graph.setState({ mode: "local", meta, metaState: "done", dataState: "done", subgraph: {
        nodes: [{ id: 1, path: "projects/return-to-ithaca.md", title: "Return to Ithaca", type: "project", inDegree: 1, outDegree: 0 }],
        edges: [], truncated: false,
      } });
      expect(graph.getState().subgraph?.nodes.length).toBe(1);
      await graph.getState().expandNode("projects/return-to-ithaca.md");
      expect(graph.getState().error?.reason).toBe("core_unavailable");
      expect(graph.getState().subgraph).toBeNull();
    } finally { ui.dispose(); }
  });

  test("a meta core failure prevents an older scene response from restoring the graph", async () => {
    let release!: (response: Response) => void;
    const scene = new Promise<Response>(resolve => { release = resolve; });
    const calls: string[] = [];
    const ui = createBrainUiRoot({ storage: null, request: async url => {
      calls.push(url);
      return url.endsWith("/meta") ? unavailable() : scene;
    } });
    try {
      const graph = ui.stores.graph;
      const pending = graph.getState().fetchScene();
      expect(calls).toEqual(["/api/graph/clusters"]);
      await graph.getState().fetchMeta(true);
      release(Response.json({ nodes: [], edges: [], truncated: false }));
      await pending;
      expect(graph.getState().error?.reason).toBe("core_unavailable");
      expect(graph.getState().subgraph).toBeNull();
      expect(graph.getState().dataState).not.toBe("done");
    } finally { ui.dispose(); }
  });

});
