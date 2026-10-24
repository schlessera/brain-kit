import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";

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
