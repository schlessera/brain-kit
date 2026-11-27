/**
 * The operations behind the core MCP tools (`lib/ops/`), called directly
 * against the fixture corpus: what each returns without the MCP wrapper, and
 * what each write leaves on disk and in the index (#1349).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "fs";
import { existsSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { isAbsolute, join, relative } from "path";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

import { initContext, type BrainContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { getMarkdownFiles, indexAll } from "../src/lib/indexer";
import { indexStaleness } from "../src/lib/ops/staleness";
import { contextBriefing, listDocuments, readDocument, searchDocuments } from "../src/lib/ops/read";
import { addDocument, archiveWithReindex, splitTags, updateDocumentFields } from "../src/lib/ops/write";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

/** A freshly indexed copy of the fixture corpus. */
async function indexedBrain(): Promise<{ root: string; brain: BrainContext; db: Database }> {
  const root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const brain = await initContext({ root });
  return { root, brain, db: openDatabase(brain.dbPath) };
}

const row = (db: Database, path: string) =>
  db.prepare("SELECT status, relevance, summary FROM documents WHERE path = ?").get(path) as
    | { status: string; relevance: string | null; summary: string | null }
    | null;

describe("read operations", () => {
  let root: string;
  let brain: BrainContext;
  let db: Database;

  beforeAll(async () => {
    ({ root, brain, db } = await indexedBrain());
  });

  afterAll(() => {
    db?.close();
    cleanup(root);
  });

  test("indexStaleness counts edited, unindexed and deleted markdown files", () => {
    const markdown = getMarkdownFiles(root, brain.taxonomy).length;
    expect(markdown).toBeGreaterThan(0);
    expect(indexStaleness(db, root, brain.taxonomy)).toEqual({ stale: 0, indexed: markdown });

    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(join(root, "notes/loose-idea.md"), future, future);
    expect(indexStaleness(db, root, brain.taxonomy).stale).toBe(1);
    writeFileSync(join(root, "notes/unindexed.md"), "---\ntitle: Unindexed\ntype: note\n---\n\nLater.\n");
    expect(indexStaleness(db, root, brain.taxonomy).stale).toBe(2);
    const deleted = readFileSync(join(root, "health/sleep-tracking.md"));
    rmSync(join(root, "health/sleep-tracking.md"));
    expect(indexStaleness(db, root, brain.taxonomy)).toEqual({ stale: 3, indexed: markdown });

    // Restore the corpus for the other read tests.
    writeFileSync(join(root, "health/sleep-tracking.md"), deleted);
    rmSync(join(root, "notes/unindexed.md"));
  });

  test("searchDocuments returns the mapped hits, capped at the limit it is given", async () => {
    const { results, warnings } = await searchDocuments(
      { db, brain },
      { query: "raft", mode: "fts", includeArchived: false, assetsOnly: false, limit: 2, upcoming: false }
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.path.startsWith("projects/active/raft/"))).toBe(true);
    for (const r of results) {
      expect(Object.keys(r).sort()).toEqual(
        ["deadline", "path", "relevance", "score", "snippet", "status", "summary", "tags", "title", "type", "updated"]
      );
    }
    expect(warnings).toBeArray();
  });

  test("searchDocuments with upcoming keeps an explicit deadlineFrom instead of today", async () => {
    // A pinned date, so the fixture's deadline is upcoming whatever today is.
    const { results } = await searchDocuments(
      { db, brain },
      { query: "raft", mode: "fts", includeArchived: false, assetsOnly: false, limit: 10, upcoming: true, deadlineFrom: "2026-07-12" }
    );
    expect(results.map((r) => r.path)).toEqual(["projects/active/raft/status.md"]);
    expect(results[0]!.deadline).toBe("2026-07-29");
  });

  test("contextBriefing leads with the identity document", async () => {
    const { context, warnings } = await contextBriefing(
      { db, brain },
      { query: "raft", maxTokens: 2000, includeIdentity: true, includeCurrentFocus: true }
    );
    expect(context).toContain("King of Ithaca");
    expect(context).toContain("raft");
    expect(warnings).toBeArray();
  });

  test("readDocument returns the file, one section, or refuses a path outside the root", () => {
    expect(readDocument(root, { path: "me/identity.md" })).toBe(readFileSync(join(root, "me/identity.md"), "utf-8"));
    const section = readDocument(root, { path: "me/identity.md", section: "how to work with odysseus" });
    expect(section.startsWith("## How to Work With Odysseus")).toBe(true);
    expect(section).not.toContain("## Reaching Odysseus");
    expect(() => readDocument(root, { path: "../outside.md" })).toThrow("path escapes the brain root directory");
  });

  test("listDocuments applies the limit as given and lists archived documents only on request", () => {
    expect(listDocuments(db, { limit: 3 }).documents).toHaveLength(3);
    const all = listDocuments(db, { limit: 1000 }).documents;
    // No cap here: the caller validates the limit.
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((d) => d.path)).not.toContain("projects/archive/one-old-build.md");
    const archived = listDocuments(db, { status: "archived", limit: 1000 }).documents;
    expect(archived.map((d) => d.path)).toContain("projects/archive/one-old-build.md");
    expect(Object.keys(archived[0]!).sort()).toEqual(["path", "relevance", "status", "tags", "title", "type"]);
  });
});

describe("write operations", () => {
  let root: string;
  let brain: BrainContext;
  let db: Database;
  const deps = () => ({ db, root, taxonomy: brain.taxonomy });

  beforeAll(async () => {
    ({ root, brain, db } = await indexedBrain());
  });

  afterAll(() => {
    db?.close();
    cleanup(root);
  });

  test("splitTags trims and drops empty tags", () => {
    expect(splitTags(" raft, ,sail ,")).toEqual(["raft", "sail"]);
    expect(splitTags("")).toEqual([]);
  });

  test("addDocument writes, classifies and indexes new content", async () => {
    const outcome = await addDocument(deps(), {
      content: "Calypso offers bronze tools for the hull.",
      type: "note",
      title: "Bronze tools",
      tags: ["raft"],
    });
    expect(outcome).toMatchObject({ action: "created", type: "note", title: "Bronze tools", indexed: true });
    expect(readFileSync(join(root, outcome.path), "utf-8")).toContain("Calypso offers bronze tools");
    expect(row(db, outcome.path)).not.toBeNull();
  });

  test("updateDocumentFields sets fields, appends, bumps updated and reindexes", async () => {
    const result = await updateDocumentFields(deps(), {
      path: "notes/loose-idea.md",
      summary: "A wheel of the stars for the crossing",
      tags: ["navigation", "stars"],
      appendContent: "## Later\n\nCarve it from olive wood.",
    });
    const today = new Date().toISOString().split("T")[0];
    expect(result).toEqual({ path: "notes/loose-idea.md", updated: today, changes: ["summary", "tags", "content"] });
    const raw = readFileSync(join(root, "notes/loose-idea.md"), "utf-8");
    const { data, content } = parseFrontmatter(raw);
    expect(data.summary).toBe("A wheel of the stars for the crossing");
    expect(data.tags).toEqual(["navigation", "stars"]);
    expect(content).toContain("Carve it from olive wood.");
    expect(row(db, "notes/loose-idea.md")?.summary).toBe("A wheel of the stars for the crossing");
  });

  test("updateDocumentFields archiving by status demotes a primary relevance", async () => {
    const result = await updateDocumentFields(deps(), { path: "context/reading-list.md", status: "archived", relevance: "primary" });
    expect(result.changes).toEqual(["status", "relevance"]);
    expect(parseFrontmatter(readFileSync(join(root, "context/reading-list.md"), "utf-8")).data.relevance).toBe("historical");
  });

  test("updateDocumentFields refuses no changes, missing documents and paths outside the root", async () => {
    await expect(updateDocumentFields(deps(), { path: "me/identity.md" })).rejects.toThrow("no changes specified");
    await expect(updateDocumentFields(deps(), { path: "notes/missing.md", summary: "x" })).rejects.toThrow(
      "not an existing markdown document: notes/missing.md"
    );
    await expect(updateDocumentFields(deps(), { path: "../outside.md", summary: "x" })).rejects.toThrow(
      "path escapes the brain root directory"
    );
  });

  test("archiveWithReindex previews on a dry run, then archives and reindexes", async () => {
    const path = "projects/active/sail-repairs/materials.md";
    const before = readFileSync(join(root, path), "utf-8");
    const preview = await archiveWithReindex(deps(), { path, dryRun: true });
    expect(preview).toMatchObject({ status: "archived", dryRun: true });
    expect(readFileSync(join(root, path), "utf-8")).toBe(before);

    const done = await archiveWithReindex(deps(), { path, dryRun: false });
    expect(done.moved).toBe(true);
    expect(existsSync(join(root, path))).toBe(false);
    expect(row(db, done.path)?.status).toBe("archived");
  });
});

/**
 * A write indexes only the paths it changed (#4778): the indexer's parse phase
 * reads those files and takes the rest of the brain from the index.
 */
describe("write operations index only the paths they change", () => {
  let root: string;
  let brain: BrainContext;
  let db: Database;
  const deps = () => ({ db, root, taxonomy: brain.taxonomy });

  beforeAll(async () => {
    root = makeTempBrain();
    for (let n = 1; n <= 30; n++) {
      const name = String(n).padStart(2, "0");
      writeFileSync(join(root, `notes/log-${name}.md`), `---\ntitle: Ship's log ${name}\ntype: note\n---\n\nDay ${name} at sea.\n`);
    }
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    brain = await initContext({ root });
    expect(getMarkdownFiles(root, brain.taxonomy).length).toBeGreaterThanOrEqual(50);
    db = openDatabase(brain.dbPath);
  });

  afterAll(() => {
    db?.close();
    cleanup(root);
  });

  /** The brain's markdown files read through `readFileSync` while `run` runs, repo-relative and once each. */
  async function markdownReads<T>(run: () => Promise<T>): Promise<{ result: T; reads: string[] }> {
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
      return { result: await run(), reads: [...reads].sort() };
    } finally {
      spy.mockRestore();
    }
  }

  /** The paths a keyword search finds for `query`. */
  const found = async (query: string) => (await searchDocuments(
    { db, brain },
    { query, mode: "fts", includeArchived: true, assetsOnly: false, limit: 10, upcoming: false }
  )).results.map((r) => r.path);

  test("updateDocumentFields reads the updated note and no other", async () => {
    const path = "notes/log-07.md";
    const { reads } = await markdownReads(() => updateDocumentFields(deps(), { path, appendContent: "Nausicaa finds the raft on the shore." }));
    expect(reads).toEqual([path]);
    expect(await found("Nausicaa")).toEqual([path]);
  });

  test("addDocument reads the file it created and no other", async () => {
    const { result, reads } = await markdownReads(() => addDocument(deps(), { content: "Aeolus ties the winds in an oxhide bag.", type: "note", title: "The bag of winds" }));
    expect(result.indexed).toBe(true);
    expect(reads).toEqual([result.path]);
    expect(await found("oxhide")).toEqual([result.path]);
  });

  test("archiveWithReindex reads the archived note, and moves its row when it moves the file", async () => {
    const inPlace = "notes/log-08.md";
    const kept = await markdownReads(() => archiveWithReindex(deps(), { path: inPlace, dryRun: false }));
    expect(kept.result.moved).toBe(false);
    expect(kept.reads).toEqual([inPlace]);
    expect(row(db, inPlace)?.status).toBe("archived");

    const from = "projects/active/sail-repairs/materials.md";
    const moved = await markdownReads(() => archiveWithReindex(deps(), { path: from, dryRun: false }));
    expect(moved.result.moved).toBe(true);
    // The document is read once to rewrite it; the indexer reads the new path only.
    expect(moved.reads).toEqual([moved.result.path, from].sort());
    expect(row(db, from)).toBeNull();
    expect(row(db, moved.result.path)?.status).toBe("archived");
  });

  test("a note edited elsewhere stays counted stale after a write and is indexed by the next complete run", async () => {
    const elsewhere = "notes/log-09.md";
    writeFileSync(join(root, elsewhere), "---\ntitle: Ship's log 09\ntype: note\n---\n\nScylla takes six of the crew.\n");
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(join(root, elsewhere), future, future);
    await updateDocumentFields(deps(), { path: "notes/log-10.md", summary: "Charybdis swallows the sea" });
    expect(indexStaleness(db, root, brain.taxonomy).stale).toBe(1);
    expect(await found("Scylla")).toEqual([]);

    await indexAll(db, { root, taxonomy: brain.taxonomy, force: false, quiet: true });
    expect(await found("Scylla")).toEqual([elsewhere]);
  });
});

test("addDocument on an index with no markdown rows builds the whole index", async () => {
  const root = makeTempBrain();
  try {
    const brain = await initContext({ root });
    const db = openDatabase(brain.dbPath);
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM documents WHERE asset_type = 'markdown'").get() as { n: number }).n).toBe(0);
      const outcome = await addDocument({ db, root, taxonomy: brain.taxonomy }, { content: "Hermes brings moly against the witch.", type: "note", title: "Moly" });
      expect(outcome.indexed).toBe(true);
      const indexed = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE asset_type = 'markdown'").get() as { n: number }).n;
      expect(indexed).toBe(getMarkdownFiles(root, brain.taxonomy).length);
    } finally {
      db.close();
    }
  } finally {
    cleanup(root);
  }
});
