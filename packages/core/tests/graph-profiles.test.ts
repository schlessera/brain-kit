import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openDatabase } from "../src/lib/db";
import {
  getClusterGraph,
  getDiscoveryGraph,
  getEgoGraph,
  getGraphStats,
  getMaintenanceFindings,
} from "../src/lib/graph/queries";
import * as queries from "../src/queries/index";
import type { QueryCode, QueryResult } from "../src/queries/index";

// Profile inventory (#1354). Core reads one set of graph tables for two
// surfaces: the `brain graph` CLI (lib/graph/queries.ts) and the supported
// `./queries` API, whose behaviour is the UI profile (queries/graph.ts). The
// two differ on purpose and the 2026-10-09 ruling preserves every difference.
// Each expected value below was written against, and passed on, the readers as
// they stood before they were consolidated; none is computed by either reader.

const NOW = "2026-07-12T12:00:00Z";
const INDEXED_AT = "2026-07-12T08:00:00Z";
const COMPUTED_AT = "2026-07-12T09:00:00Z";

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => setSystemTime());

function dbPath(brainPath: string): string {
  return join(brainPath, ".brain-index", "brain.db");
}

function brain(seed: (db: Database) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-graph-profiles-"));
  temporary.push(dir);
  const db = openDatabase(dbPath(dir));
  try {
    db.transaction(() => seed(db))();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return dir;
}

function edit(brainPath: string, sql: string): void {
  const db = new Database(dbPath(brainPath));
  try {
    db.exec(sql);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close(true);
  }
}

/** The CLI opens the resolved database read-only and hands it to the reader. */
function cli<T>(brainPath: string, read: (db: Database) => T): T {
  const db = openDatabase(dbPath(brainPath), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function ok<T>(result: QueryResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("expected a successful query");
  return result.value;
}

function failed(result: QueryResult<unknown>, code: QueryCode): void {
  expect(result).toEqual({ ok: false, error: { code, retryable: false } });
}

const ids = (nodes: { id: number }[]): number[] => nodes.map((node) => node.id);
const sortedEdges = (edges: { source: number; target: number }[]): string[] =>
  edges.map((edge) => `${edge.source}>${edge.target}`).sort();

interface Doc {
  id: number;
  path: string;
  title: string;
  type: string;
  updated: string;
  asset: string | null;
}

/**
 * The voyage: Odysseus links to Ithaca (twice, once through an alias), to
 * Penelope, to himself, to a chart PDF and to Thrinacia, which resolves to
 * nothing. Penelope links to Telemachus, who links back to Odysseus; Troy
 * links to Odysseus. Eurylochus is an isolate. The raft log is a document
 * whose asset type is NULL — a node to the UI profile and not to the CLI.
 * Precomputed analytics cover only the CLI's node set, as the precompute does.
 */
const VOYAGE: Doc[] = [
  { id: 1, path: "crew/odysseus.md", title: "Odysseus", type: "person", updated: "2026-07-12", asset: "markdown" },
  { id: 2, path: "places/ithaca.md", title: "Ithaca", type: "place", updated: "2026-07-10", asset: "markdown" },
  { id: 3, path: "crew/penelope.md", title: "Penelope", type: "person", updated: "2026-07-11", asset: "markdown" },
  { id: 4, path: "crew/telemachus.md", title: "Telemachus", type: "person", updated: "2026-07-01", asset: "markdown" },
  { id: 5, path: "places/troy.md", title: "Troy", type: "place", updated: "2016-07-12", asset: "markdown" },
  { id: 6, path: "crew/eurylochus.md", title: "Eurylochus", type: "person", updated: "2026-03-01", asset: "markdown" },
  { id: 7, path: "maps/aegean.pdf", title: "Aegean chart", type: "asset", updated: "2026-07-12", asset: "pdf" },
  { id: 8, path: "logs/raft-build.md", title: "Raft build", type: "log", updated: "2026-07-08", asset: null },
];

const LINKS: [number, string, number | null][] = [
  [1, "places/ithaca.md", 2],
  [1, "Ithaca Harbour", 2],
  [1, "crew/penelope.md", 3],
  [1, "crew/odysseus.md", 1],
  [1, "maps/aegean.pdf", 7],
  [1, "Thrinacia", null],
  [3, "crew/telemachus.md", 4],
  [4, "crew/odysseus.md", 1],
  [5, "crew/odysseus.md", 1],
  [2, "logs/raft-build.md", 8],
  [8, "Scheria", null],
];

// document_id, in, out, pagerank, community
const METRICS: [number, number, number, number, number | null][] = [
  [1, 2, 2, 0.3, 0],
  [2, 1, 0, 0.2, 0],
  [3, 1, 1, 0.15, 0],
  [4, 1, 1, 0.1, 0],
  [5, 0, 1, 0.05, 1],
  [6, 0, 0, 0.01, null],
];

function insertDocs(db: Database, docs: Doc[]): void {
  const insert = db.query(
    `INSERT INTO documents (id, path, title, type, status, created, updated, content, indexed_at, asset_type)
     VALUES (?, ?, ?, ?, 'active', '2026-01-01', ?, 'Ithaca', ?, ?)`
  );
  for (const doc of docs) insert.run(doc.id, doc.path, doc.title, doc.type, doc.updated, INDEXED_AT, doc.asset);
}

function seedVoyage(db: Database): void {
  insertDocs(db, VOYAGE);
  const link = db.query("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)");
  for (const [source, target, targetId] of LINKS) link.run(source, target, targetId);
  const metric = db.query(
    "INSERT INTO graph_metrics (document_id, in_degree, out_degree, component, pagerank, community) VALUES (?, ?, ?, 1, ?, ?)"
  );
  for (const [id, inDegree, outDegree, pagerank, community] of METRICS) metric.run(id, inDegree, outDegree, pagerank, community);
  const layout = db.query("INSERT INTO graph_layouts (mode, document_id, x, y) VALUES ('clusters', ?, ?, ?)");
  for (const [id] of METRICS) layout.run(id, id * 10, -id * 10);
  db.run("INSERT INTO graph_communities (community, size, label, top_terms) VALUES (0, 4, 'Ithaca', '[\"ithaca\"]'), (1, 1, 'Troy', '[]')");
  const distance = db.query("INSERT INTO graph_root_distances (document_id, distance, parent_id) VALUES (?, ?, ?)");
  distance.run(1, 1, null);
  distance.run(2, 2, 1);
  distance.run(3, 2, 1);
  distance.run(4, 3, 3);
  const meta = db.query("INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)");
  meta.run("graph_computed_at", COMPUTED_AT);
  meta.run("graph_root", "virtual:AGENTS.md");
  meta.run("graph_root_links", "[1]");
}

/** Strip the precompute: graph tables empty, no graph metadata. */
const UNCOMPUTE = `DELETE FROM graph_metrics; DELETE FROM graph_layouts; DELETE FROM graph_communities;
  DELETE FROM graph_root_distances; DELETE FROM index_metadata WHERE key LIKE 'graph_%';`;

/** A supported pre-v8 layout: no graph tables at all. */
const DOWNGRADE = `DROP TABLE graph_metrics; DROP TABLE graph_layouts; DROP TABLE graph_communities;
  DROP TABLE graph_root_distances; DELETE FROM index_metadata WHERE key LIKE 'graph_%';
  UPDATE index_metadata SET value = '7' WHERE key = 'schema_version';`;

let voyage: string;
beforeAll(() => {
  voyage = brain(seedVoyage);
});

describe("node and edge scope", () => {
  test("UI treats a NULL asset type as markdown and orders edges by the engine; CLI requires 'markdown' and sorts", () => {
    const ui = ok(queries.readGraphClusters({ brainPath: voyage, includeIsolates: true }));
    const cliGraph = cli(voyage, (db) => getClusterGraph(db));
    expect(ids(ui.nodes)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(ids(cliGraph.nodes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sortedEdges(ui.edges)).toEqual(["1>2", "1>3", "2>8", "3>4", "4>1", "5>1"]);
    expect(cliGraph.edges).toEqual([
      { source: 1, target: 2 },
      { source: 1, target: 3 },
      { source: 3, target: 4 },
      { source: 4, target: 1 },
      { source: 5, target: 1 },
    ]);
  });
});

describe("clusters: isolate defaults, ordering and node shape", () => {
  test("UI excludes isolates by metrics degree and ranks by pagerank", () => {
    const ui = ok(queries.readGraphClusters({ brainPath: voyage }));
    expect(ids(ui.nodes)).toEqual([1, 2, 3, 4, 5]);
    expect(ui.truncated).toBe(false);
    expect(ui.nodes[0]).toEqual({
      id: 1,
      path: "crew/odysseus.md",
      title: "Odysseus",
      type: "person",
      inDegree: 2,
      outDegree: 2,
      community: 0,
      pagerank: 0.3,
      x: 10,
      y: -10,
    });
    expect(sortedEdges(ui.edges)).toEqual(["1>2", "1>3", "3>4", "4>1", "5>1"]);
    // NULL pagerank sorts last; a node without metrics carries no analytics.
    const all = ok(queries.readGraphClusters({ brainPath: voyage, includeIsolates: true }));
    expect(all.nodes.at(-1)).toEqual({
      id: 8,
      path: "logs/raft-build.md",
      title: "Raft build",
      type: "log",
      inDegree: 0,
      outDegree: 0,
    });
  });

  test("CLI includes isolates by default, keeps document id order and drops isolates by adjacency", () => {
    const all = cli(voyage, (db) => getClusterGraph(db));
    expect(ids(all.nodes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.truncated).toBe(false);
    expect(all.nodes[5]).toEqual({
      id: 6,
      path: "crew/eurylochus.md",
      title: "Eurylochus",
      type: "person",
      inDegree: 0,
      outDegree: 0,
      pagerank: 0.01,
      x: 60,
      y: -60,
    });
    const linked = cli(voyage, (db) => getClusterGraph(db, { includeIsolates: false }));
    expect(ids(linked.nodes)).toEqual([1, 2, 3, 4, 5]);
    const community = cli(voyage, (db) => getClusterGraph(db, { community: 1 }));
    expect(ids(community.nodes)).toEqual([5]);
    expect(community.edges).toEqual([]);
  });
});

describe("neighborhood: ordering, missing centers and path handling", () => {
  test("UI loads the reached ids in row order with layout; CLI keeps BFS order without layout", () => {
    const ui = ok(queries.readGraphNeighborhood({ brainPath: voyage, center: "crew/telemachus.md" }));
    expect(ui.nodes.map((n) => [n.id, n.distance])).toEqual([
      [1, 1],
      [3, 1],
      [4, 0],
    ]);
    expect(ui.nodes[0].x).toBe(10);
    const cliGraph = cli(voyage, (db) => getEgoGraph(db, { center: "crew/telemachus.md" }));
    expect(cliGraph.nodes.map((n) => [n.id, n.distance])).toEqual([
      [4, 0],
      [1, 1],
      [3, 1],
    ]);
    expect(cliGraph.nodes[1]).toEqual({
      id: 1,
      path: "crew/odysseus.md",
      title: "Odysseus",
      type: "person",
      inDegree: 2,
      outDegree: 2,
      community: 0,
      pagerank: 0.3,
      distance: 1,
    });
    expect(cliGraph.edges).toEqual([
      { source: 1, target: 3 },
      { source: 3, target: 4 },
      { source: 4, target: 1 },
    ]);
  });

  test("depth defaults to 1 and clamps to 3 in both; the walk follows each profile's edge scope", () => {
    const uiDeep = ok(queries.readGraphNeighborhood({ brainPath: voyage, center: "crew/odysseus.md", depth: 9, direction: "out" }));
    expect(uiDeep.nodes.map((n) => [n.id, n.distance])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 2],
      [8, 2],
    ]);
    const cliDeep = cli(voyage, (db) => getEgoGraph(db, { center: "crew/odysseus.md", depth: 9, direction: "out" }));
    expect(cliDeep.nodes.map((n) => [n.id, n.distance])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 2],
    ]);
    expect(ids(ok(queries.readGraphNeighborhood({ brainPath: voyage, center: "crew/odysseus.md" })).nodes)).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cli(voyage, (db) => getEgoGraph(db, { center: "crew/odysseus.md" })).nodes)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a missing center is not_found for the UI and an empty subgraph for the CLI", () => {
    failed(queries.readGraphNeighborhood({ brainPath: voyage, center: "crew/argos.md" }), "not_found");
    failed(queries.readGraphNeighborhood({ brainPath: voyage, center: "maps/aegean.pdf" }), "not_found");
    const empty = { nodes: [], edges: [], truncated: false };
    expect(cli(voyage, (db) => getEgoGraph(db, { center: "crew/argos.md" }))).toEqual(empty);
    expect(cli(voyage, (db) => getEgoGraph(db, { center: "maps/aegean.pdf" }))).toEqual(empty);
    // The NULL-asset log is a UI node and no CLI node.
    expect(ids(ok(queries.readGraphNeighborhood({ brainPath: voyage, center: "logs/raft-build.md" })).nodes)).toEqual([2, 8]);
    expect(cli(voyage, (db) => getEgoGraph(db, { center: "logs/raft-build.md" }))).toEqual(empty);
    // The UI normalizes a leading "./"; the CLI matches the stored path exactly.
    expect(ids(ok(queries.readGraphNeighborhood({ brainPath: voyage, center: "./places/troy.md" })).nodes)).toEqual([1, 5]);
    expect(cli(voyage, (db) => getEgoGraph(db, { center: "./places/troy.md" }))).toEqual(empty);
  });
});

describe("discovery: virtual root, explicit roots and counts", () => {
  test("the default virtual root differs in shape, edge position and reach counts", () => {
    const ui = ok(queries.readGraphDiscovery({ brainPath: voyage }));
    expect(ui.nodes[0]).toEqual({
      id: 0,
      path: "AGENTS.md",
      title: "AGENTS.md",
      type: "root",
      inDegree: 0,
      outDegree: 1,
      distance: 0,
      virtual: true,
    });
    expect(ui.nodes.map((n) => [n.id, n.distance])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 3],
    ]);
    expect(ui.edges[0]).toEqual({ source: 0, target: 1 });
    expect(sortedEdges(ui.edges)).toEqual(["0>1", "1>2", "1>3", "3>4", "4>1"]);
    expect(ui.reachableCount).toBe(4);
    expect(ui.unreachableCount).toBe(3);
    expect(ui.truncated).toBe(false);

    const cliGraph = cli(voyage, (db) => getDiscoveryGraph(db));
    expect(cliGraph.nodes[0]).toEqual({
      id: 0,
      path: "AGENTS.md",
      title: "AGENTS.md",
      type: "index",
      inDegree: 0,
      outDegree: 0,
      distance: 0,
      virtual: true,
    });
    expect(ids(cliGraph.nodes)).toEqual([0, 1, 2, 3, 4]);
    expect(cliGraph.edges).toEqual([
      { source: 1, target: 2 },
      { source: 1, target: 3 },
      { source: 3, target: 4 },
      { source: 4, target: 1 },
      { source: 0, target: 1 },
    ]);
    expect(cliGraph).not.toHaveProperty("reachableCount");
    expect(cliGraph).not.toHaveProperty("unreachableCount");

    expect(ids(ok(queries.readGraphDiscovery({ brainPath: voyage, maxDepth: 2 })).nodes)).toEqual([0, 1, 2, 3]);
    expect(ids(cli(voyage, (db) => getDiscoveryGraph(db, { maxDepth: 2 })).nodes)).toEqual([0, 1, 2, 3]);
  });

  test("root link ids: the UI keeps finite numbers, the CLI coerces to integers", () => {
    const dir = brain(seedVoyage);
    edit(dir, `UPDATE index_metadata SET value = '[1, "5", 2.5]' WHERE key = 'graph_root_links';
      INSERT INTO graph_root_distances (document_id, distance, parent_id) VALUES (5, 1, NULL);`);
    const ui = ok(queries.readGraphDiscovery({ brainPath: dir }));
    expect(ui.edges.filter((e) => e.source === 0)).toEqual([{ source: 0, target: 1 }]);
    const cliGraph = cli(dir, (db) => getDiscoveryGraph(db));
    expect(cliGraph.edges.filter((e) => e.source === 0)).toEqual([
      { source: 0, target: 1 },
      { source: 0, target: 5 },
    ]);
  });

  test("an explicit root walks per request; only the UI reports reach", () => {
    const ui = ok(queries.readGraphDiscovery({ brainPath: voyage, root: "crew/penelope.md" }));
    expect(ui.nodes.map((n) => [n.id, n.distance])).toEqual([
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 1],
      [8, 4],
    ]);
    expect(ui.reachableCount).toBe(5);
    expect(ui.unreachableCount).toBe(2);
    const cliGraph = cli(voyage, (db) => getDiscoveryGraph(db, { root: "crew/penelope.md" }));
    expect(cliGraph.nodes.map((n) => [n.id, n.distance])).toEqual([
      [3, 0],
      [4, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(cliGraph).not.toHaveProperty("reachableCount");
    // Only the CLI walks inbound from a discovery root.
    failed(queries.readGraphDiscovery({ brainPath: voyage, root: "crew/odysseus.md", direction: "in" as "out" }), "invalid_input");
    expect(ids(cli(voyage, (db) => getDiscoveryGraph(db, { root: "crew/odysseus.md", direction: "in", maxDepth: 1 })).nodes)).toEqual([1, 4, 5]);
  });

  test("a missing root is not_found for the UI and an empty subgraph for the CLI", () => {
    failed(queries.readGraphDiscovery({ brainPath: voyage, root: "crew/argos.md" }), "not_found");
    expect(cli(voyage, (db) => getDiscoveryGraph(db, { root: "crew/argos.md" }))).toEqual({ nodes: [], edges: [], truncated: false });
  });
});

describe("maintenance: findings, ordering and staleDays", () => {
  test("defaults: 180 days, UI ordering and caps, CLI id order and root echo", () => {
    setSystemTime(new Date(NOW));
    const ui = ok(queries.readGraphMaintenance({ brainPath: voyage }));
    expect(ui.staleDays).toBe(180);
    expect(ids(ui.orphans)).toEqual([8, 6]);
    expect(ids(ui.unreachable)).toEqual([5, 6, 8]);
    expect(ids(ui.stale)).toEqual([5]);
    expect(ui.stale[0].updated).toBe("2016-07-12");
    expect(ui.brokenLinks).toEqual([
      { sourcePath: "crew/odysseus.md", target: "Thrinacia" },
      { sourcePath: "logs/raft-build.md", target: "Scheria" },
    ]);
    expect(ui).not.toHaveProperty("root");

    const cliFindings = cli(voyage, (db) => getMaintenanceFindings(db));
    expect(cliFindings.staleDays).toBe(180);
    expect(cliFindings.root).toBe("virtual:AGENTS.md");
    expect(ids(cliFindings.orphans)).toEqual([6]);
    expect(ids(cliFindings.unreachable)).toEqual([5, 6]);
    expect(ids(cliFindings.stale)).toEqual([5]);
    expect(cliFindings.brokenLinks).toEqual(ui.brokenLinks);
  });

  test("the UI clamps staleDays to 1..3650; the CLI uses the value as given", () => {
    setSystemTime(new Date(NOW));
    const stale = (staleDays: number) => {
      const ui = ok(queries.readGraphMaintenance({ brainPath: voyage, staleDays, now: NOW }));
      const cliFindings = cli(voyage, (db) => getMaintenanceFindings(db, { staleDays }));
      return {
        ui: [ui.staleDays, ids(ui.stale)],
        cli: [cliFindings.staleDays, ids(cliFindings.stale)],
      };
    };
    expect(stale(0)).toEqual({ ui: [1, [5, 6, 4, 8, 2]], cli: [0, [2, 3, 4, 5, 6]] });
    expect(stale(-5)).toEqual({ ui: [1, [5, 6, 4, 8, 2]], cli: [-5, [1, 2, 3, 4, 5, 6]] });
    expect(stale(4000)).toEqual({ ui: [3650, [5]], cli: [4000, []] });
    expect(stale(3650)).toEqual({ ui: [3650, [5]], cli: [3650, [5]] });
  });
});

describe("absent, uncomputed and older graph data", () => {
  test("uncomputed: the UI refuses derived modes and keeps raw neighborhoods; the CLI degrades every mode", () => {
    const dir = brain(seedVoyage);
    edit(dir, UNCOMPUTE);
    failed(queries.readGraphClusters({ brainPath: dir }), "not_computed");
    failed(queries.readGraphDiscovery({ brainPath: dir }), "not_computed");
    failed(queries.readGraphDiscovery({ brainPath: dir, root: "crew/odysseus.md" }), "not_computed");
    failed(queries.readGraphMaintenance({ brainPath: dir }), "not_computed");
    const hood = ok(queries.readGraphNeighborhood({ brainPath: dir, center: "crew/odysseus.md" }));
    // Without metrics the UI reports zero degrees; the CLI counts adjacency.
    expect(hood.nodes.find((n) => n.id === 1)).toEqual({
      id: 1,
      path: "crew/odysseus.md",
      title: "Odysseus",
      type: "person",
      inDegree: 0,
      outDegree: 0,
      distance: 0,
    });
    const ego = cli(dir, (db) => getEgoGraph(db, { center: "crew/odysseus.md" }));
    expect(ego.nodes[0]).toEqual({
      id: 1,
      path: "crew/odysseus.md",
      title: "Odysseus",
      type: "person",
      inDegree: 2,
      outDegree: 2,
      distance: 0,
    });
    const clusters = cli(dir, (db) => getClusterGraph(db));
    expect(ids(clusters.nodes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(clusters.nodes.filter((n) => n.pagerank !== undefined || n.x !== undefined)).toEqual([]);
    expect(cli(dir, (db) => getDiscoveryGraph(db))).toEqual({ nodes: [], edges: [], truncated: false });
    expect(ids(cli(dir, (db) => getDiscoveryGraph(db, { root: "crew/odysseus.md", maxDepth: 1 })).nodes)).toEqual([1, 2, 3]);
    const findings = cli(dir, (db) => getMaintenanceFindings(db));
    expect(findings.root).toBeNull();
    expect(findings.unreachable).toEqual([]);
    expect(ids(findings.orphans)).toEqual([6]);
    expect(cli(dir, (db) => getGraphStats(db))).toMatchObject({ computedAt: null, root: null, nodes: 0, edges: 5, reachable: 0 });
  });

  test("older layout: the UI keeps only the neighborhood; the CLI reads links without the derived tables", () => {
    const dir = brain(seedVoyage);
    edit(dir, DOWNGRADE);
    expect(ok(queries.readGraphMeta({ brainPath: dir }))).toMatchObject({ available: false, reason: "schema", schemaVersion: 7 });
    failed(queries.readGraphClusters({ brainPath: dir }), "incompatible_index");
    failed(queries.readGraphDiscovery({ brainPath: dir }), "incompatible_index");
    failed(queries.readGraphMaintenance({ brainPath: dir }), "incompatible_index");
    expect(ids(ok(queries.readGraphNeighborhood({ brainPath: dir, center: "crew/odysseus.md" })).nodes)).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cli(dir, (db) => getClusterGraph(db)).nodes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cli(dir, (db) => getDiscoveryGraph(db))).toEqual({ nodes: [], edges: [], truncated: false });
    expect(ids(cli(dir, (db) => getEgoGraph(db, { center: "crew/odysseus.md" })).nodes)).toEqual([1, 2, 3, 4, 5]);
    expect(ids(cli(dir, (db) => getMaintenanceFindings(db)).orphans)).toEqual([6]);
    expect(cli(dir, (db) => getGraphStats(db))).toMatchObject({ computedAt: null, nodes: 0, edges: 5, components: 0, communities: [] });
  });

  test("an absent index is a typed UI failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-graph-profiles-absent-"));
    temporary.push(dir);
    failed(queries.readGraphNeighborhood({ brainPath: dir, center: "crew/odysseus.md" }), "missing_index");
  });
});

describe("caps and truncation on a fleet-sized ledger", () => {
  // Odysseus's hub note links to 5,100 ledger entries, all last touched in
  // 2015. Every UI cap is exceeded; the CLI has no cap in any mode.
  const ENTRIES = 5100;
  let fleet: string;
  beforeAll(() => {
    fleet = brain((db) => {
      const entries: Doc[] = [];
      for (let i = 0; i < ENTRIES; i++) {
        entries.push({ id: 100 + i, path: `ledger/entry-${String(i).padStart(4, "0")}.md`, title: `Ledger ${i}`, type: "note", updated: "2015-07-12", asset: "markdown" });
      }
      insertDocs(db, [VOYAGE[0], ...entries]);
      const link = db.query("INSERT INTO links (source_id, target, target_id) VALUES (1, ?, ?)");
      for (const entry of entries) link.run(entry.path, entry.id);
      const metric = db.query(
        "INSERT INTO graph_metrics (document_id, in_degree, out_degree, component, pagerank, community) VALUES (?, ?, ?, 1, ?, 0)"
      );
      metric.run(1, 0, ENTRIES, 1);
      for (const entry of entries) metric.run(entry.id, 1, 0, entry.id / 1e6);
      db.run("INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('graph_computed_at', ?)", [COMPUTED_AT]);
    });
  });

  test("neighborhood: the UI stops at 1,500 nodes; the CLI returns every neighbour", () => {
    const ui = ok(queries.readGraphNeighborhood({ brainPath: fleet, center: "crew/odysseus.md" }));
    expect(ui.nodes.length).toBe(1500);
    expect(ui.truncated).toBe(true);
    const cliGraph = cli(fleet, (db) => getEgoGraph(db, { center: "crew/odysseus.md" }));
    expect(cliGraph.nodes.length).toBe(ENTRIES + 1);
    expect(cliGraph.edges.length).toBe(ENTRIES);
    expect(cliGraph.truncated).toBe(false);
  });

  test("explicit-root discovery: the UI caps at 5,000 and reports full reach; the CLI walk has no budget", () => {
    const ui = ok(queries.readGraphDiscovery({ brainPath: fleet, root: "crew/odysseus.md" }));
    expect(ui.nodes.length).toBe(5000);
    expect(ui.truncated).toBe(true);
    expect(ui.reachableCount).toBe(ENTRIES + 1);
    expect(ui.unreachableCount).toBe(0);
    const cliGraph = cli(fleet, (db) => getDiscoveryGraph(db, { root: "crew/odysseus.md" }));
    expect(cliGraph.nodes.length).toBe(ENTRIES + 1);
    expect(cliGraph.truncated).toBe(false);
  });

  test("clusters keep the 5,000 highest-pagerank nodes for the UI and every node for the CLI", () => {
    const ui = ok(queries.readGraphClusters({ brainPath: fleet }));
    expect(ui.nodes.length).toBe(5000);
    expect(ui.truncated).toBe(true);
    expect(ui.nodes[0].id).toBe(1);
    expect(ui.nodes[1].id).toBe(100 + ENTRIES - 1);
    const cliGraph = cli(fleet, (db) => getClusterGraph(db));
    expect(cliGraph.nodes.length).toBe(ENTRIES + 1);
    expect(cliGraph.truncated).toBe(false);
  });

  test("maintenance lists stop at 5,000 for the UI and are complete for the CLI", () => {
    setSystemTime(new Date(NOW));
    const ui = ok(queries.readGraphMaintenance({ brainPath: fleet, now: NOW }));
    expect(ui.stale.length).toBe(5000);
    expect(ui.stale[0].id).toBe(100);
    const cliFindings = cli(fleet, (db) => getMaintenanceFindings(db));
    expect(cliFindings.stale.length).toBe(ENTRIES);
  });
});
