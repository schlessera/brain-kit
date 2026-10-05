/**
 * F5 — the brain.db read contract, asserted across the package boundary.
 *
 * Outside consumers may still read `$BRAIN_PATH/brain.db` with hand-written
 * SQL under the documented direct-read contract, so the schema is a
 * documented contract rather than a shared type. Until this file existed,
 * nothing checked it: ui-server's graph tests then built their fixture with
 * the schema ui-server *assumed*, so core renaming a column left them green
 * and broke production at the next `brain index`. (ui-server itself now reads
 * through core's supported query entry, an optional peer.)
 *
 * This test is the tie. It indexes the real fixture corpus with the real CLI,
 * then points ui-server's real readers at the result. Everything it asserts is
 * something a consumer outside this monorepo is entitled to rely on, so a
 * failure here is a CONTRACT change: fix the drift, or update
 * docs/integration-contract.md and take the major-version discussion.
 *
 * Everything here is the INTERNAL schema side: table, column and version
 * checks under the still-binding direct-SQL promise, kept until #701 retires
 * it. The supported results every consumer reads are asserted separately, in
 * tests/index-query-consumers.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { SCHEMA_VERSION } from "@schlessera/brain";
import {
  MIN_BRAIN_SCHEMA_VERSION,
  buildKeyterms,
} from "@schlessera/brain-ui-server";
import {
  getClusters,
  getGraphMeta,
  getMaintenance,
  getNeighborhood,
} from "../packages/ui-server/src/graph/reader.js";
import { createCoreQueryAccess, type GraphQueries } from "../packages/ui-server/src/core-queries.js";

/** ui-server's graph operations, resolved from the workspace core as the server does. */
function graph(): GraphQueries {
  const capability = createCoreQueryAccess().graph();
  if (!capability.ok) throw new Error(`core query capability unusable: ${capability.reason}`);
  return capability.queries;
}

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE_CORPUS = join(ROOT, "packages/core/fixtures/corpus");
const BRAIN_BIN = join(ROOT, "packages/core/src/cli/brain.ts");
const CONTRACT_DOC = join(ROOT, "docs/integration-contract.md");

/**
 * Columns ui-server's SQL selects, plus the ones the contract doc promises.
 * Spelled out rather than introspected: the point is to state what outside
 * consumers may depend on, so that dropping one is a decision and not an
 * accident. A column ADDED to core is fine and must not fail this test.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  index_metadata: ["key", "value"],
  documents: ["id", "path", "title", "type", "status", "relevance", "indexed_at"],
  chunks: ["id", "document_id"],
  tags: ["id", "name"],
  document_tags: ["document_id", "tag_id"],
  links: ["source_id", "target_id"],
  graph_metrics: ["document_id", "in_degree", "out_degree", "component", "pagerank", "community"],
  graph_communities: ["community", "size", "label", "top_terms"],
  graph_root_distances: ["document_id", "distance", "parent_id"],
  graph_layouts: ["mode", "document_id", "x", "y"],
};

let brainPath: string;

/** A real, CLI-produced brain.db — never a hand-written fixture. */
beforeAll(async () => {
  brainPath = mkdtempSync(join(tmpdir(), "brain-db-contract-"));
  cpSync(FIXTURE_CORPUS, brainPath, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(brainPath, "node_modules"));
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(join(brainPath, `brain.db${suffix}`), { force: true });
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.BRAIN_ROOT = brainPath;
  // Keyless: FTS-only, deterministic, no network. Matches the CLI harness.
  delete env.GEMINI_API_KEY;
  // The jev reranker is the default with its key: a developer key would
  // turn these runs into paid network calls.
  delete env.TYPESAFE_API_KEY;
  delete env.BRAIN_RERANK_MODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.GOOGLE_API_KEY;

  const proc = Bun.spawn(["bun", BRAIN_BIN, "index", "--force", "--json"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `brain index failed: ${stderr}`).toBe(0);
  expect(JSON.parse(stdout).total).toBeGreaterThan(0);
});

afterAll(() => {
  if (brainPath) rmSync(brainPath, { recursive: true, force: true });
});

function openDb(): Database {
  return new Database(join(brainPath, "brain.db"), { readonly: true });
}

describe("brain.db schema version has one source", () => {
  test("core writes the version core exports", () => {
    const db = openDb();
    try {
      const row = db
        .query<{ value: string }, []>(
          "SELECT value FROM index_metadata WHERE key = 'schema_version'"
        )
        .get();
      expect(Number.parseInt(row?.value ?? "", 10)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("the integration contract documents the version core writes", () => {
    const doc = readFileSync(CONTRACT_DOC, "utf8");
    const match = doc.match(/`schema_version`\s*\(currently\s*\*\*(\d+)\*\*\)/);
    expect(
      match,
      "docs/integration-contract.md no longer states the schema version in the " +
        "form this test reads; keep the phrasing or update the pattern here"
    ).not.toBeNull();
    expect(Number.parseInt(match![1], 10)).toBe(SCHEMA_VERSION);
  });

  test("every ui-server read floor is reachable by what core writes", () => {
    // A floor ABOVE what core produces means the shipped server refuses a
    // freshly indexed brain — the exact failure a bump used to cause silently.
    // (The graph's own floor now lives in core's query compatibility checks.)
    expect(MIN_BRAIN_SCHEMA_VERSION).toBeLessThanOrEqual(SCHEMA_VERSION);
  });
});

describe("brain.db tables the contract promises", () => {
  test("every documented table exists with its documented columns", () => {
    const db = openDb();
    try {
      const tables = new Set(
        db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = ?"
          )
          .all("table")
          .map((r) => r.name)
      );
      const missingTables = Object.keys(REQUIRED_COLUMNS).filter((t) => !tables.has(t));
      expect(missingTables, "documented tables missing from a real brain.db").toEqual([]);

      const missingColumns: string[] = [];
      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        const present = new Set(
          db
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => r.name)
        );
        for (const column of columns) {
          if (!present.has(column)) missingColumns.push(`${table}.${column}`);
        }
      }
      expect(
        missingColumns,
        "columns ui-server selects (and the contract documents) are gone"
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the graph tables carry rows after an index run", () => {
    const db = openDb();
    try {
      for (const table of ["documents", "links", "graph_metrics", "graph_communities"]) {
        const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
        expect(row?.n ?? 0, `${table} is empty after brain index --force`).toBeGreaterThan(0);
      }
      // Provenance keys the contract tells consumers to read.
      const meta = new Map(
        db
          .query<{ key: string; value: string }, []>("SELECT key, value FROM index_metadata")
          .all()
          .map((r) => [r.key, r.value])
      );
      expect(meta.has("graph_computed_at")).toBe(true);
      expect(meta.has("graph_algo")).toBe(true);
      expect(Number.parseInt(meta.get("graph_node_count") ?? "", 10)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("ui-server's readers run against a core-produced database", () => {
  test("graph meta reports an available, populated graph", () => {
    const meta = getGraphMeta(graph(), { brainPath });
    expect(meta.available).toBe(true);
    expect(meta.nodeCount).toBeGreaterThan(0);
  });

  test("clusters return nodes and edges", () => {
    const clusters = getClusters(graph(), { brainPath, includeIsolates: true });
    expect(clusters.nodes.length).toBeGreaterThan(0);
    expect(clusters.nodes[0].path).toBeString();
    expect(Array.isArray(clusters.edges)).toBe(true);
  });

  test("a neighborhood around a real document resolves", () => {
    const clusters = getClusters(graph(), { brainPath, includeIsolates: true });
    // Pick a node that actually has an edge, so depth-1 is meaningful.
    const linked = clusters.edges[0];
    expect(linked, "the fixture corpus produced no links to walk").toBeDefined();
    const center = clusters.nodes.find((n) => n.id === linked.source)!;
    const hood = getNeighborhood(graph(), { brainPath, center: center.path, depth: 1 });
    expect(hood.nodes.length).toBeGreaterThan(1);
  });

  test("maintenance reads the columns it reports on", () => {
    const maintenance = getMaintenance(graph(), { brainPath });
    // Every arm touches a different part of the schema: links (orphans),
    // graph_root_distances (unreachable), the links target column
    // (brokenLinks) and documents.indexed_at (stale).
    expect(Array.isArray(maintenance.orphans)).toBe(true);
    expect(Array.isArray(maintenance.unreachable)).toBe(true);
    expect(Array.isArray(maintenance.brokenLinks)).toBe(true);
    expect(Array.isArray(maintenance.stale)).toBe(true);
    expect(maintenance.staleDays).toBeGreaterThan(0);
  });

  test("the keyterm builder extracts vocabulary from the same database", () => {
    const cache = buildKeyterms({ brainPath, cacheDir: brainPath, limit: 200 });
    // `degraded` is how the builder reports "schema too old to read" — the
    // silent-empty outcome this whole file exists to catch.
    expect(cache.degraded).toBeUndefined();
    expect(cache.keyterms.length).toBeGreaterThan(0);
  });
});
