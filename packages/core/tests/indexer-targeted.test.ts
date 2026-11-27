import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import { CHUNKER_VERSION } from "../src/lib/chunker";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { countExecutions } from "./statement-counter";

// Targeted runs (#2835) read only the named paths, yet must leave the index a
// fresh build of the same Markdown would: every row, the link graph, the
// supersedes edges, name keys and the derived graph tables.
const taxonomy = buildTaxonomy({ user: { exclude: { dirs: ["drafts"] } } });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const note = (title: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ntype: note\ncreated: "2026-07-01"\nupdated: "2026-07-12"\n${extra}---\n${body}\n`;

function brain(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "brain-index-targeted-"));
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

/** The index as content, keyed by path: ids and run timestamps are not content. */
function snapshot(db: Database) {
  const rows = (sql: string) => db.prepare(sql).all();
  return {
    documents: rows(`SELECT path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type,
      deadline, next_review, generated_from, verification, chunker_version FROM documents ORDER BY path`),
    tags: rows(`SELECT d.path, t.name FROM document_tags dt JOIN documents d ON d.id = dt.document_id JOIN tags t ON t.id = dt.tag_id ORDER BY d.path, t.name`),
    fts: rows(`SELECT d.path, f.title, f.summary, f.content, f.tags, f.aliases FROM documents_fts f JOIN documents d ON d.id = f.rowid ORDER BY d.path`),
    ftsSearch: rows(`SELECT d.path FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH 'Penelope' ORDER BY d.path`),
    chunks: rows(`SELECT d.path, c.chunk_index, c.heading, c.content, c.token_estimate FROM chunks c JOIN documents d ON d.id = c.document_id ORDER BY d.path, c.chunk_index`),
    links: rows(`SELECT s.path AS source, l.target, t.path AS resolved FROM links l JOIN documents s ON s.id = l.source_id
      LEFT JOIN documents t ON t.id = l.target_id ORDER BY source, l.target`),
    supersedes: rows(`SELECT s.path AS source, x.target, t.path AS resolved FROM supersedes x JOIN documents s ON s.id = x.source_id
      LEFT JOIN documents t ON t.id = x.target_id ORDER BY source, x.target`),
    nameKeys: rows(`SELECT k.key, d.path FROM name_keys k JOIN documents d ON d.id = k.document_id ORDER BY k.key, d.path`),
    degrees: rows(`SELECT d.path, m.in_degree, m.out_degree FROM graph_metrics m JOIN documents d ON d.id = m.document_id ORDER BY d.path`),
    components: (rows(`SELECT d.path, m.component FROM graph_metrics m JOIN documents d ON d.id = m.document_id ORDER BY d.path`) as { path: string; component: number }[])
      .reduce((groups, row) => { (groups[row.component] ??= []).push(row.path); return groups; }, {} as Record<number, string[]>),
    distances: rows(`SELECT d.path, r.distance, p.path AS parent FROM graph_root_distances r JOIN documents d ON d.id = r.document_id
      LEFT JOIN documents p ON p.id = r.parent_id ORDER BY d.path`),
  };
}
const partitions = (value: ReturnType<typeof snapshot>) => ({ ...value, components: Object.values(value.components).map(group => group.join(",")).sort() });

/** A fresh build of the tree as it is now. */
async function fresh(root: string, name: string) {
  const db = open(root, name);
  await indexAll(db, options(root));
  return partitions(snapshot(db));
}

/**
 * Run `commit` once, right after the run loads the index's document rows: the
 * window in which another connection (an MCP server, a git hook) can commit
 * before the run writes. Restored in teardown.
 */
function afterRowsLoad(db: Database, commit: () => void) {
  const prepare = db.prepare;
  let fired = false;
  db.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare.apply(db, args);
    if (!String(args[0]).startsWith("SELECT id, path, asset_type, content_hash, chunker_version, accepted_mtime, stat_fingerprint FROM documents")) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...params: Parameters<typeof all>) => {
      const rows = all(...params);
      if (!fired) { fired = true; commit(); }
      return rows;
    }) as typeof statement.all;
    return statement;
  }) as typeof prepare;
  cleanups.push(() => { db.prepare = prepare; });
  return () => fired;
}

/** Another connection's index of an earlier version of `path`: its row, as that run committed it. */
function commitRow(root: string, name: string, path: string, title: string) {
  const other = open(root, name);
  other.prepare(`INSERT INTO documents (path, title, type, created, updated, content, content_hash, asset_type, indexed_at, chunker_version)
    VALUES (?, ?, 'note', '2026-07-01', '2026-07-12', 'An earlier version.', 'earlier', 'markdown', ?, ?)`).run(path, title, new Date().toISOString(), CHUNKER_VERSION);
  const { id } = other.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number };
  other.prepare("INSERT INTO documents_fts(rowid, title, summary, content, tags, aliases) VALUES (?, ?, '', 'An earlier version.', '', '')").run(id, title);
}

describe("targeted index runs (#2835)", () => {
  test("batched writes, repeated edits, removals and secondary structures match a fresh build", async () => {
    const root = brain({
      "_index.md": note("Ithaca", "Start at [[penelope]] and [[notes/raft]]."),
      "notes/penelope.md": note("Penelope", "Penelope weaves. See [[telemachus]] and [[Shroud]].", "tags: [household]\n"),
      "notes/telemachus.md": note("Telemachus", "Seeks news of [[odysseus]]. Mentions [[the weaver]]."),
      "notes/raft.md": note("Raft", "Built on Ogygia. [[Calypso]] helped.", "tags: [voyage, craft]\n"),
      "notes/old-raft.md": note("Old raft", "Superseded plan."),
      "notes/a/loom.md": note("Loom A", "First loom."),
      "notes/b/loom.md": note("Loom B", "Second loom. [[loom]]"),
      "drafts/hidden.md": note("Hidden", "Excluded draft."),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh-0"));

    // One batch: a new target for an unresolved link elsewhere, an alias that
    // resolves a link in an unchanged file, a repeated edit, a removal that
    // unresolves links, a supersedes edge and an ambiguous basename.
    write(root, "notes/odysseus.md", note("Odysseus", "Returns to [[Ithaca]]."));
    write(root, "notes/penelope.md", note("Penelope", "Penelope weaves by day.", "aliases: [The Weaver, Queen]\ntags: [household]\n"));
    write(root, "notes/penelope.md", note("Penelope", "Penelope unweaves by night. [[telemachus]]", "aliases: [The Weaver]\ntags: [household, loom]\n"));
    unlinkSync(join(root, "notes/raft.md"));
    write(root, "notes/new-raft.md", note("New raft", "Replaces the old plan.", "supersedes: [\"[[Old raft]]\"]\n"));
    write(root, "notes/c/loom.md", note("Loom C", "Third loom."));
    write(root, "drafts/hidden.md", note("Hidden", "Still excluded, now edited."));
    const stats = await indexAll(db, { ...options(root), paths: ["notes/odysseus.md", "notes/penelope.md", "notes/penelope.md",
      "notes/raft.md", "notes/new-raft.md", "notes/c/loom.md", "drafts/hidden.md"] });
    expect(stats.added).toBe(3);
    expect(stats.updated).toBe(1);
    expect(stats.deleted).toBe(1);
    // Only the named files were read: the unchanged corpus is not counted.
    expect(stats.unchanged).toBe(0);
    const after = partitions(snapshot(db));
    expect(after).toEqual(await fresh(root, "fresh-1"));
    expect(after.links).toContainEqual({ source: "notes/telemachus.md", target: "odysseus", resolved: "notes/odysseus.md" });
    expect(after.links).toContainEqual({ source: "notes/telemachus.md", target: "the weaver", resolved: "notes/penelope.md" });
    expect(after.links).toContainEqual({ source: "_index.md", target: "notes/raft", resolved: null });

    // A named file that is no longer a valid document, or never was one,
    // leaves no row behind, as in a fresh build.
    write(root, "notes/telemachus.md", "No frontmatter any more.\n");
    write(root, "notes/stray.txt.md", "---\ntitle: Stray\n---\nNo type.\n");
    await indexAll(db, { ...options(root), paths: ["notes/telemachus.md", "notes/stray.txt.md", "notes/never-written.md"] });
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh-2"));
  });

  test("a one-file targeted run executes as many statements on 200 notes as on 20", async () => {
    const executions = async (size: number) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < size; i++) files[`notes/n${String(i).padStart(3, "0")}.md`] = note(`Note ${i}`, `Body of note ${i}.`, `aliases: [Alias ${i}]\n`);
      const root = brain(files);
      const db = open(root, "brain");
      await indexAll(db, options(root));
      write(root, "notes/n007.md", note("Note 7", "Body of note 7, edited.", "aliases: [Alias 7]\n"));
      const counter = countExecutions(db);
      try {
        const stats = await indexAll(db, { ...options(root), paths: ["notes/n007.md"] });
        expect(stats.updated).toBe(1);
      } finally {
        counter.restore();
      }
      return counter.count();
    };
    const small = await executions(20);
    expect(await executions(200)).toBe(small);
  });

  test("a named file resolves a link through an alias of a file it did not name", async () => {
    const root = brain({
      "notes/calypso.md": note("Calypso", "Keeps Odysseus on her island.", "aliases: [Nymph of Ogygia]\n"),
      "notes/raft.md": note("Raft", "Built on Ogygia."),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    write(root, "notes/raft.md", note("Raft", "Built on Ogygia; [[Nymph of Ogygia]] helped."));
    await indexAll(db, { ...options(root), paths: ["notes/raft.md"] });
    const after = partitions(snapshot(db));
    expect(after.links).toEqual([{ source: "notes/raft.md", target: "Nymph of Ogygia", resolved: "notes/calypso.md" }]);
    expect(after).toEqual(await fresh(root, "fresh"));
  });

  test("a row another connection commits for a named path after the run read the index is indexed over (#4899)", async () => {
    const root = brain({ "notes/penelope.md": note("Penelope", "Penelope weaves.") });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    write(root, "notes/telemachus.md", note("Telemachus", "Son of [[Penelope]]."));
    const fired = afterRowsLoad(db, () => commitRow(root, "brain", "notes/telemachus.md", "Telemachus"));
    await indexAll(db, { ...options(root), paths: ["notes/telemachus.md"] });
    expect(fired()).toBe(true);
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh"));
  });

  test("a note another connection commits after the run read the index resolves links as a fresh build does (#4899)", async () => {
    const root = brain({
      "notes/penelope.md": note("Penelope", "Penelope waits for [[odysseus]]."),
      "notes/telemachus.md": note("Telemachus", "Son of Penelope."),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    write(root, "notes/odysseus.md", note("Odysseus", "Returns to Ithaca."));
    write(root, "notes/telemachus.md", note("Telemachus", "Son of Penelope, edited."));
    const fired = afterRowsLoad(db, () => commitRow(root, "brain", "notes/odysseus.md", "Odysseus"));
    await indexAll(db, { ...options(root), paths: ["notes/telemachus.md"] });
    expect(fired()).toBe(true);
    const after = partitions(snapshot(db));
    expect(after.links).toContainEqual({ source: "notes/penelope.md", target: "odysseus", resolved: "notes/odysseus.md" });
    expect(after).toEqual(await fresh(root, "fresh"));
  });

  test("a row another connection commits for a named, deleted path after the run read the index is swept and counted (#4873)", async () => {
    const root = brain({ "notes/penelope.md": note("Penelope", "Penelope weaves.") });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    // Indexed elsewhere, then deleted before this run reads the disk.
    const fired = afterRowsLoad(db, () => commitRow(root, "brain", "notes/raft.md", "Raft"));
    const stats = await indexAll(db, { ...options(root), paths: ["notes/raft.md"] });
    expect(fired()).toBe(true);
    expect(stats.deleted).toBe(1);
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh"));
  });

  test("an alias that holds a line break resolves links as a fresh build does (#4876)", async () => {
    // The stored aliases column holds one alias per line; this one spans two.
    const root = brain({
      "notes/cove.md": note("Cove", "Where the Phaeacians left him.", 'aliases: ["Phorcys\\nharbour"]\n'),
      "notes/landing.md": note("Landing", "Asleep at [[harbour]], then woke at [[Phorcys\nharbour]]."),
      "notes/raft.md": note("Raft", "Built on Ogygia."),
    });
    const db = open(root, "brain");
    await indexAll(db, options(root));
    const built = partitions(snapshot(db));
    expect(built.links).toEqual([
      { source: "notes/landing.md", target: "Phorcys\nharbour", resolved: "notes/cove.md" },
      { source: "notes/landing.md", target: "harbour", resolved: null },
    ]);
    write(root, "notes/raft.md", note("Raft", "Built on Ogygia, then wrecked."));
    await indexAll(db, { ...options(root), paths: ["notes/raft.md"] });
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh-targeted"));
    // A complete run that finds the note unchanged takes its aliases from the index too.
    write(root, "notes/raft.md", note("Raft", "Built on Ogygia, wrecked, rebuilt."));
    await indexAll(db, options(root));
    expect(partitions(snapshot(db)).links).toEqual(built.links);
    // Such a note's aliases come from its file, as a fresh build reads them,
    // even when it changed and the run was not told.
    write(root, "notes/cove.md", note("Cove", "Where the Phaeacians left him.", 'aliases: ["Phorcys\\nbay"]\n'));
    write(root, "notes/raft.md", note("Raft", "Built on Ogygia, wrecked, rebuilt, sailed."));
    await indexAll(db, { ...options(root), paths: ["notes/raft.md"] });
    expect(partitions(snapshot(db)).links).toEqual((await fresh(root, "fresh-edited")).links);
  });

  test("an index without markdown is built completely, whatever paths were named", async () => {
    const root = brain({
      "notes/penelope.md": note("Penelope", "Penelope weaves. [[telemachus]]"),
      "notes/telemachus.md": note("Telemachus", "Son of Odysseus."),
    });
    const db = open(root, "brain");
    const stats = await indexAll(db, { ...options(root), paths: ["notes/penelope.md"] });
    expect(stats.added).toBe(2);
    expect(partitions(snapshot(db))).toEqual(await fresh(root, "fresh"));
  });
});
