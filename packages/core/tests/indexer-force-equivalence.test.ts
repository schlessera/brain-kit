import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import type { Taxonomy } from "../src/lib/taxonomy";
import { cleanup, makeTempBrain } from "./cli-harness";

// Markdown is the source of truth and brain.db is disposable (#5062, epic
// #4663): on the fixture corpus, an incremental run after each kind of edit
// leaves every derived table as `brain index --force` builds it from the same
// tree. Each edit runs on its own temp copy; the fixture itself is never
// written.
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function open(root: string, name: string): Database {
  const db = openDatabase(join(root, ".brain-index", `${name}.db`));
  cleanups.push(() => db.close());
  return db;
}

/** The columns of `table` other than `omit`, in schema order. */
function columns(db: Database, table: string, omit: string[]): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name).filter((name) => !omit.includes(name));
}

/**
 * Every derived table as content, keyed by path: row ids, run timestamps and
 * the integer labels of components and communities are not content, so a
 * component or a community is named by its sorted member paths.
 *
 * Two values are compared by what they mean rather than by their bits. A
 * layout warm-starts from the previous run's positions on purpose, so a reader
 * keeps their spatial memory (`computeClusterLayout`, src/lib/graph/layout.ts),
 * while a --force build starts cold: the layout must place the same documents,
 * at finite positions, but not at the same coordinates. PageRank sums in node
 * order, which follows row ids, and an incremental run gives a new note a
 * later id than a rebuild does: it is compared to twelve significant digits.
 */
function tables(db: Database) {
  const rows = <T = Record<string, unknown>>(sql: string) => db.prepare(sql).all() as T[];
  const documentColumns = columns(db, "documents", ["id", "indexed_at"]).map((c) => `d.${c}`).join(", ");
  const chunkColumns = columns(db, "chunks", ["id", "document_id"]).map((c) => `c.${c}`).join(", ");
  const members = (column: "component" | "community") => {
    const groups = new Map<number | null, string[]>();
    for (const row of rows<{ path: string; label: number | null }>(`SELECT d.path, m.${column} AS label FROM graph_metrics m
      JOIN documents d ON d.id = m.document_id ORDER BY d.path`)) {
      const group = groups.get(row.label) ?? [];
      group.push(row.path);
      groups.set(row.label, group);
    }
    return groups;
  };
  const named = (groups: Map<number | null, string[]>, label: number | null) =>
    label === null ? null : (groups.get(label) ?? []).join(",");
  const components = members("component"), communities = members("community");
  return {
    documents: rows(`SELECT ${documentColumns} FROM documents d ORDER BY d.path`),
    tags: rows(`SELECT d.path, t.name FROM document_tags dt JOIN documents d ON d.id = dt.document_id
      JOIN tags t ON t.id = dt.tag_id ORDER BY d.path, t.name`),
    fts: rows(`SELECT d.path, f.title, f.summary, f.content, f.tags, f.aliases FROM documents_fts f
      JOIN documents d ON d.id = f.rowid ORDER BY d.path`),
    chunks: rows(`SELECT d.path, ${chunkColumns} FROM chunks c JOIN documents d ON d.id = c.document_id ORDER BY d.path, c.chunk_index`),
    links: rows(`SELECT s.path AS source, l.target, t.path AS resolved FROM links l JOIN documents s ON s.id = l.source_id
      LEFT JOIN documents t ON t.id = l.target_id ORDER BY source, l.target`),
    supersedes: rows(`SELECT s.path AS source, x.target, t.path AS resolved FROM supersedes x JOIN documents s ON s.id = x.source_id
      LEFT JOIN documents t ON t.id = x.target_id ORDER BY source, x.target`),
    nameKeys: rows(`SELECT k.key, d.path FROM name_keys k JOIN documents d ON d.id = k.document_id ORDER BY k.key, d.path`),
    graphMetrics: rows<{ path: string; component: number; community: number | null }>(`SELECT d.path, m.in_degree, m.out_degree,
      m.component, m.pagerank, m.community FROM graph_metrics m JOIN documents d ON d.id = m.document_id ORDER BY d.path`)
      .map((row) => ({ ...row, component: named(components, row.component), community: named(communities, row.community),
        pagerank: Number((row as unknown as { pagerank: number }).pagerank.toPrecision(12)) })),
    graphCommunities: rows<{ community: number }>(`SELECT community, size, label, top_terms FROM graph_communities`)
      .map((row) => ({ ...row, community: named(communities, row.community) }))
      .sort((a, b) => String(a.community).localeCompare(String(b.community))),
    graphRootDistances: rows(`SELECT d.path, r.distance, p.path AS parent FROM graph_root_distances r
      JOIN documents d ON d.id = r.document_id LEFT JOIN documents p ON p.id = r.parent_id ORDER BY d.path`),
    graphLayouts: rows<{ mode: string; path: string; x: number; y: number }>(`SELECT l.mode, d.path, l.x, l.y FROM graph_layouts l
      JOIN documents d ON d.id = l.document_id ORDER BY l.mode, d.path`)
      .map(({ mode, path, x, y }) => ({ mode, path, placed: Number.isFinite(x) && Number.isFinite(y) })),
  };
}

const edit = (root: string, path: string, change: (text: string) => string) => {
  const before = readFileSync(join(root, path), "utf-8");
  const after = change(before);
  expect(after, `${path} was edited`).not.toBe(before);
  writeFileSync(join(root, path), after);
};

/** The seven edit kinds the epic names, each on its own copy of the corpus. */
const EDITS: Array<[string, (root: string) => void]> = [
  ["body", (root) => edit(root, "studies/star-bearings.md", (text) => `${text}\nChecked the bearings again at the second watch.\n`)],
  ["title", (root) => edit(root, "notes/quick-note-eagle.md", (text) => text.replace(/^title: .*$/m, 'title: "Eagle over the strait"'))],
  ["tag", (root) => edit(root, "studies/star-bearings.md", (text) => text.replace("tags: [study, navigation, star guide, orientation]",
    "tags: [study, navigation, orientation, night watch]"))],
  ["link", (root) => edit(root, "notes/loose-idea.md", (text) => `${text}\nIt would sit beside [[star-bearings]] on the raft.\n`)],
  ["add", (root) => writeFileSync(join(root, "notes/spare-oar.md"), "---\ntype: note\ntitle: Spare oar\ncreated: 2026-07-12\n"
    + "updated: 2026-07-12\ntags: [voyage]\n---\n\nCarve a spare oar for the [[plan]] before the passage.\n")],
  ["delete", (root) => unlinkSync(join(root, "projects/active/raft/plan.md"))],
  ["rename", (root) => renameSync(join(root, "studies/star-bearings.md"), join(root, "studies/night-bearings.md"))],
];

async function corpus(): Promise<{ root: string; taxonomy: Taxonomy }> {
  const root = makeTempBrain();
  cleanups.push(() => cleanup(root));
  return { root, taxonomy: (await initContext({ root })).taxonomy };
}

describe("an incremental run on the fixture corpus leaves what --force builds (#5062)", () => {
  test("after a body, title, tag, link, add, delete and rename edit, every derived table equals a --force build", async () => {
    // Compared once, so a failure lists every edit kind that went wrong.
    const actual: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [kind, change] of EDITS) {
      const { root, taxonomy } = await corpus();
      const db = open(root, "brain");
      await indexAll(db, { root, taxonomy, quiet: true });
      const graphed = (db.prepare("SELECT COUNT(*) AS n FROM graph_layouts").get() as { n: number }).n;
      expect(graphed, "the corpus has a graph layout to compare").toBeGreaterThan(0);
      change(root);
      const stats = await indexAll(db, { root, taxonomy, quiet: true });
      expect(stats.added + stats.updated + stats.deleted, `${kind}: the incremental run saw the edit`).toBeGreaterThan(0);
      const forced = open(root, "forced");
      await indexAll(forced, { root, taxonomy, quiet: true, force: true });
      actual.push({ kind, ...tables(db) });
      wanted.push({ kind, ...tables(forced) });
    }
    expect(actual).toEqual(wanted);
  });
});
