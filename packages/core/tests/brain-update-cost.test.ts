import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, relative } from "path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { updateDocumentFields } from "../src/lib/ops/write";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { countExecutions } from "./statement-counter";

// The cost counters of epic #4663, held together for one case (#5063): a
// body-only `brain_update` of one note reads that note, rewrites no graph
// table, writes no `links` row, runs as many statements on 200 notes as on
// 20, and scans no chunk to prune a context cache the brain does not have.
const taxonomy = buildTaxonomy({ user: null });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const GRAPH_TABLES = ["graph_metrics", "graph_communities", "graph_root_distances", "graph_layouts"];
const EDITED = "notes/n007.md";

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** `size` linked notes under `notes/`, indexed by a complete run. */
async function brain(size: number): Promise<{ root: string; db: Database }> {
  const root = mkdtempSync(join(tmpdir(), "brain-update-cost-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const name = (i: number) => `n${String(i).padStart(3, "0")}`;
  write(root, "_index.md", `---\ntitle: Ithaca\ntype: note\n---\nStart at [[${name(0)}]].\n`);
  for (let i = 0; i < size; i++) {
    write(root, `notes/${name(i)}.md`, `---\ntitle: Log ${i}\ntype: note\ncreated: "2026-07-01"\nupdated: "2026-07-12"\n`
      + `tags: [voyage]\n---\nDay ${i} at sea, after [[${name((i + 1) % size)}]].\n`);
  }
  const db = openDatabase(join(root, ".brain-index", "brain.db"));
  cleanups.push(() => db.close());
  await indexAll(db, { root, taxonomy, quiet: true });
  return { root, db };
}

/** Count every row inserted into, updated in or deleted from `tables` on this connection. */
function countRowWrites(db: Database, tables: string[]): () => Record<string, number> {
  db.run("CREATE TEMP TABLE IF NOT EXISTS row_writes (tbl TEXT NOT NULL)");
  db.run("DELETE FROM row_writes");
  for (const table of tables) for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    db.run(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_count AFTER ${op} ON main.${table}
      BEGIN INSERT INTO row_writes (tbl) VALUES ('${table}'); END`);
  }
  return () => Object.fromEntries(tables.map((table) =>
    [table, (db.prepare("SELECT COUNT(*) AS n FROM row_writes WHERE tbl = ?").get(table) as { n: number }).n]));
}

/** The SQL text of every statement `db` prepares or queries while recording. */
function recordStatements(db: Database): { sql: string[]; restore: () => void } {
  const sql: string[] = [];
  const { prepare, query } = db;
  db.prepare = ((...args: Parameters<typeof prepare>) => { sql.push(String(args[0])); return prepare.apply(db, args); }) as typeof prepare;
  db.query = ((...args: Parameters<typeof query>) => { sql.push(String(args[0])); return query.apply(db, args); }) as typeof query;
  return { sql, restore: () => { db.prepare = prepare; db.query = query; } };
}

/** The brain's markdown files read through `readFileSync` while `run` runs, root-relative and once each. */
async function markdownReads<T>(root: string, run: () => Promise<T>): Promise<string[]> {
  const bases = [realpathSync(root), root];
  const reads = new Set<string>();
  const original = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith(".md")) {
      for (const base of bases) {
        const rel = relative(base, path);
        if (!rel.startsWith("..") && !isAbsolute(rel)) { reads.add(rel); break; }
      }
    }
    return (original as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return [...reads].sort();
}

/** The prune's scan of every markdown chunk (`pruneSidecarCaches`, src/lib/indexer/caches.ts). */
const PRUNE_CHUNK_SCAN = /FROM chunks c JOIN documents d ON d\.id = c\.document_id\s+WHERE d\.asset_type = 'markdown'/;

/** One body-only `brain_update` of `EDITED` in a brain of `size` notes, with every counter around it. */
async function bodyOnlyUpdate(size: number) {
  const { root, db } = await brain(size);
  expect(existsSync(join(root, ".brain-cache", "contexts.jsonl")), "the brain has no context cache").toBe(false);
  expect((db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(size + 1);
  expect((db.prepare("SELECT COUNT(*) AS n FROM graph_layouts").get() as { n: number }).n).toBe(size + 1);
  const rowWrites = countRowWrites(db, [...GRAPH_TABLES, "links"]);
  const statements = recordStatements(db);
  const executions = countExecutions(db);
  let changes: string[] = [];
  let reads: string[];
  try {
    reads = await markdownReads(root, async () => {
      ({ changes } = await updateDocumentFields({ db, root, taxonomy }, { path: EDITED, appendContent: "Nausicaa finds the raft on the shore." }));
    });
  } finally {
    executions.restore();
    statements.restore();
  }
  expect(changes).toEqual(["content"]);
  const content = (db.prepare("SELECT content FROM documents WHERE path = ?").get(EDITED) as { content: string }).content;
  expect(content, "the run indexed the edit").toContain("Nausicaa");
  return { reads, writes: rowWrites(), statements: executions.count(), pruneScans: statements.sql.filter((sql) => PRUNE_CHUNK_SCAN.test(sql)) };
}

describe("one body-only brain_update costs what it changed (#5063)", () => {
  test("reads one note, rewrites no graph table or links row, runs N-independent statements and scans no chunk to prune", async () => {
    const small = await bodyOnlyUpdate(20);
    const large = await bodyOnlyUpdate(200);
    for (const run of [small, large]) {
      expect(run.reads, "BRAIN_UPDATE_READS_ONE_MARKDOWN_FILE").toEqual([EDITED]);
      expect(GRAPH_TABLES.map((table) => run.writes[table]), "BRAIN_UPDATE_REWRITES_NO_GRAPH_TABLE").toEqual([0, 0, 0, 0]);
      expect(run.writes.links, "BRAIN_UPDATE_WRITES_NO_LINKS_ROW").toBe(0);
      expect(run.pruneScans, "BRAIN_UPDATE_SCANS_NO_CHUNK_TO_PRUNE").toEqual([]);
    }
    expect(large.statements, "BRAIN_UPDATE_STATEMENTS_DO_NOT_DEPEND_ON_N").toBe(small.statements);
  });
});
