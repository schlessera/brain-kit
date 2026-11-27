import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { countExecutions } from "./statement-counter";

// Every index run re-resolves every link (#4780), and writes to `links` and
// `supersedes` only what that resolution changed. These tests count the rows
// written with triggers, and hold the tables to a fresh build of the same
// Markdown.
const taxonomy = buildTaxonomy({ user: null });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const note = (title: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ntype: note\ncreated: "2026-07-01"\nupdated: "2026-07-12"\n${extra}---\n${body}\n`;

function brain(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "brain-index-links-diff-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  return root;
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function open(root: string, name: string): Database {
  const db = openDatabase(join(root, ".brain-index", `${name}.db`));
  cleanups.push(() => db.close());
  return db;
}
const options = (root: string) => ({ root, taxonomy, quiet: true });

/** Count every row inserted into, updated in or deleted from `links` on this connection. */
function countLinkWrites(db: Database): () => number {
  db.run("CREATE TEMP TABLE IF NOT EXISTS link_writes (op TEXT NOT NULL)");
  db.run("DELETE FROM link_writes");
  for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    db.run(`CREATE TEMP TRIGGER IF NOT EXISTS links_${op.toLowerCase()}_count AFTER ${op} ON main.links
      BEGIN INSERT INTO link_writes (op) VALUES ('${op}'); END`);
  }
  return () => (db.prepare("SELECT COUNT(*) AS n FROM link_writes").get() as { n: number }).n;
}

/** `links` and `supersedes` as content: source, target text and resolved path. */
function linkTables(db: Database) {
  const rows = (sql: string) => db.prepare(sql).all();
  return {
    links: rows(`SELECT s.path AS source, l.target, t.path AS resolved FROM links l JOIN documents s ON s.id = l.source_id
      LEFT JOIN documents t ON t.id = l.target_id ORDER BY source, l.target`),
    dangling: rows("SELECT l.target FROM links l LEFT JOIN documents t ON t.id = l.target_id WHERE l.target_id IS NOT NULL AND t.id IS NULL"),
    supersedes: rows(`SELECT s.path AS source, x.target, t.path AS resolved FROM supersedes x JOIN documents s ON s.id = x.source_id
      LEFT JOIN documents t ON t.id = x.target_id ORDER BY source, x.target`),
  };
}

/** A fresh `--force` build of the tree as it is now, in a database of its own. */
async function forced(root: string, name: string) {
  const db = open(root, name);
  await indexAll(db, { ...options(root), force: true });
  return linkTables(db);
}

const CORPUS = {
  "notes/penelope.md": note("Penelope", "Weaves. See [[telemachus]], [[raft]] and [[nowhere]]."),
  "notes/telemachus.md": note("Telemachus", "Seeks [[odysseus]] and [[loom]]."),
  "notes/odysseus.md": note("Odysseus", "Returns to [[penelope]]."),
  "notes/raft.md": note("Raft", "Built on Ogygia."),
  "notes/a/loom.md": note("Loom", "The only loom."),
};
const LINK_ROWS = 6;

describe("links are written as a difference (#4780)", () => {
  test("a run over an unchanged corpus writes no links row", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    expect((db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(LINK_ROWS);
    const writes = countLinkWrites(db);
    expect((await indexAll(db, options(root))).unchanged).toBe(5);
    expect(writes()).toBe(0);
  });

  test("a body edit that keeps its links writes none, and one added link writes one row", async () => {
    const root = brain(CORPUS);
    const db = open(root, "brain");
    await indexAll(db, options(root));
    const writes = countLinkWrites(db);
    write(root, "notes/penelope.md", note("Penelope", "Weaves by day. See [[telemachus]], [[raft]] and [[nowhere]]."));
    expect((await indexAll(db, options(root))).updated).toBe(1);
    expect(writes()).toBe(0);
    write(root, "notes/penelope.md", note("Penelope", "Weaves by day. See [[telemachus]], [[raft]], [[odysseus]] and [[nowhere]]."));
    expect((await indexAll(db, options(root))).updated).toBe(1);
    expect(writes()).toBe(1);
    expect(linkTables(db)).toEqual(await forced(root, "fresh"));
  });

  test("an incremental run leaves the links a --force build leaves", async () => {
    const cases: Array<[string, (root: string) => void, { source: string; target: string; resolved: string | null }]> = [
      ["a link added", (root) => write(root, "notes/raft.md", note("Raft", "Built on Ogygia for [[odysseus]].")),
        { source: "notes/raft.md", target: "odysseus", resolved: "notes/odysseus.md" }],
      ["a link removed", (root) => write(root, "notes/penelope.md", note("Penelope", "Weaves. See [[telemachus]] and [[nowhere]].")),
        { source: "notes/penelope.md", target: "telemachus", resolved: "notes/telemachus.md" }],
      ["a target renamed", (root) => renameSync(join(root, "notes/odysseus.md"), join(root, "notes/ulysses.md")),
        { source: "notes/telemachus.md", target: "odysseus", resolved: null }],
      ["a target deleted", (root) => unlinkSync(join(root, "notes/telemachus.md")),
        { source: "notes/penelope.md", target: "telemachus", resolved: null }],
      ["a new namesake makes a link ambiguous", (root) => write(root, "notes/b/loom.md", note("Second loom", "Another loom.")),
        { source: "notes/telemachus.md", target: "loom", resolved: null }],
    ];
    // Compared once, so a failure lists every case that went wrong.
    const actual: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [step, change, expected] of cases) {
      const root = brain(CORPUS);
      const db = open(root, "brain");
      await indexAll(db, options(root));
      change(root);
      await indexAll(db, options(root));
      const after = linkTables(db);
      actual.push({ step, ...after, link: after.links.find((l: any) => l.source === expected.source && l.target === expected.target) });
      wanted.push({ step, ...(await forced(root, "fresh")), link: expected });
    }
    expect(actual).toEqual(wanted);
  });

  test("an incremental run leaves the supersedes rows a --force build leaves", async () => {
    const root = brain({
      "notes/plan.md": note("Plan", "The current plan.", "supersedes: [\"[[old-plan]]\", \"[[plan]]\"]\n"),
      "notes/old-plan.md": note("Old plan", "The first plan."),
      "notes/notes.md": note("Notes", "Unrelated."),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    expect(linkTables(db)).toEqual(await forced(root, "fresh-0"));
    expect(linkTables(db).supersedes).toEqual([
      { source: "notes/plan.md", target: "old-plan", resolved: "notes/old-plan.md" },
      { source: "notes/plan.md", target: "plan", resolved: null },
    ]);
    renameSync(join(root, "notes/old-plan.md"), join(root, "notes/archive-plan.md"));
    await indexAll(db, options(root));
    expect(linkTables(db)).toEqual(await forced(root, "fresh-1"));
    expect(linkTables(db).supersedes).toContainEqual({ source: "notes/plan.md", target: "old-plan", resolved: null });
    write(root, "notes/old-plan.md", note("Old plan", "Back again."));
    await indexAll(db, options(root));
    expect(linkTables(db)).toEqual(await forced(root, "fresh-2"));
    expect(linkTables(db).supersedes).toContainEqual({ source: "notes/plan.md", target: "old-plan", resolved: "notes/old-plan.md" });
  });

  test("an unchanged run executes as many statements with 200 links as with 20", async () => {
    const executions = async (linksPerNote: number) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 10; i++) {
        // Distinct link texts: half resolve (a heading keeps each one apart), half do not.
        const targets = Array.from({ length: linksPerNote }, (_, k) => (k % 2 ? `[[n${(i + k) % 10}#s${k}]]` : `[[missing-${i}-${k}]]`));
        files[`notes/n${i}.md`] = note(`Note ${i}`, `Links: ${targets.join(" ")}`);
      }
      const root = brain(files);
      const db = open(root, "brain");
      await indexAll(db, options(root));
      expect(db.prepare("SELECT COUNT(*) AS n, COUNT(target_id) AS resolved FROM links").get()).toEqual({ n: 10 * linksPerNote, resolved: 5 * linksPerNote });
      const counter = countExecutions(db);
      try {
        expect((await indexAll(db, options(root))).unchanged).toBe(10);
      } finally {
        counter.restore();
      }
      return counter.count();
    };
    const few = await executions(2);
    expect(await executions(20)).toBe(few);
  });
});
