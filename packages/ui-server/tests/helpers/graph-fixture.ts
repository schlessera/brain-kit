/**
 * Builds brain.db fixtures with raw SQL.
 *
 * ui-server reads brain.db as a documented contract and has no dependency on
 * core, so the fixtures spell the schema out instead of importing a migration —
 * if core ever drifts from the contract, these tests are meant to notice.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

export interface FixtureDoc {
  id: number;
  path: string;
  title: string;
  type?: string;
  updated?: string;
  indexedAt?: string;
  assetType?: string;
}

export interface FixtureLink {
  sourceId: number;
  target: string;
  targetId?: number | null;
}

export interface FixtureMetric {
  documentId: number;
  inDegree: number;
  outDegree: number;
  component?: number;
  pagerank?: number;
  community?: number | null;
}

export interface FixtureCommunity {
  community: number;
  size: number;
  label?: string | null;
  topTerms?: string[];
}

export interface FixtureRootDistance {
  documentId: number;
  distance: number;
  parentId?: number | null;
}

export interface FixtureLayout {
  documentId: number;
  x: number;
  y: number;
  mode?: string;
}

export interface FixtureOptions {
  schemaVersion?: number;
  docs: FixtureDoc[];
  links?: FixtureLink[];
  metrics?: FixtureMetric[];
  communities?: FixtureCommunity[];
  rootDistances?: FixtureRootDistance[];
  layouts?: FixtureLayout[];
  /** Extra index_metadata rows: graph_computed_at, graph_root, … */
  metadata?: Record<string, string>;
  /** Defaults to schemaVersion >= 8. Set false for a "claims v8, has no tables" db. */
  graphTables?: boolean;
}

const DEFAULT_INDEXED_AT = "2026-08-01T00:00:00.000Z";

export function createBrainFixture(brainPath: string, opts: FixtureOptions): string {
  rmSync(brainPath, { recursive: true, force: true });
  mkdirSync(brainPath, { recursive: true });

  const schemaVersion = opts.schemaVersion ?? 8;
  const graphTables = opts.graphTables ?? schemaVersion >= 8;
  const db = new Database(join(brainPath, "brain.db"), { create: true });

  db.run(`CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    relevance TEXT DEFAULT 'primary',
    summary TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    content TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    content_hash TEXT,
    asset_type TEXT DEFAULT 'markdown',
    file_mtime TEXT,
    deadline TEXT,
    next_review TEXT,
    accepted_mtime TEXT,
    stat_fingerprint TEXT
  )`);
  db.run(`CREATE TABLE links (
    source_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target TEXT NOT NULL,
    target_id INTEGER,
    PRIMARY KEY (source_id, target)
  )`);
  db.run("CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)");
  db.run(`CREATE TABLE document_tags (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  )`);
  db.run("CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  if (graphTables) {
    db.run(`CREATE TABLE graph_metrics (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      in_degree INTEGER NOT NULL DEFAULT 0,
      out_degree INTEGER NOT NULL DEFAULT 0,
      component INTEGER NOT NULL,
      pagerank REAL NOT NULL DEFAULT 0,
      community INTEGER
    )`);
    db.run(`CREATE TABLE graph_communities (
      community INTEGER PRIMARY KEY,
      size INTEGER NOT NULL,
      label TEXT,
      top_terms TEXT
    )`);
    db.run(`CREATE TABLE graph_root_distances (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      distance INTEGER NOT NULL,
      parent_id INTEGER
    )`);
    db.run(`CREATE TABLE graph_layouts (
      mode TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      PRIMARY KEY (mode, document_id)
    )`);
  }

  const insertDoc = db.prepare(
    `INSERT INTO documents (id, path, title, type, created, updated, content, indexed_at, asset_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertLink = db.prepare("INSERT INTO links (source_id, target, target_id) VALUES (?, ?, ?)");
  const insertMeta = db.prepare("INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)");

  db.transaction(() => {
    // Freshly-updated by default, so the staleness cutoff never catches a doc
    // just because the suite is being run some months from now.
    const today = new Date().toISOString().slice(0, 10);
    for (const doc of opts.docs) {
      const updated = doc.updated ?? today;
      insertDoc.run(
        doc.id,
        doc.path,
        doc.title,
        doc.type ?? "note",
        updated,
        updated,
        `# ${doc.title}`,
        doc.indexedAt ?? DEFAULT_INDEXED_AT,
        doc.assetType ?? "markdown"
      );
    }
    for (const link of opts.links ?? []) {
      insertLink.run(link.sourceId, link.target, link.targetId ?? null);
    }
    insertMeta.run("schema_version", String(schemaVersion));
    for (const [key, value] of Object.entries(opts.metadata ?? {})) insertMeta.run(key, value);

    if (graphTables) {
      const insertMetric = db.prepare(
        "INSERT INTO graph_metrics (document_id, in_degree, out_degree, component, pagerank, community) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const m of opts.metrics ?? []) {
        insertMetric.run(m.documentId, m.inDegree, m.outDegree, m.component ?? 0, m.pagerank ?? 0, m.community ?? null);
      }
      const insertCommunity = db.prepare(
        "INSERT INTO graph_communities (community, size, label, top_terms) VALUES (?, ?, ?, ?)"
      );
      for (const c of opts.communities ?? []) {
        insertCommunity.run(c.community, c.size, c.label ?? null, JSON.stringify(c.topTerms ?? []));
      }
      const insertDistance = db.prepare(
        "INSERT INTO graph_root_distances (document_id, distance, parent_id) VALUES (?, ?, ?)"
      );
      for (const d of opts.rootDistances ?? []) {
        insertDistance.run(d.documentId, d.distance, d.parentId ?? null);
      }
      const insertLayout = db.prepare("INSERT INTO graph_layouts (mode, document_id, x, y) VALUES (?, ?, ?, ?)");
      for (const l of opts.layouts ?? []) insertLayout.run(l.mode ?? "clusters", l.documentId, l.x, l.y);
    }
  })();

  db.close();
  return brainPath;
}

export function removeBrainFixture(brainPath: string): void {
  rmSync(brainPath, { recursive: true, force: true });
}

/**
 * A four-note corpus: a cycle of three linked notes (index → alpha → beta →
 * index), one orphan, one non-markdown asset that must never become a node,
 * and one broken link out of alpha.
 */
export function linkedCorpus(): Pick<FixtureOptions, "docs" | "links"> {
  return {
    docs: [
      { id: 1, path: "index.md", title: "Index" },
      { id: 2, path: "alpha.md", title: "Alpha" },
      { id: 3, path: "beta.md", title: "Beta" },
      { id: 4, path: "orphan.md", title: "Orphan", updated: "2020-01-01" },
      { id: 5, path: "diagram.png", title: "Diagram", assetType: "image" },
    ],
    links: [
      { sourceId: 1, target: "alpha", targetId: 2 },
      { sourceId: 2, target: "beta", targetId: 3 },
      { sourceId: 3, target: "index", targetId: 1 },
      { sourceId: 2, target: "ghost", targetId: null },
    ],
  };
}

/** The precomputed half of `linkedCorpus`, as a v8 index run would leave it. */
export function computedGraph(): Pick<
  FixtureOptions,
  "metrics" | "communities" | "rootDistances" | "layouts" | "metadata"
> {
  return {
    metrics: [
      { documentId: 1, inDegree: 1, outDegree: 1, pagerank: 0.3, community: 0 },
      { documentId: 2, inDegree: 1, outDegree: 1, pagerank: 0.25, community: 0 },
      { documentId: 3, inDegree: 1, outDegree: 1, pagerank: 0.2, community: 1 },
      { documentId: 4, inDegree: 0, outDegree: 0, pagerank: 0.05, community: 1, component: 1 },
    ],
    communities: [
      { community: 0, size: 2, label: "index", topTerms: ["index", "alpha"] },
      { community: 1, size: 2, label: "beta", topTerms: ["beta"] },
    ],
    // The virtual root links to index.md; orphan.md is reachable from nothing.
    rootDistances: [
      { documentId: 1, distance: 1 },
      { documentId: 2, distance: 2, parentId: 1 },
      { documentId: 3, distance: 3, parentId: 2 },
    ],
    layouts: [
      { documentId: 1, x: 1, y: 2 },
      { documentId: 2, x: 3, y: 4 },
      { documentId: 3, x: 5, y: 6 },
      { documentId: 4, x: 7, y: 8 },
    ],
    metadata: {
      graph_computed_at: "2026-08-02T00:00:00.000Z",
      graph_root: "virtual:AGENTS.md",
      graph_root_links: "[1]",
    },
  };
}
