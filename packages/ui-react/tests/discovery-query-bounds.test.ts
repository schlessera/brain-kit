import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as queries from "@schlessera/brain/queries";
import { getDiscovery } from "../../ui-server/src/graph/reader.js";
import { createBrainFixture, type FixtureOptions } from "../../ui-server/tests/helpers/graph-fixture.js";
import { discoveryExpansionAction, emptyDiscoveryExpansion } from "../src/lib/discovery-expansion.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(opts: FixtureOptions) {
  const root = mkdtempSync(join(tmpdir(), "brain-discovery-bounds-")); roots.push(root);
  createBrainFixture(root, { ...opts, metadata: { graph_computed_at: "2026-07-12T04:40:00Z", ...opts.metadata } });
  return root;
}
const docs = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, path: `voyage/note-${i + 1}.md`, title: `Ithaca voyage note ${i + 1}`, updated: "2026-07-12", indexedAt: "2026-07-12T04:00:00Z" }));

test("DISCOVERY_REAL_NODE_CAP: the supported UI reader preserves outgoing distances and its 5000-node bound", () => {
  const notes = docs(5003);
  const links = notes.slice(1, 5002).map(n => ({ sourceId: 1, targetId: n.id, target: n.path }));
  links.push({ sourceId: 5003, targetId: 1, target: notes[0]!.path });
  const root = fixture({ docs: notes, links });
  const scene = getDiscovery(queries, { brainPath: root, root: notes[0]!.path, maxDepth: 1 });
  expect(scene.nodes.length).toBe(5000);
  expect(scene.truncated).toBe(true);
  expect(scene.nodes.find(n => n.id === 1)?.distance).toBe(0);
  expect(scene.nodes.filter(n => n.id !== 1).every(n => n.distance === 1)).toBe(true);
  expect(scene.nodes.some(n => n.id === 5003), "incoming-only note never becomes an outgoing BFS node").toBe(false);
  expect(scene.edges.every(e => e.source === 1 && scene.nodes.some(n => n.id === e.target))).toBe(true);
});

test("DISCOVERY_REAL_VIRTUAL_CAP: default-root rank capping retains the synthetic root and honest limited eligibility", () => {
  const notes = docs(5001);
  const root = fixture({ docs: notes, rootDistances: notes.map(n => ({ documentId: n.id, distance: 1, parentId: 0 })),
    metrics: notes.map(n => ({ documentId: n.id, inDegree: 1, outDegree: 999, pagerank: 1 / n.id })),
    metadata: { graph_root: "virtual:AGENTS.md", graph_root_links: JSON.stringify(notes.map(n => n.id)) },
  });
  const scene = getDiscovery(queries, { brainPath: root, maxDepth: 2 });
  expect(scene.nodes.length).toBe(5000);
  expect(scene.truncated).toBe(true);
  expect(scene.nodes.find(n => n.id === 0)).toMatchObject({ virtual: true, path: "AGENTS.md", distance: 0 });
  expect(scene.nodes.filter(n => n.id !== 0).every(n => n.distance === 1)).toBe(true);
  const note = scene.nodes.find(n => n.id === 1)!;
  const action = discoveryExpansionAction(note, scene, { data: scene, depth: 2 }, emptyDiscoveryExpansion(), false);
  expect(action.count).toBe(0);
  expect(action.reason).toContain("scene limited");
  expect(action.reason).not.toContain("already shown");
});

test("DISCOVERY_REAL_EDGE_ONLY_CAP: all nodes may survive while the actual 20000-edge bound makes completeness unknown", () => {
  const notes = docs(202);
  const links = notes.slice(1).map(n => ({ sourceId: 1, targetId: n.id, target: n.path }));
  for (const source of notes.slice(1)) for (const target of notes.slice(1)) {
    if (source.id === target.id || links.length >= 20001) continue;
    links.push({ sourceId: source.id, targetId: target.id, target: target.path });
  }
  expect(links.length).toBe(20001);
  const root = fixture({ docs: notes, links });
  const scene = getDiscovery(queries, { brainPath: root, root: notes[0]!.path, maxDepth: 2 });
  expect(scene.nodes.length).toBe(202);
  expect(scene.edges.length).toBe(20000);
  expect(scene.truncated).toBe(true);
  expect(scene.nodes.filter(n => n.id !== 1).every(n => n.distance === 1)).toBe(true);
  const action = discoveryExpansionAction(scene.nodes.find(n => n.id === 2)!, scene, { data: scene, depth: 2 }, emptyDiscoveryExpansion(), false);
  expect(action.reason).toContain("scene limited");
  expect(action.reason).not.toContain("already shown");
});
