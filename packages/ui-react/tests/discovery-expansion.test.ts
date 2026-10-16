import { afterEach, expect, test } from "bun:test";
import type { GraphMetaResponse, GraphSubgraphResponse } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../src/root.js";
import { discoveryExpansionAction, emptyDiscoveryExpansion, preservesDiscoveryBase, revealDiscovery, revalidateDiscoveryIntents } from "../src/lib/discovery-expansion.js";

const links = [[1, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 7], [5, 4], [6, 5], [6, 7], [6, 8], [8, 9], [10, 6]] as const;
const titles = ["Return to Ithaca", "Aeolus", "Circe", "Mast", "Provisions", "Oars", "Crew", "Beacon", "Harbour", "Cyclops"];
/** Independent directed walk; the response fixture never imports the reveal implementation. */
function distances(root = 1, edges: readonly (readonly [number, number])[] = links) {
  const found = new Map([[root, 0]]);
  const queue = [root];
  for (const source of queue) for (const [from, target] of edges) {
    if (from !== source || found.has(target)) continue;
    found.set(target, found.get(source)! + 1);
    queue.push(target);
  }
  return found;
}
function response(depth: number, edges: readonly (readonly [number, number])[] = links): GraphSubgraphResponse {
  const hops = distances(1, edges);
  const nodes = [...hops].filter(([, d]) => d <= depth).map(([id, distance]) => ({
    id, path: `voyage/${id}.md`, title: titles[id - 1] ?? `Ithaca note ${id}`, type: "note", distance,
    inDegree: 0, outDegree: 999,
  }));
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: edges.filter(([s, t]) => ids.has(s) && ids.has(t)).map(([source, target]) => ({ source, target })), truncated: false };
}
const meta: GraphMetaResponse = { available: true, schemaVersion: 8, computedAt: "2026-07-12T04:40:00Z", stale: false, nodeCount: 10, edgeCount: links.length, communities: [], defaultRoot: { path: "voyage/1.md", virtual: false } };
const owned: ReturnType<typeof createBrainUiRoot>[] = [];
afterEach(() => { for (const ui of owned.splice(0)) ui.dispose(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Reader = (depth: number, root: string | null) => GraphSubgraphResponse | Promise<GraphSubgraphResponse>;
async function harness(initialReader: Reader = depth => response(depth), initialMeta = meta) {
  let currentMeta = structuredClone(initialMeta);
  let reader = initialReader;
  const calls: URL[] = [];
  const ui = createBrainUiRoot({ storage: null, request: async url => {
    const query = new URL(url, "http://localhost"); calls.push(query);
    return Response.json(query.pathname.endsWith("/meta") ? currentMeta : await reader(Number(query.searchParams.get("maxDepth")), query.searchParams.get("root")));
  } });
  owned.push(ui);
  const store = ui.stores.graph;
  store.setState({ mode: "discovery", discovery: { root: "voyage/1.md", maxDepth: 1 }, meta: currentMeta, metaState: "done" });
  await store.getState().fetchScene();
  return { ui, store, calls, read(fn: typeof reader) { reader = fn; }, meta(value: GraphMetaResponse) { currentMeta = value; } };
}
const ids = (data: GraphSubgraphResponse | null) => data?.nodes.map(n => n.id).sort((a, b) => a - b);

test("DISCOVERY_ORIGINAL_ROOT_REVEAL: expansion uses bounded original-root evidence", async () => {
  const calls: string[] = [];
  const ui = createBrainUiRoot({ storage: null, request: async url => {
    calls.push(url);
    const query = new URL(url, "http://localhost");
    return Response.json(query.pathname.endsWith("/meta") ? meta : response(Number(query.searchParams.get("maxDepth"))));
  } });
  const store = ui.stores.graph;
  try {
    store.setState({ mode: "discovery", discovery: { root: "voyage/1.md", maxDepth: 1 }, meta, metaState: "done" });
    await store.getState().fetchScene();
    await store.getState().expandNode("voyage/2.md");
    expect(store.getState().subgraph!.nodes.map(n => n.id), "the supported outgoing target is revealed").toEqual([1, 2, 3, 4]);
    expect(store.getState().subgraph!.nodes.find(n => n.id === 4)?.distance, "original root distance, rather than an ego distance").toBe(2);
    await store.getState().expandNode("voyage/4.md");
    expect(ids(store.getState().subgraph), "reachable incoming neighbours are not expansion targets").toEqual([1, 2, 3, 4, 6]);
    await store.getState().expandNode("voyage/6.md");
    expect(store.getState().subgraph!.nodes.map(n => n.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const expected = distances();
    for (const node of store.getState().subgraph!.nodes) expect(node.distance).toBe(expected.get(node.id));
    expect(store.getState().subgraph!.nodes.some(n => n.id === 10), "incoming-only links are excluded").toBe(false);
    expect(calls.some(url => url.includes("/neighborhood"))).toBe(false);
    expect(calls.filter(url => url.includes("/discovery")).every(url => new URL(url, "http://localhost").searchParams.get("root") === "voyage/1.md")).toBe(true);
  } finally { ui.dispose(); }
});

test("DISCOVERY_SINGLE_RESPONSE_FIELDS: reconstruction uses one response and deterministic intent sets", () => {
  const data = response(4);
  const intents = [2, 4, 6].map(id => ({ id, path: `voyage/${id}.md`, distance: distances().get(id)! }));
  const scene = revealDiscovery(data, intents, 1);
  expect(revealDiscovery(data, [...intents].reverse().concat(intents), 1)).toEqual(scene);
  expect(revealDiscovery({ ...data, nodes: [...data.nodes].reverse(), edges: [...data.edges].reverse() }, intents, 1)).toEqual(scene);
  expect(scene.nodes.every(n => data.nodes.includes(n))).toBe(true);
  expect(scene.edges.every(e => data.edges.includes(e))).toBe(true);
  const updated = { ...data, nodes: data.nodes.map(n => ({ ...n, title: `${n.title} revised`, outDegree: 0 })) };
  expect(revealDiscovery(updated, intents, 1).nodes.every(n => n.title.endsWith("revised"))).toBe(true);
  expect(revealDiscovery(updated, intents, 1).nodes.every(n => n.outDegree === 0)).toBe(true);
});

test("DISCOVERY_APPLIED_RESPONSE_FIELDS: survivors also use the applied response rather than a merge", async () => {
  const h = await harness();
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.map(n => ({ ...n, title: `${n.title} revised`, outDegree: 0 })) }));
  await h.store.getState().expandNode("voyage/2.md");
  expect(h.store.getState().subgraph!.nodes.every(n => n.title.endsWith("revised")), "every field comes from the single applied response").toBe(true);
  expect(h.store.getState().subgraph!.nodes.every(n => n.outDegree === 0)).toBe(true);
});

test("DISCOVERY_VIRTUAL_ROOT_BFS: seed edges retain virtual-root outgoing distances", () => {
  const data = response(4);
  const edges = links.filter(([s]) => s !== 10).map(([s, t]) => [s === 1 ? 0 : s, t] as const);
  const hops = distances(0, edges);
  const virtual = { ...data, nodes: [{ ...data.nodes[0]!, id: 0, path: "AGENTS.md", virtual: true }, ...data.nodes.slice(1)], edges: data.edges.map(e => ({ ...e, source: e.source === 1 ? 0 : e.source })) };
  const intents = [2, 4, 6].map(id => ({ id, path: `voyage/${id}.md`, distance: hops.get(id)! }));
  const scene = revealDiscovery(virtual, intents, 1);
  for (const node of scene.nodes) expect(node.distance).toBe(hops.get(node.id));
  expect(scene.edges.filter(e => e.source === 0)).toEqual([{ source: 0, target: 2 }, { source: 0, target: 3 }]);
  expect(discoveryExpansionAction(scene.nodes[0]!, scene, { data: virtual, depth: 4 }, emptyDiscoveryExpansion(), false).enabled).toBe(false);
});

test("DISCOVERY_RESPONSE_COUNTS: degree estimates, edge caps and stale evidence cannot claim completeness", () => {
  const data = response(2);
  const base = response(1);
  const node = base.nodes.find(n => n.id === 2)!;
  expect(discoveryExpansionAction(node, base, null, emptyDiscoveryExpansion(), false).count).toBeUndefined();
  const action = discoveryExpansionAction(node, base, { data, depth: 2 }, emptyDiscoveryExpansion(), false);
  expect(action.count).toBe(1);
  expect(action.enabled).toBe(true);
  const shown = revealDiscovery(data, [{ id: 2, path: node.path, distance: 1 }], 1);
  expect(discoveryExpansionAction({ ...node, outDegree: 99999 }, shown, { data, depth: 2 }, emptyDiscoveryExpansion(), false).reason).toContain("already shown");
  for (const limited of [{ ...data, truncated: true }, { ...data, edges: [], truncated: true }]) {
    const outcome = discoveryExpansionAction(node, shown, { data: limited, depth: 2 }, emptyDiscoveryExpansion(), false);
    expect(outcome.reason).toContain("scene limited");
    expect(outcome.reason).not.toContain("already shown");
  }
  expect(discoveryExpansionAction(node, shown, { data, depth: 2 }, emptyDiscoveryExpansion(), true).reason).toContain("not recomputed");
  const staleWithoutRow = { ...data, nodes: data.nodes.filter(n => n.id !== 4), edges: [] };
  expect(discoveryExpansionAction(node, base, { data: staleWithoutRow, depth: 2 }, emptyDiscoveryExpansion(), true).reason).not.toContain("already shown");
});

test("DISCOVERY_DEPTH_EIGHT: evidenced earlier and same-hop targets remain eligible at the supported bound", () => {
  const edges: [number, number][] = [
    ...Array.from({ length: 8 }, (_, i): [number, number] => [i + 1, i + 2]),
    [1, 11], ...Array.from({ length: 7 }, (_, i): [number, number] => [i + 11, i + 12]),
    [9, 17], [9, 18], [9, 19],
  ];
  const data = response(8, edges);
  const node = data.nodes.find(n => n.id === 9)!;
  const scene = revealDiscovery(data, Array.from({ length: 7 }, (_, i) => ({ id: i + 2, path: `voyage/${i + 2}.md`, distance: i + 1 })), 1);
  const expected = distances(1, edges);
  for (const n of data.nodes) expect(n.distance).toBe(expected.get(n.id));
  expect(node.distance).toBe(8);
  expect(data.nodes.some(n => n.id === 19)).toBe(false);
  expect(discoveryExpansionAction(node, scene, { data, depth: 8 }, emptyDiscoveryExpansion(), false).count).toBe(2);
  expect(discoveryExpansionAction(node, data, { data, depth: 8 }, emptyDiscoveryExpansion(), false).reason).toBe("No more notes within 8 hops of the root");
  const intent = [{ id: node.id, path: node.path, distance: 8 }];
  expect(revalidateDiscoveryIntents(intent, { data, depth: 8 }, false).intents).toEqual(intent);
});

test("DISCOVERY_BOUNDED_ABSENCE: omission is unresolved until complete fresh depth-eight evidence", () => {
  const intent = [{ id: 6, path: "voyage/6.md", distance: 3 }];
  for (const depth of [1, 2]) {
    const result = revalidateDiscoveryIntents(intent, { data: response(depth), depth }, false);
    expect(result.intents).toEqual(intent);
    expect(result.unresolved).toEqual([intent[0]!.path]);
  }
  const omitted = { ...response(8), nodes: response(8).nodes.filter(n => n.id !== 6), truncated: true };
  expect(revalidateDiscoveryIntents(intent, { data: omitted, depth: 8 }, false).intents).toEqual(intent);
  expect(revalidateDiscoveryIntents(intent, { data: { ...omitted, truncated: false }, depth: 8 }, true).intents).toEqual(intent);
  expect(revalidateDiscoveryIntents(intent, { data: { ...omitted, truncated: false }, depth: 8 }, false).intents).toEqual([]);
});

test("DISCOVERY_INTEGRITY_NEUTRAL: changed untruncated data refuses safely without blaming capacity", async () => {
  const h = await harness();
  const before = h.store.getState().subgraph;
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.filter(n => n.id !== 3) }));
  await h.store.getState().expandNode("voyage/2.md");
  expect(h.store.getState().subgraph).toBe(before);
  const state = h.store.getState().discoveryExpansion;
  expect(state.errors["voyage/2.md"]?.message).toBe("Could not apply expansion to the current graph; refresh and retry.");
  expect(h.store.getState().discoveryExpansionFor(response(1).nodes.find(n => n.id === 2)!).enabled).toBe(false);
  expect(state.notice).toBeNull();
  h.read(depth => response(depth));
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(ids(h.store.getState().subgraph)).toEqual([1, 2, 3, 4]);
});

test("DISCOVERY_NODE_CAP_INTEGRITY: missing base membership and changed distances trip the guard", () => {
  const base = response(1);
  const omitted = { ...response(2), nodes: response(2).nodes.filter(n => n.id !== 3), truncated: true };
  expect(preservesDiscoveryBase(base, omitted)).toBe(false);
  expect(preservesDiscoveryBase(base, { ...response(2), nodes: response(2).nodes.map(n => n.id === 3 ? { ...n, distance: 2 } : n) })).toBe(false);
});

test("DISCOVERY_CONCURRENT_SET: shared activations apply one deterministic scene and announcement", async () => {
  const scenes: GraphSubgraphResponse[] = [];
  for (const order of [[2, 3], [3, 2]]) {
    const h = await harness();
    const pending = deferred<GraphSubgraphResponse>();
    h.read(depth => depth === 2 ? pending.promise : response(depth));
    const first = h.store.getState().expandNode(`voyage/${order[0]}.md`);
    const second = h.store.getState().expandNode(`voyage/${order[1]}.md`);
    await Promise.resolve(); await Promise.resolve();
    await h.store.getState().expandNode(`voyage/${order[0]}.md`);
    expect(h.calls.filter(url => url.searchParams.get("maxDepth") === "2").length).toBe(1);
    pending.resolve(response(2));
    await Promise.all([first, second]);
    const state = h.store.getState();
    expect(state.discoveryExpansion.notice?.text).toBe("2 notes added · Layout updated");
    expect(state.discoveryExpansion.notice?.sequence).toBe(1);
    expect(state.discoveryExpansion.loading).toEqual([]);
    scenes.push(state.subgraph!);
    await h.store.getState().expandNode("voyage/2.md");
    expect(h.store.getState().discoveryExpansion.notice?.sequence).toBe(1);
  }
  expect(scenes[0]).toEqual(scenes[1]);
});

test("DISCOVERY_CONCURRENT_DEPTH: an in-flight shallower response cannot apply before the largest required depth", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  await h.store.getState().expandNode("voyage/4.md");
  h.store.clearSceneCache();
  const pending = deferred<GraphSubgraphResponse>();
  h.read(depth => depth === 3 ? pending.promise : response(depth));
  const first = h.store.getState().expandNode("voyage/3.md");
  await Promise.resolve(); await Promise.resolve();
  const second = h.store.getState().expandNode("voyage/6.md");
  const before = h.store.getState().subgraph;
  expect(h.store.getState().discoveryExpansion.notice).toBeNull();
  pending.resolve(response(3)); await Promise.all([first, second]);
  expect(ids(before)).toEqual([1, 2, 3, 4, 6]);
  expect(ids(h.store.getState().subgraph)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(h.store.getState().discoveryExpansion.notice?.text).toBe("3 notes added · Layout updated");
  expect(h.calls.filter(url => url.searchParams.get("maxDepth") === "4").length).toBe(1);
});

test("DISCOVERY_DEPTH_EIGHT_SYNC: reachable depth-eight intent reveals earlier/same hops and survives sync without requesting nine", async () => {
  const edges: [number, number][] = [
    ...Array.from({ length: 8 }, (_, i): [number, number] => [i + 1, i + 2]),
    [1, 11], ...Array.from({ length: 7 }, (_, i): [number, number] => [i + 11, i + 12]),
    [9, 17], [9, 18], [9, 19],
  ];
  const h = await harness(depth => response(depth, edges), { ...meta, nodeCount: 19, edgeCount: edges.length });
  for (let id = 2; id <= 9; id++) await h.store.getState().expandNode(`voyage/${id}.md`);
  const state = h.store.getState();
  expect(state.subgraph!.nodes.find(n => n.id === 17)?.distance).toBe(7);
  expect(state.subgraph!.nodes.find(n => n.id === 18)?.distance).toBe(8);
  expect(state.subgraph!.nodes.some(n => n.id === 19)).toBe(false);
  expect(state.discoveryExpansion.notice?.text).toBe("2 notes added · Layout updated");
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z", nodeCount: 19, edgeCount: edges.length });
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(h.store.getState().discoveryExpansion.intents.some(n => n.id === 9 && n.distance === 8)).toBe(true);
  expect(h.store.getState().subgraph).toEqual(state.subgraph);
  expect(h.calls.every(url => Number(url.searchParams.get("maxDepth")) <= 8), "the existing request bound is never widened").toBe(true);
});

for (const event of ["root", "depth", "mode", "filter", "reset-expanded", "reset", "dispose", "sync"] as const) {
  test(`DISCOVERY_GENERATION_${event}: late expansion cannot restore cleared intent or announce`, async () => {
    const h = await harness();
    const pending = deferred<GraphSubgraphResponse>();
    h.read(depth => depth === 2 ? pending.promise : response(depth));
    const work = h.store.getState().expandNode("voyage/2.md");
    await Promise.resolve(); await Promise.resolve();
    switch (event) {
      case "root": h.store.getState().setDiscoveryParams({ root: "voyage/3.md" }); break;
      case "depth": h.store.getState().setDiscoveryParams({ maxDepth: 3 }); break;
      case "mode": h.read(() => response(1)); h.store.getState().setMode("clusters"); break;
      case "filter": h.store.getState().setSceneQuery("Mast"); break;
      case "reset-expanded": await h.store.getState().resetDiscoveryExpanded(); break;
      case "reset": h.store.getState().reset(); break;
      case "dispose": h.ui.dispose(); break;
      case "sync": h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" }); await h.store.getState().fetchMeta(true); break;
    }
    const after = h.store.getState();
    pending.resolve(response(2)); await work;
    expect(h.store.getState().discoveryExpansion.notice).toBeNull();
    expect(h.store.getState().discoveryExpansion.transition).toBeNull();
    if (event !== "sync" && event !== "dispose") expect(h.store.getState().discoveryExpansion.intents).toEqual([]);
    if (["reset", "reset-expanded", "dispose", "filter", "sync"].includes(event)) expect(h.store.getState().subgraph).toBe(after.subgraph);
  });
}

test("DISCOVERY_SYNC_MOVED_PATH: fresh distance growth causes bounded evidence recovery rather than intent loss", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  const moved: [number, number][] = [[1, 3], [3, 5], [5, 7], [7, 8], [8, 9], [9, 2], [2, 4], [4, 6], [10, 6]];
  h.read(depth => response(depth, moved));
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" });
  await h.store.getState().fetchMeta(true);
  await h.store.getState().fetchScene();
  const state = h.store.getState();
  expect(h.calls.some(url => url.searchParams.get("maxDepth") === "8")).toBe(true);
  expect(state.discoveryExpansion.intents).toEqual([{ id: 2, path: "voyage/2.md", distance: 6 }]);
  expect(state.subgraph!.nodes.find(n => n.id === 4)?.distance).toBe(7);
  expect(state.discoveryExpansion.transition).toBeNull();
  expect(state.discoveryExpansion.notice).toBeNull();
});

test("DISCOVERY_SYNC_OMISSION_FAILURE_RECOVERY: capped omission and failed rebuild preserve honest intent", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  const prior = h.store.getState().subgraph;
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" });
  h.read(() => { throw new Error("fixture request refused"); });
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(h.store.getState().subgraph).toBe(prior);
  expect(h.store.getState().discoveryExpansion.stale).toBe(true);
  expect(h.store.getState().discoveryExpansion.intents.map(n => n.path)).toEqual(["voyage/2.md"]);
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.filter(n => n.id !== 2), edges: response(depth).edges.filter(e => e.source !== 2 && e.target !== 2), truncated: true }));
  await h.store.getState().fetchScene();
  expect(h.store.getState().discoveryExpansion.unresolved).toEqual(["voyage/2.md"]);
  expect(h.store.getState().discoveryExpansion.intents.map(n => n.path)).toEqual(["voyage/2.md"]);
  expect(h.store.getState().subgraph!.truncated).toBe(true);
  expect(h.store.getState().discoveryExpansion.stale).toBe(false);
  h.store.clearSceneCache(); h.read(depth => response(depth));
  await h.store.getState().fetchScene();
  expect(ids(h.store.getState().subgraph)).toEqual([1, 2, 3, 4]);
  expect(h.store.getState().discoveryExpansion.unresolved).toEqual([]);
});

for (const change of ["deleted", "unreachable"] as const) test(`DISCOVERY_SYNC_PROVEN_BOUND_ABSENCE_${change}: complete fresh evidence drops the fixture path`, async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" });
  const changed = links.filter(([s, t]) => change === "deleted" ? s !== 2 && t !== 2 : !(s === 1 && t === 2));
  h.read(depth => response(depth, changed));
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(h.store.getState().discoveryExpansion.intents).toEqual([]);
  expect(h.store.getState().discoveryExpansion.unresolved).toEqual([]);
});

test("DISCOVERY_RESET_SELECTION: immediate base restoration retains base identity and clears expanded-only selection", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  h.store.getState().select(2);
  await h.store.getState().resetDiscoveryExpanded();
  expect(h.store.getState().selectedId).toBe(2);
  expect(ids(h.store.getState().subgraph)).toEqual([1, 2, 3]);
  await h.store.getState().expandNode("voyage/2.md");
  h.store.getState().select(4);
  await h.store.getState().resetDiscoveryExpanded();
  expect(h.store.getState().selectedId).toBeNull();
  expect(h.store.getState().discoveryExpansion.intents).toEqual([]);
  expect(h.store.getState().discoveryExpansion.notice).toBeNull();
  expect(h.store.getState().discoveryExpansion.transition).toBeNull();
  expect(h.store.getState().discovery).toEqual({ root: "voyage/1.md", maxDepth: 1 });
});

test("DISCOVERY_ZERO_SUCCESS_AND_RETRY: failed and zero-result actions have distinct truthful notices", async () => {
  const h = await harness();
  h.read(() => { throw new Error("fixture offline"); });
  await h.store.getState().expandNode("voyage/2.md");
  expect(h.store.getState().discoveryExpansion.notice).toBeNull();
  expect(h.store.getState().discoveryExpansion.errors["voyage/2.md"]?.message).toBe("Couldn't load more links.");
  h.read(depth => ({ ...response(depth), edges: response(depth).edges.filter(e => e.source !== 2) }));
  await h.store.getState().expandNode("voyage/2.md");
  expect(h.store.getState().discoveryExpansion.notice?.text).toBe("No new notes added");
  expect(ids(h.store.getState().subgraph)).toEqual([1, 2, 3]);
});

test("DISCOVERY_REQUEST_CONTEXT: a changed computedAt cannot accept a prior request", async () => {
  const h = await harness();
  const pending = deferred<GraphSubgraphResponse>();
  h.read(depth => depth === 2 ? pending.promise : response(depth));
  const work = h.store.getState().expandNode("voyage/2.md");
  await Promise.resolve(); await Promise.resolve();
  h.store.setState({ meta: { ...meta, computedAt: "2026-07-12T05:00:00Z" } });
  const prior = h.store.getState().subgraph;
  pending.resolve(response(2)); await work;
  expect(h.store.getState().subgraph).toBe(prior);
  expect(h.store.getState().discoveryExpansion.notice).toBeNull();
});

test("DISCOVERY_SAME_PRECOMPUTE_SYNC: an old in-flight response cannot populate the refreshed evidence cache", async () => {
  const h = await harness();
  const pending = deferred<GraphSubgraphResponse>();
  h.read(depth => depth === 2 ? pending.promise : response(depth));
  const work = h.store.getState().expandNode("voyage/2.md");
  await Promise.resolve(); await Promise.resolve();
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.map(n => ({ ...n, title: `${n.title} fresh` })) }));
  await h.store.getState().fetchMeta(true);
  const rebuild = h.store.getState().fetchScene();
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.calls.filter(url => url.searchParams.get("maxDepth") === "2").length, "a refreshed query owns independent current evidence").toBe(2);
  } finally { pending.resolve(response(2)); await Promise.all([work, rebuild]); }
  // Re-enter the same query after the obsolete transport has settled: its
  // completion must not overwrite the new epoch's cached response.
  await h.store.getState().fetchScene();
  expect(h.store.getState().subgraph!.nodes.every(n => n.title.endsWith("fresh"))).toBe(true);
  expect(h.store.getState().discoveryExpansion.notice).toBeNull();
});

test("DISCOVERY_RESET_BASE_RESPONSE: reset restores the depth-M response, including edges and its own limit flag", async () => {
  const h = await harness();
  const base = h.store.getState().subgraph!;
  h.read(depth => ({ ...response(depth), edges: response(depth).edges.filter(e => !(e.source === 1 && e.target === 3)), truncated: true }));
  await h.store.getState().expandNode("voyage/2.md");
  expect(h.store.getState().subgraph!.truncated).toBe(true);
  await h.store.getState().resetDiscoveryExpanded();
  expect(h.store.getState().subgraph!.truncated, "a deeper response's cap cannot become the base response's flag").toBe(false);
  expect(h.store.getState().subgraph!.edges).toEqual(base.edges);
});

test("DISCOVERY_ABORT_INVALIDATED_REQUEST: reset aborts native transport and still rejects a non-cooperating late response", async () => {
  let signal: AbortSignal | undefined;
  const pending = deferred<GraphSubgraphResponse>();
  const ui = createBrainUiRoot({ storage: null, request: async (url, init) => {
    const depth = Number(new URL(url, "http://localhost").searchParams.get("maxDepth"));
    if (depth === 2) { signal = init?.signal ?? undefined; return Response.json(await pending.promise); }
    return Response.json(response(depth));
  } });
  owned.push(ui);
  const store = ui.stores.graph;
  store.setState({ mode: "discovery", discovery: { root: "voyage/1.md", maxDepth: 1 }, meta, metaState: "done" });
  await store.getState().fetchScene();
  const work = store.getState().expandNode("voyage/2.md");
  await Promise.resolve(); await Promise.resolve();
  await store.getState().resetDiscoveryExpanded();
  try { expect(signal?.aborted, "the invalidated native request is cancelled").toBe(true); }
  finally { pending.resolve(response(2)); await work; }
  expect(ids(store.getState().subgraph)).toEqual([1, 2, 3]);
  expect(store.getState().discoveryExpansion.notice).toBeNull();
});

test("DISCOVERY_SYNC_PATH_IDENTITY: recycled ids cannot move selection to a different note", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md"); h.store.getState().select(2);
  const remap = (id: number) => id === 2 ? 22 : id === 3 ? 2 : id;
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.map(n => ({ ...n, id: remap(n.id) })), edges: response(depth).edges.map(e => ({ source: remap(e.source), target: remap(e.target) })) }));
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" });
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(h.store.getState().discoveryExpansion.intents).toEqual([{ id: 22, path: "voyage/2.md", distance: 1 }]);
  expect(h.store.getState().selectedId, "an id reused for Circe is not the selected Aeolus identity").toBeNull();
});

test("DISCOVERY_SYNC_ROOT_ID_REBUILD: the same root path retains expansion intent when document ids change", async () => {
  const h = await harness();
  await h.store.getState().expandNode("voyage/2.md");
  h.read(depth => ({ ...response(depth), nodes: response(depth).nodes.map(n => ({ ...n, id: n.id + 100 })), edges: response(depth).edges.map(e => ({ source: e.source + 100, target: e.target + 100 })) }));
  h.meta({ ...meta, computedAt: "2026-07-12T05:00:00Z" });
  await h.store.getState().fetchMeta(true); await h.store.getState().fetchScene();
  expect(h.store.getState().discoveryExpansion.intents).toEqual([{ id: 102, path: "voyage/2.md", distance: 1 }]);
  expect(h.store.getState().subgraph!.nodes.some(n => n.path === "voyage/4.md")).toBe(true);
});
