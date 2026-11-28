import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { getMeta, openDatabase, SCHEMA_VERSION, setMeta } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { runGraphPrecompute, runGraphPrecomputeIfChanged } from "../src/lib/graph/precompute";
import { LAYOUT_ITERATIONS_COLD, LAYOUT_ITERATIONS_WARM, LAYOUT_NODE_CAP } from "../src/lib/graph/layout";
import { LOUVAIN_SEED, PAGERANK_DAMPING } from "../src/lib/graph/metrics";
import { graphRootKey, resolveGraphRoot } from "../src/lib/graph/root";
import { readGraphMeta } from "../src/queries";
import {
  getClusterGraph,
  getDiscoveryGraph,
  getEgoGraph,
  getGraphStats,
  getMaintenanceFindings,
} from "../src/lib/graph/queries";

// The derived graph is a cache over documents + links, so every test here
// builds a real corpus in a tmpdir and runs the real indexer over it. Nothing
// touches the network; the graph pass needs no provider at all.

const taxonomy = buildTaxonomy({ user: null });

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
}

const RECENT = daysAgo(1);
const LONG_AGO = daysAgo(400);

function md(title: string, body: string, updated = RECENT): string {
  return [
    "---",
    "type: note",
    `title: ${title}`,
    'created: "2026-01-01"',
    `updated: "${updated}"`,
    "tags: [test]",
    "---",
    "",
    "## Section",
    "",
    body,
    "",
  ].join("\n");
}

function makeCorpus(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-graph-test-"));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/**
 * Two link components (alpha/beta/gamma and delta/epsilon), one note nothing
 * touches, one note whose only link is unresolvable, one note last updated
 * beyond any staleness horizon, and an AGENTS.md entry file that is excluded
 * from indexing and therefore becomes a virtual root pointing at alpha.
 */
const CORPUS: Record<string, string> = {
  "AGENTS.md": "# Entry\n\nStart at [[alpha]].\n",
  "notes/alpha.md": md("Alpha", "Links to [[beta]] and [[gamma]]."),
  "notes/beta.md": md("Beta", "Links to [[gamma]]."),
  "notes/gamma.md": md("Gamma", "Links back to [[alpha]]."),
  "notes/delta.md": md("Delta", "Links to [[epsilon]]."),
  "notes/epsilon.md": md("Epsilon", "Links to [[delta]]."),
  "notes/lonely.md": md("Lonely", "No links at all."),
  "notes/dangling.md": md("Dangling", "Points at [[nowhere-at-all]]."),
  "notes/ancient.md": md("Ancient", "Also unlinked.", LONG_AGO),
};

async function indexCorpus(
  files: Record<string, string> = CORPUS,
  options: { graph?: boolean } = {}
): Promise<{ root: string; db: Database }> {
  const root = makeCorpus(files);
  const db = openDatabase(join(root, ".brain-index", "brain.db"));
  await indexAll(db, { root, taxonomy, quiet: true, ...options });
  return { root, db };
}

function idFor(db: Database, path: string): number {
  return (db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number }).id;
}

describe("schema v8 migration", () => {
  test("a fresh database lands on the current schema with every graph table present", () => {
    const root = makeCorpus({});
    const db = openDatabase(join(root, ".brain-index", "brain.db"));

    const version = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'graph_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables.sort()).toEqual([
      "graph_communities",
      "graph_layouts",
      "graph_metrics",
      "graph_root_distances",
    ]);
    db.close();
  });

  test("re-opening does not re-run the v8 block over existing rows", () => {
    const root = makeCorpus({});
    const dbPath = join(root, ".brain-index", "brain.db");

    const first = openDatabase(dbPath);
    first.run("INSERT INTO documents (path, title, type, created, updated, content, indexed_at) VALUES ('a.md','A','note','2026-01-01','2026-01-01','x','2026-01-01')");
    const docId = idFor(first, "a.md");
    first.run("INSERT INTO graph_metrics (document_id, component) VALUES (?, 0)", [docId]);
    first.close();

    const second = openDatabase(dbPath);
    const rows = second.prepare("SELECT COUNT(*) AS n FROM graph_metrics").get() as { n: number };
    expect(rows.n).toBe(1);
    second.close();
  });

  test("a v7 database migrates up without touching its data", () => {
    const root = makeCorpus({});
    const dbPath = join(root, ".brain-index", "brain.db");

    const seed = openDatabase(dbPath);
    seed.run("INSERT INTO documents (path, title, type, created, updated, content, indexed_at) VALUES ('a.md','A','note','2026-01-01','2026-01-01','x','2026-01-01')");
    seed.run("DROP TABLE graph_metrics");
    seed.run("DROP TABLE graph_communities");
    seed.run("DROP TABLE graph_root_distances");
    seed.run("DROP TABLE graph_layouts");
    seed.run("UPDATE index_metadata SET value = '7' WHERE key = 'schema_version'");
    seed.close();

    const migrated = openDatabase(dbPath);
    const version = migrated
      .prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
    expect(
      (migrated.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n
    ).toBe(1);
    expect(
      (migrated.prepare("SELECT COUNT(*) AS n FROM graph_metrics").get() as { n: number }).n
    ).toBe(0);
    migrated.close();
  });
});

describe("precompute", () => {
  test("unchanged indexing preserves layout and provenance; root and corpus changes invalidate it", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    const options = { root, taxonomy, quiet: true };
    const inputHash = () => db.prepare("SELECT value FROM index_metadata WHERE key = 'graph_input_hash'").get();
    try {
      await indexAll(db, options);
      const hash = inputHash();
      const layout = db.prepare("SELECT * FROM graph_layouts ORDER BY document_id").all();
      const provenance = getGraphStats(db).computedAt;
      const again = await indexAll(db, options);
      expect(again.unchanged).toBe(8);
      expect(again.graphNodes).toBe(0);
      expect(db.prepare("SELECT * FROM graph_layouts ORDER BY document_id").all()).toEqual(layout);
      expect(getGraphStats(db).computedAt).toBe(provenance);

      writeFileSync(join(root, "AGENTS.md"), "Start at [[delta]].\n");
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      expect(inputHash()).not.toEqual(hash);
      expect(getGraphStats(db).reachable).toBe(2);

      const beforeEdit = inputHash();
      writeFileSync(join(root, "notes/alpha.md"), md("Updated navigation title", "[[delta]]").replace("tags: [test]", "tags: [navigation]"));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      expect(inputHash()).not.toEqual(beforeEdit);
      expect((await indexAll(db, options)).graphNodes).toBe(0);

      unlinkSync(join(root, "notes/alpha.md"));
      expect((await indexAll(db, options)).graphNodes).toBe(7);
      db.run("DELETE FROM graph_layouts");
      expect((await indexAll(db, options)).graphNodes).toBe(7);
      expect((await indexAll(db, { ...options, force: true })).graphNodes).toBe(7);
      // Old versions have no fingerprint; explicitly removed provenance also
      // requires a rebuild rather than blessing unknown graph tables.
      db.run("DELETE FROM index_metadata WHERE key = 'graph_input_hash'");
      expect((await indexAll(db, options)).graphNodes).toBe(7);
    } finally {
      db.close();
    }
  });

  test("root configuration, anchor policy, and repaired link rows invalidate cached graphs", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    try {
      await indexAll(db, { root, taxonomy, quiet: true });
      const configured = buildTaxonomy({ user: { graph: { root: "notes/delta.md" } } });
      expect((await indexAll(db, { root, taxonomy: configured, quiet: true })).graphNodes).toBe(8);
      expect(getGraphStats(db).root).toBe("notes/delta.md");
      // An explicit compute overrides the index default. The next index must
      // restore that default even though no document was edited.
      runGraphPrecompute(db, { root, taxonomy, rootOverride: "notes/alpha.md" });
      expect((await indexAll(db, { root, taxonomy, quiet: true })).graphNodes).toBe(8);
      const anchors = buildTaxonomy({ user: { taxonomy: { dirAnchors: ["status.md"] } } });
      expect((await indexAll(db, { root, taxonomy: anchors, quiet: true })).graphNodes).toBe(8);
      // A stale writer/resolver can leave different resolved links behind.
      db.run("UPDATE links SET target_id = NULL");
      runGraphPrecompute(db, { root, taxonomy: anchors });
      expect((await indexAll(db, { root, taxonomy: anchors, quiet: true })).graphNodes).toBe(8);
    } finally {
      db.close();
    }
  });

  test("a body-only edit reuses the graph tables and keeps their provenance current", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    const options = { root, taxonomy, quiet: true };
    try {
      await indexAll(db, options);
      const layout = db.prepare("SELECT * FROM graph_layouts ORDER BY document_id").all();
      writeFileSync(join(root, "notes/beta.md"), md("Beta", "Links to [[gamma]].\n\nOne more line of body."));
      const stats = await indexAll(db, options);
      expect(stats.updated).toBe(1);
      expect(stats.graphNodes).toBe(0);
      expect(db.prepare("SELECT * FROM graph_layouts ORDER BY document_id").all()).toEqual(layout);
      const meta = readGraphMeta({ brainPath: root });
      expect(meta.ok).toBe(true);
      expect(meta.ok && meta.value.stale).toBe(false);
      const computedAt = getMeta(db, "graph_computed_at")!;
      const { newest } = db.prepare("SELECT MAX(indexed_at) AS newest FROM documents").get() as { newest: string };
      expect(Date.parse(computedAt)).toBeGreaterThanOrEqual(Date.parse(newest));
    } finally {
      db.close();
    }
  });

  test("a title another connection commits after the fingerprint is read rebuilds the tables instead of stamping them current (#4873)", async () => {
    const root = makeCorpus(CORPUS);
    const path = join(root, ".brain-index", "brain.db");
    const db = openDatabase(path);
    const other = openDatabase(path);
    const options = { root, taxonomy, quiet: true };
    const prepare = db.prepare;
    try {
      await indexAll(db, options);
      writeFileSync(join(root, "notes/beta.md"), md("Beta", "Links to [[gamma]].\n\nOne more line of body."));
      // The reuse decision reads the stored fingerprint right after hashing
      // the inputs. The rename lands exactly there, from another connection,
      // the way a concurrent index run would commit it.
      let renamed = false;
      db.prepare = ((...args: Parameters<typeof prepare>) => {
        const statement = prepare.apply(db, args);
        if (args[0] !== "SELECT value FROM index_metadata WHERE key = ?") return statement;
        const get = statement.get.bind(statement);
        statement.get = ((...params: Parameters<typeof get>) => {
          const row = get(...params);
          if (!renamed && params[0] === "graph_input_hash") {
            renamed = true;
            other.prepare("UPDATE documents SET title = ?, indexed_at = ? WHERE path = ?")
              .run("Lonely renamed", new Date().toISOString(), "notes/lonely.md");
          }
          return row;
        }) as typeof statement.get;
        return statement;
      }) as typeof prepare;
      const stats = await indexAll(db, options);
      db.prepare = prepare;
      expect(renamed).toBe(true);
      expect(stats.graphNodes).toBe(8);
      const meta = readGraphMeta({ brainPath: root });
      expect(meta.ok && meta.value.stale).toBe(false);
      // The rebuild recorded the fingerprint of the inputs it read.
      expect(runGraphPrecomputeIfChanged(db, { root, taxonomy })).toBeNull();
    } finally {
      db.prepare = prepare;
      other.close();
      db.close();
    }
  });

  test("a title, a tag or a link edit alone still rebuilds the graph tables", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    const options = { root, taxonomy, quiet: true };
    try {
      await indexAll(db, options);
      writeFileSync(join(root, "notes/lonely.md"), md("Lonely renamed", "No links at all."));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      writeFileSync(join(root, "notes/lonely.md"), md("Lonely renamed", "No links at all.").replace("tags: [test]", "tags: [solitude]"));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      writeFileSync(join(root, "notes/lonely.md"), md("Lonely renamed", "Now links to [[alpha]].").replace("tags: [test]", "tags: [solitude]"));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      expect((await indexAll(db, options)).graphNodes).toBe(0);
    } finally {
      db.close();
    }
  });

  test("an index fingerprinted before the narrowed inputs rebuilds its graph once", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    const options = { root, taxonomy, quiet: true };
    // The fingerprint as earlier releases computed it: revision 1, and every
    // markdown row's type, status, updated, content_hash and indexed_at.
    const fingerprint = (revision: number, columns: string): string => {
      const rootKey = getMeta(db, "graph_root");
      const resolved = resolveGraphRoot(db, { root, taxonomy });
      expect(resolved ? graphRootKey(resolved) : null).toBe(rootKey);
      const hash = createHash("sha256");
      hash.update(JSON.stringify({
        revision, root: resolved, anchors: taxonomy.dirAnchors,
        damping: PAGERANK_DAMPING, seed: LOUVAIN_SEED,
        direction: "out", cold: LAYOUT_ITERATIONS_COLD,
        warm: LAYOUT_ITERATIONS_WARM, cap: LAYOUT_NODE_CAP,
      }));
      for (const sql of [
        `SELECT ${columns} FROM documents WHERE asset_type = 'markdown' ORDER BY id`,
        "SELECT source_id, target, target_id FROM links ORDER BY source_id, target",
        "SELECT dt.document_id, t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id ORDER BY dt.document_id, t.name",
      ]) {
        for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row) + "\n");
      }
      return hash.digest("hex");
    };
    try {
      await indexAll(db, options);
      expect((await indexAll(db, options)).graphNodes).toBe(0);
      setMeta(db, "graph_input_hash", fingerprint(1, "id, path, title, type, status, updated, content_hash, indexed_at"));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      // The same narrowed inputs under the old revision are not reused either.
      setMeta(db, "graph_input_hash", fingerprint(1, "id, path, title"));
      expect((await indexAll(db, options)).graphNodes).toBe(8);
      expect(getMeta(db, "graph_input_hash")).toBe(fingerprint(2, "id, path, title"));
    } finally {
      db.close();
    }
  });

  test("indexAll rebuilds the graph tables", async () => {
    const { db } = await indexCorpus();

    const metrics = db
      .prepare("SELECT COUNT(*) AS n FROM graph_metrics")
      .get() as { n: number };
    expect(metrics.n).toBe(8); // every markdown note; AGENTS.md is excluded

    const alpha = db
      .prepare(
        `SELECT in_degree AS inDegree, out_degree AS outDegree
         FROM graph_metrics WHERE document_id = ?`
      )
      .get(idFor(db, "notes/alpha.md")) as { inDegree: number; outDegree: number };
    expect(alpha.outDegree).toBe(2); // beta, gamma
    expect(alpha.inDegree).toBe(1); // gamma

    const computedAt = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_computed_at'")
      .get() as { value: string };
    expect(computedAt.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const layouts = db
      .prepare("SELECT COUNT(*) AS n FROM graph_layouts WHERE mode = 'clusters'")
      .get() as { n: number };
    expect(layouts.n).toBe(8);

    db.close();
  });

  test("indexAll({ graph: false }) leaves the tables empty", async () => {
    const { db } = await indexCorpus(CORPUS, { graph: false });

    for (const table of ["graph_metrics", "graph_communities", "graph_root_distances", "graph_layouts"]) {
      const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(rows.n).toBe(0);
    }
    expect(
      db.prepare("SELECT value FROM index_metadata WHERE key = 'graph_computed_at'").get()
    ).toBeNull();

    db.close();
  });

  test("index stats report the graph pass", async () => {
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    const stats = await indexAll(db, { root, taxonomy, quiet: true });
    expect(stats.graphNodes).toBe(8);
    expect(stats.graphMs).toBeGreaterThanOrEqual(0);

    const off = await indexAll(db, { root, taxonomy, quiet: true, graph: false });
    expect(off.graphNodes).toBe(0);
    expect(off.graphMs).toBe(0);
    db.close();
  });

  test("the same corpus produces the same communities, components and ranks", async () => {
    const first = await indexCorpus();
    const second = await indexCorpus();

    const read = (db: Database) =>
      db
        .prepare(
          `SELECT d.path AS path, m.component AS component, m.community AS community,
                  m.pagerank AS pagerank, l.x AS x, l.y AS y
           FROM graph_metrics m
           JOIN documents d ON d.id = m.document_id
           LEFT JOIN graph_layouts l ON l.document_id = m.document_id AND l.mode = 'clusters'
           ORDER BY d.path`
        )
        .all();

    expect(read(second.db)).toEqual(read(first.db));

    first.db.close();
    second.db.close();
  });

  test("a second precompute over unchanged data is a no-op for the partition", async () => {
    const { root, db } = await indexCorpus();
    const before = db
      .prepare("SELECT document_id, community, component FROM graph_metrics ORDER BY document_id")
      .all();

    runGraphPrecompute(db, { root, taxonomy });

    const after = db
      .prepare("SELECT document_id, community, component FROM graph_metrics ORDER BY document_id")
      .all();
    expect(after).toEqual(before);
    db.close();
  });
});

describe("root resolution", () => {
  test("an excluded entry file becomes a virtual root seeding its targets at distance 1", async () => {
    const { db } = await indexCorpus();

    const root = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'")
      .get() as { value: string };
    expect(root.value).toBe("virtual:AGENTS.md");

    // No fake documents row for the entry file.
    expect(db.prepare("SELECT id FROM documents WHERE path = 'AGENTS.md'").get()).toBeNull();

    const alphaId = idFor(db, "notes/alpha.md");
    const seeds = JSON.parse(
      (
        db
          .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root_links'")
          .get() as { value: string }
      ).value
    );
    expect(seeds).toEqual([alphaId]);

    const distances = new Map(
      (
        db
          .prepare(
            `SELECT d.path AS path, r.distance AS distance, r.parent_id AS parentId
             FROM graph_root_distances r JOIN documents d ON d.id = r.document_id`
          )
          .all() as { path: string; distance: number; parentId: number | null }[]
      ).map((row) => [row.path, row])
    );

    expect(distances.get("notes/alpha.md")).toEqual({
      path: "notes/alpha.md",
      distance: 1,
      parentId: null,
    });
    expect(distances.get("notes/beta.md")?.distance).toBe(2);
    expect(distances.get("notes/gamma.md")?.distance).toBe(2);
    expect(distances.get("notes/beta.md")?.parentId).toBe(alphaId);
    // The second component is not reachable by following links forward.
    expect(distances.has("notes/delta.md")).toBe(false);
    expect(distances.has("notes/lonely.md")).toBe(false);

    db.close();
  });

  test("an indexed note as root sits at distance 0 on its own row", async () => {
    const { root, db } = await indexCorpus();
    runGraphPrecompute(db, { root, taxonomy, rootOverride: "notes/delta.md" });

    const rootKey = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'")
      .get() as { value: string };
    expect(rootKey.value).toBe("notes/delta.md");

    const rows = db
      .prepare(
        `SELECT d.path AS path, r.distance AS distance
         FROM graph_root_distances r JOIN documents d ON d.id = r.document_id
         ORDER BY r.distance, d.path`
      )
      .all() as { path: string; distance: number }[];
    expect(rows).toEqual([
      { path: "notes/delta.md", distance: 0 },
      { path: "notes/epsilon.md", distance: 1 },
    ]);

    // A previous run's virtual-root seed list must not survive.
    const seeds = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root_links'")
      .get() as { value: string };
    expect(JSON.parse(seeds.value)).toEqual([]);

    db.close();
  });

  test("an entry file whose links resolve to nothing is not adopted as root", async () => {
    // Every [[link]] here sits in a code span, so extractWikiLinks finds none —
    // the shape the real CLAUDE.md in a coding-agent repo tends to have.
    const { root, db } = await indexCorpus({
      ...CORPUS,
      "AGENTS.md": "# Entry\n\nWrite links as `[[alpha]]`.\n",
    });

    expect(
      db.prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'").get()
    ).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM graph_root_distances").get() as { n: number }).n
    ).toBe(0);
    // Without a root, "unreachable" would otherwise be the entire corpus.
    expect(getMaintenanceFindings(db).unreachable).toEqual([]);

    // Named explicitly, the same file is honoured — the user said so.
    runGraphPrecompute(db, { root, taxonomy, rootOverride: "AGENTS.md" });
    const named = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'")
      .get() as { value: string };
    expect(named.value).toBe("virtual:AGENTS.md");

    db.close();
  });

  test("no entry file and no configured root leaves the distances empty", async () => {
    const withoutEntry = { ...CORPUS };
    delete withoutEntry["AGENTS.md"];
    const { db } = await indexCorpus(withoutEntry);

    expect(
      db.prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'").get()
    ).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM graph_root_distances").get() as { n: number }).n
    ).toBe(0);

    db.close();
  });

  test("graph.root from brain.config wins over the default entry files", async () => {
    const configured = buildTaxonomy({ user: { graph: { root: "notes/delta.md" } } });
    const root = makeCorpus(CORPUS);
    const db = openDatabase(join(root, ".brain-index", "brain.db"));
    await indexAll(db, { root, taxonomy: configured, quiet: true });

    const rootKey = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'graph_root'")
      .get() as { value: string };
    expect(rootKey.value).toBe("notes/delta.md");

    db.close();
  });
});

describe("queries", () => {
  test("maintenance reports orphans, broken links, unreachable and stale notes", async () => {
    const { db } = await indexCorpus();
    const findings = getMaintenanceFindings(db);

    expect(findings.orphans.map((n) => n.path).sort()).toEqual([
      "notes/ancient.md",
      "notes/dangling.md",
      "notes/lonely.md",
    ]);

    expect(findings.brokenLinks).toEqual([
      { sourcePath: "notes/dangling.md", target: "nowhere-at-all" },
    ]);

    expect(findings.root).toBe("virtual:AGENTS.md");
    expect(findings.unreachable.map((n) => n.path).sort()).toEqual([
      "notes/ancient.md",
      "notes/dangling.md",
      "notes/delta.md",
      "notes/epsilon.md",
      "notes/lonely.md",
    ]);

    expect(findings.staleDays).toBe(180);
    expect(findings.stale.map((n) => n.path)).toEqual(["notes/ancient.md"]);

    // A horizon nothing has crossed yet.
    expect(getMaintenanceFindings(db, { staleDays: 100_000 }).stale).toEqual([]);

    db.close();
  });

  test("the local neighbourhood is bounded by depth and direction", async () => {
    const { db } = await indexCorpus();

    const depth1 = getEgoGraph(db, { center: "notes/alpha.md", depth: 1, direction: "out" });
    expect(depth1.nodes.map((n) => n.path).sort()).toEqual([
      "notes/alpha.md",
      "notes/beta.md",
      "notes/gamma.md",
    ]);

    const inbound = getEgoGraph(db, { center: "notes/alpha.md", depth: 1, direction: "in" });
    expect(inbound.nodes.map((n) => n.path).sort()).toEqual([
      "notes/alpha.md",
      "notes/gamma.md",
    ]);

    // Every edge in the result has both endpoints in it.
    expect(depth1.edges).toHaveLength(4);
    const ids = new Set(depth1.nodes.map((n) => n.id));
    expect(depth1.edges.filter((edge) => !ids.has(edge.source) || !ids.has(edge.target))).toEqual([]);

    expect(getEgoGraph(db, { center: "does/not/exist.md" }).nodes).toEqual([]);

    db.close();
  });

  test("discovery replays the precomputed root and synthesizes the virtual node", async () => {
    const { db } = await indexCorpus();
    const discovery = getDiscoveryGraph(db);

    const virtual = discovery.nodes.find((n) => n.virtual);
    expect(virtual).toMatchObject({ id: 0, path: "AGENTS.md", distance: 0 });

    const alphaId = idFor(db, "notes/alpha.md");
    expect(discovery.edges).toContainEqual({ source: 0, target: alphaId });
    expect(discovery.nodes.find((n) => n.path === "notes/alpha.md")?.distance).toBe(1);

    // An explicit root is a plain per-request BFS with no virtual node.
    const fromDelta = getDiscoveryGraph(db, { root: "notes/delta.md" });
    expect(fromDelta.nodes.filter((n) => n.virtual)).toEqual([]);
    expect(fromDelta.nodes.map((n) => n.path).sort()).toEqual([
      "notes/delta.md",
      "notes/epsilon.md",
    ]);

    db.close();
  });

  test("clusters carry communities and layout, and can drop isolates", async () => {
    const { db } = await indexCorpus();

    const all = getClusterGraph(db);
    expect(all.nodes).toHaveLength(8);
    for (const node of all.nodes) {
      expect(node.community).toBeGreaterThanOrEqual(0);
      expect(typeof node.x).toBe("number");
      expect(typeof node.y).toBe("number");
    }

    const linked = getClusterGraph(db, { includeIsolates: false });
    expect(linked.nodes.map((n) => n.path).sort()).toEqual([
      "notes/alpha.md",
      "notes/beta.md",
      "notes/delta.md",
      "notes/epsilon.md",
      "notes/gamma.md",
    ]);

    const alphaCommunity = all.nodes.find((n) => n.path === "notes/alpha.md")!.community!;
    const single = getClusterGraph(db, { community: alphaCommunity });
    expect(single.nodes.map((n) => n.path).sort()).toEqual(
      all.nodes.filter((n) => n.community === alphaCommunity).map((n) => n.path).sort()
    );
    expect(single.nodes.map((n) => n.path)).toContain("notes/alpha.md");
    expect(single.nodes.filter((n) => n.community !== alphaCommunity)).toEqual([]);

    db.close();
  });

  test("stats summarize the computed graph", async () => {
    const { db } = await indexCorpus();
    const stats = getGraphStats(db);

    expect(stats.nodes).toBe(8);
    expect(stats.edges).toBe(6);
    expect(stats.brokenLinks).toBe(1);
    expect(stats.root).toBe("virtual:AGENTS.md");
    expect(stats.reachable).toBe(3);
    expect(stats.layoutSkipped).toBe(false);
    expect(stats.communities.length).toBeGreaterThan(0);
    expect(stats.algo).toMatchObject({ rootDirection: "out" });

    db.close();
  });

  test("the read side survives a pre-v8 database that has no graph tables", async () => {
    // A read-only connection never migrates, so ui-server and `brain graph
    // export` can both meet a database where these tables simply do not exist.
    const { root, db } = await indexCorpus(CORPUS, { graph: false });
    for (const table of ["graph_metrics", "graph_communities", "graph_root_distances", "graph_layouts"]) {
      db.run(`DROP TABLE ${table}`);
    }
    db.close();

    const readonly = new Database(join(root, ".brain-index", "brain.db"), { readonly: true });
    expect(getEgoGraph(readonly, { center: "notes/alpha.md" }).nodes.length).toBeGreaterThan(0);
    expect(getClusterGraph(readonly).nodes).toHaveLength(8);
    expect(getDiscoveryGraph(readonly).nodes).toEqual([]);
    expect(getMaintenanceFindings(readonly).orphans).toHaveLength(3);
    expect(getGraphStats(readonly).nodes).toBe(0);
    readonly.close();
  });

  test("the read side degrades to links-only when nothing has been precomputed", async () => {
    const { db } = await indexCorpus(CORPUS, { graph: false });

    const ego = getEgoGraph(db, { center: "notes/alpha.md", depth: 1, direction: "out" });
    expect(ego.nodes).toHaveLength(3);
    expect(ego.nodes.find((n) => n.path === "notes/alpha.md")?.outDegree).toBe(2);

    const findings = getMaintenanceFindings(db);
    expect(findings.root).toBeNull();
    expect(findings.unreachable).toEqual([]);
    expect(findings.orphans).toHaveLength(3);

    expect(getGraphStats(db).computedAt).toBeNull();

    db.close();
  });
});
