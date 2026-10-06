/**
 * G6 — cross-package schema integration test (closes RC4).
 *
 * ui-server's graph and voice readers go through core's supported query entry
 * (`@schlessera/brain/queries`, an optional peer), while core owns the schema
 * and versions it independently. A version constant cannot catch a drift that
 * keeps its number, so this test binds the two sides with the real artifact —
 * it runs core's actual indexer over core's fixture corpus (the "Odysseus"
 * voyage brain) and then points every ui-server reader at the database that
 * run produced, through the peer resolved the way the server resolves it.
 *
 * Every assertion here is on REAL content, never on "did not throw": both
 * readers degrade silently (the graph reader to `unavailable`, the keyterm
 * builder to an empty vocabulary), and silent degradation is exactly what a
 * schema drift produces. An empty result set from a freshly indexed corpus IS
 * the failure this gate exists to catch.
 *
 * Importing `@schlessera/brain` statically from a test is deliberate and safe:
 * ui-server's `src/` only ever resolves it lazily, at runtime, so its
 * published declarations never name it. `openBrainDb` stays exported for
 * embedders' own readers under the direct-SQL guarantees, so its floor is
 * still checked here.
 *
 * The corpus is indexed ONCE (in beforeAll) and shared by every assertion —
 * this is the one enforcement gate with real runtime cost,
 * so it stays a single database, read many times.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { buildTaxonomy, indexAll, openDatabase } from "@schlessera/brain/internal";
import corpusConfig from "../../../core/fixtures/corpus/brain.config.ts";

import { MIN_BRAIN_SCHEMA_VERSION, openBrainDb } from "../../src/db/brain-db";
import { createCoreQueryAccess, type GraphQueries } from "../../src/core-queries";
import {
  getClusters,
  getDiscovery,
  getGraphMeta,
  getMaintenance,
  getNeighborhood,
} from "../../src/graph/reader";
import { buildKeyterms } from "../../src/voice/keyterm-builder";

const FIXTURE_CORPUS = resolve(import.meta.dir, "../../../core/fixtures/corpus");

/** The one sentence every failure below should lead with. */
const DRIFT =
  "core's brain.db schema changed under ui-server (G6). The database was just " +
  "produced by core's own indexer over its fixture corpus, so a degraded or " +
  "empty read here means core's supported query results or ui-server's " +
  "adaptation of them no longer match what core writes — fix the query or the " +
  "adapter, do not loosen this test.";

let brainPath: string;
/** schema_version as core actually wrote it, read raw, no wrapper involved. */
let writtenSchemaVersion: number;
/** The graph operations, resolved from the workspace core like the server does. */
let graph: GraphQueries;

beforeAll(async () => {
  brainPath = mkdtempSync(join(tmpdir(), "brain-ui-schema-gate-"));
  cpSync(FIXTURE_CORPUS, brainPath, { recursive: true });
  // A locally indexed corpus can leave a stray (gitignored) brain.db behind;
  // the copy must start from markdown only so THIS run's indexer writes the db.
  for (const stray of ["brain.db", "brain.db-wal", "brain.db-shm"]) {
    rmSync(join(brainPath, stray), { force: true });
  }
  // The corpus ships no entry file and names no graph.root, so on its own the
  // precompute resolves no default root. One AGENTS.md (index-excluded, like
  // any real brain's) turns that on, exercising the virtual-root discovery
  // path instead of a degenerate empty default view.
  writeFileSync(
    join(brainPath, "AGENTS.md"),
    "# Field notebook - entry\n\nStart with [[identity]], then check [[current-focus]].\n"
  );

  const taxonomy = buildTaxonomy({ user: corpusConfig });
  const db = openDatabase(join(brainPath, "brain.db"));
  try {
    // Keyless and deterministic: no provider, no enrichment, no embeddings.
    // The graph precompute runs by default, so no separate compute step.
    const stats = await indexAll(db, { root: brainPath, taxonomy, quiet: true });
    expect(stats.total, "core's indexer found no markdown in its own fixture corpus").toBeGreaterThan(10);
    expect(stats.graphNodes, "core's indexer no longer precomputes the graph during indexing").toBeGreaterThan(10);
  } finally {
    db.close();
  }

  const raw = new Database(join(brainPath, "brain.db"), { readonly: true });
  try {
    const row = raw
      .query<{ value: string }, []>("SELECT value FROM index_metadata WHERE key = 'schema_version'")
      .get();
    writtenSchemaVersion = Number.parseInt(row?.value ?? "", 10);
  } finally {
    raw.close();
  }
  const capability = createCoreQueryAccess().graph();
  if (!capability.ok) throw new Error(`core query capability unusable: ${capability.reason}`);
  graph = capability.queries;
});

afterAll(() => {
  rmSync(brainPath, { recursive: true, force: true });
});

describe("schema floors are honest against what core writes", () => {
  test("core stamps a parseable schema_version", () => {
    expect(Number.isFinite(writtenSchemaVersion), DRIFT).toBe(true);
  });

  test("ui-server's package-wide floor is not above core's version", () => {
    // The floor may lag core (older repos are allowed) but must never lead it:
    // a floor above what core writes would refuse every freshly indexed brain.
    expect(writtenSchemaVersion, DRIFT).toBeGreaterThanOrEqual(MIN_BRAIN_SCHEMA_VERSION);
  });

  test("the workspace's core resolves as a usable query capability", () => {
    // The graph and vocabulary reads below go through core's supported query
    // entry, resolved the way the server resolves its optional peer.
    const access = createCoreQueryAccess();
    expect(access.graph().ok, DRIFT).toBe(true);
    expect(access.voice().ok, DRIFT).toBe(true);
  });

  test("openBrainDb admits the database and reports core's version", () => {
    const handle = openBrainDb(brainPath);
    try {
      expect(handle.schemaVersion, DRIFT).toBe(writtenSchemaVersion);
    } finally {
      handle.db.close();
    }
  });
});

describe("graph reader returns real content from a core-indexed corpus", () => {
  test("meta: available, populated, rooted", () => {
    const meta = getGraphMeta(graph, { brainPath });
    expect(meta.available, DRIFT).toBe(true);
    expect(meta.schemaVersion).toBe(writtenSchemaVersion);
    expect(meta.computedAt, DRIFT).toBeTruthy();
    expect(meta.stale).toBe(false);
    expect(meta.nodeCount, DRIFT).toBeGreaterThan(10);
    expect(meta.edgeCount, DRIFT).toBeGreaterThan(10);
    expect(meta.communities.length, DRIFT).toBeGreaterThan(0);
    expect(meta.defaultRoot).toEqual({ path: "AGENTS.md", virtual: true });
  });

  test("clusters: linked notes with computed metrics, isolates filtered", () => {
    const clusters = getClusters(graph, { brainPath });
    const paths = clusters.nodes.map((n) => n.path);
    expect(paths, DRIFT).toContain("projects/active/raft/plan.md");
    expect(paths, DRIFT).toContain("studies/star-bearings.md");
    // loose-idea.md is the corpus's deliberate orphan fixture; the default
    // clusters view excludes isolates, so its absence proves the degree
    // columns are really being read, not COALESCEd to zero across the board.
    expect(paths).not.toContain("notes/loose-idea.md");
    expect(getClusters(graph, { brainPath, includeIsolates: true }).nodes.map((n) => n.path)).toContain(
      "notes/loose-idea.md"
    );
    // Precomputed analytics made it through the join.
    const plan = clusters.nodes.find((n) => n.path === "projects/active/raft/plan.md");
    expect(plan?.pagerank, DRIFT).toBeGreaterThan(0);
    expect(plan?.community, DRIFT).toBeDefined();
    expect((plan?.inDegree ?? 0) + (plan?.outDegree ?? 0), DRIFT).toBeGreaterThan(0);
    expect(clusters.edges.length, DRIFT).toBeGreaterThan(10);
  });

  test("neighborhood: ego graph around star-bearings", () => {
    const hood = getNeighborhood(graph, { brainPath, center: "studies/star-bearings.md", depth: 1 });
    const byPath = new Map(hood.nodes.map((n) => [n.path, n]));
    expect(byPath.get("studies/star-bearings.md")?.distance, DRIFT).toBe(0);
    // Out-link ([[star-catalog]]) and in-link (plan.md links back) both land.
    expect(byPath.get("studies/navigation/star-catalog.md")?.distance, DRIFT).toBe(1);
    expect(byPath.get("projects/active/raft/plan.md")?.distance, DRIFT).toBe(1);
    expect(hood.edges.length, DRIFT).toBeGreaterThan(0);
  });

  test("discovery from the precomputed virtual root", () => {
    const view = getDiscovery(graph, { brainPath });
    const byPath = new Map(view.nodes.map((n) => [n.path, n]));
    const root = byPath.get("AGENTS.md");
    expect(root, DRIFT).toBeDefined();
    expect(root?.virtual).toBe(true);
    expect(root?.id).toBe(0);
    expect(root?.distance).toBe(0);
    expect(root?.outDegree).toBe(2); // [[identity]] and [[current-focus]]
    expect(byPath.get("me/identity.md")?.distance, DRIFT).toBe(1);
    expect(byPath.get("context/current-focus.md")?.distance, DRIFT).toBe(1);
    // current-focus links onward into the raft project.
    expect(byPath.get("projects/active/raft/plan.md")?.distance, DRIFT).toBe(2);
    expect(view.reachableCount, DRIFT).toBeGreaterThan(5);
    expect(view.unreachableCount, DRIFT).toBeGreaterThan(0);
  });

  test("discovery from an explicit root", () => {
    const view = getDiscovery(graph, { brainPath, root: "projects/active/raft/plan.md", direction: "both" });
    const paths = view.nodes.map((n) => n.path);
    expect(paths, DRIFT).toContain("projects/active/raft/plan.md");
    expect(paths, DRIFT).toContain("studies/star-bearings.md");
    expect(view.reachableCount, DRIFT).toBeGreaterThan(5);
  });

  test("maintenance: orphans, broken links and unreachable notes are found", () => {
    const findings = getMaintenance(graph, { brainPath });
    expect(findings.orphans.map((n) => n.path), DRIFT).toContain("notes/loose-idea.md");
    // quick-note-eagle.md and current-focus.md both point at [[does-not-exist]].
    expect(findings.brokenLinks.map((l) => l.target), DRIFT).toContain("does-not-exist");
    // Nothing links INTO the owl note, so the root walk cannot reach it.
    expect(findings.unreachable.map((n) => n.path), DRIFT).toContain("notes/quick-note-eagle.md");
  });
});

describe("keyterm builder returns a real vocabulary from a core-indexed corpus", () => {
  test("extracts non-degraded, content-bearing keyterms", () => {
    const cache = buildKeyterms({
      brainPath,
      cacheDir: join(brainPath, ".brain-ui"),
      limit: 500,
    });
    // `degraded` is the silent schema-drift escape hatch — the exact failure
    // mode this gate exists to catch. It must never fire on a fresh index.
    expect(cache.degraded, DRIFT).toBeUndefined();
    expect(cache.count, DRIFT).toBe(cache.keyterms.length);
    expect(cache.keyterms.length, DRIFT).toBeGreaterThanOrEqual(5);
    // Derived from documents.path under projects/active/ — present in this
    // corpus regardless of scoring changes elsewhere in the extractor.
    expect(cache.keyterms, DRIFT).toContain("Raft");
    expect(cache.keyterms, DRIFT).toContain("Sail Repairs");
  });
});
