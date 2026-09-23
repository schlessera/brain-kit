/**
 * The numbers behind `brain stats`.
 *
 * Two layers: goldens over `fixtures/corpus/` indexed in-process with an
 * injected clock (so "stale" cannot drift as the wall clock moves past the
 * fixture's reference date), and unit tests over in-memory databases for the
 * cases a fixture cannot show — a missing `vec_chunks`, a failing free-space
 * probe, a per-type `staleDays` being changed underneath both `brain stats`
 * and `brain audit`.
 *
 * Keyless and network-free: `indexAll` runs without an embedding provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { audit } from "../src/lib/auditor";
import { brainConfigSchema, DEFAULT_STATS_THRESHOLDS, type BrainConfig } from "../src/lib/config";
import { initContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { collectStats, freeSpaceBytes, resolveStatsThresholds } from "../src/lib/stats";
import { buildTaxonomy, type Taxonomy } from "../src/lib/taxonomy";

const CORE_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_CORPUS = join(CORE_ROOT, "fixtures/corpus");
const REPO_NODE_MODULES = resolve(CORE_ROOT, "../../node_modules");

// Same injected wall clock as auditor.test.ts — every age in this file is
// measured against it, so the stale goldens hold forever.
const NOW = new Date("2026-07-01T00:00:00Z");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A chmod 000 directory is still readable by root, so the two unreadable-
// directory cases cannot be staged in a container that runs as root (CI does).
const asRoot = process.getuid?.() === 0;
const testUnlessRoot = asRoot ? test.skip : test;

function tempDir(prefix = "brain-stats-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Goldens over the fixture corpus
// ---------------------------------------------------------------------------

describe("collectStats over fixtures/corpus", () => {
  let root: string;
  let dbPath: string;
  let db: Database;
  let taxonomy: Taxonomy;
  let config: BrainConfig | null;

  beforeAll(async () => {
    root = tempDir("brain-stats-corpus-");
    cpSync(FIXTURE_CORPUS, root, { recursive: true });
    // The fixture's brain.config.ts imports @schlessera/brain.
    symlinkSync(REPO_NODE_MODULES, join(root, "node_modules"));

    const ctx = await initContext({ root });
    taxonomy = ctx.taxonomy;
    config = ctx.config;
    dbPath = ctx.dbPath;

    const writable = openDatabase(dbPath);
    await indexAll(writable, { root, taxonomy, quiet: true });
    writable.close();

    db = openDatabase(dbPath, { readonly: true });
  });

  afterAll(() => db?.close());

  // The rename guard: every field `brain stats --json` carried before this
  // change, with the type it carried. A removal or a rename fails here.
  test("keeps every pre-existing field, with its name and type", async () => {
    const stats = await collectStats(db, { root, dbPath, taxonomy, config, now: NOW });

    expect(typeof stats.documents).toBe("number");
    expect(typeof stats.byType).toBe("object");
    expect(typeof stats.byStatus).toBe("object");
    expect(typeof stats.byRelevance).toBe("object");
    expect(typeof stats.tags).toBe("number");
    expect(typeof stats.links).toBe("number");
    expect(typeof stats.brokenLinks).toBe("number");
    expect(typeof stats.chunks).toBe("number");
    expect(typeof stats.embeddings).toBe("number");

    // And their values still come from the same queries.
    expect(stats.documents).toBe(25);
    expect(stats.tags).toBe(43);
    expect(stats.links).toBe(37);
    expect(stats.brokenLinks).toBe(2);
    expect(stats.chunks).toBe(27);
    expect(stats.byType.health).toBe(3);
    expect(stats.byStatus.archived).toBe(1);
    expect(stats.byRelevance.primary).toBe(16);
  });

  test("health figures are the corpus goldens", async () => {
    const { health } = await collectStats(db, { root, dbPath, taxonomy, config, now: NOW });

    expect(health.brokenLinkRate).toBeCloseTo(2 / 37, 10);
    expect(health.stale).toBe(2);
    expect(health.orphans).toBe(1);
    expect(health.untagged).toBe(1);
    // Indexed without embeddings: no vec_chunks at all, so coverage is
    // unknown rather than 0%.
    expect(health.embeddingCoverage).toBeNull();
    expect(health.thresholds).toEqual(DEFAULT_STATS_THRESHOLDS);
  });

  test("stale and orphan counts are the audit's, not a second definition", async () => {
    const { health } = await collectStats(db, { root, dbPath, taxonomy, config, now: NOW });
    const issues = audit(db, taxonomy, { now: NOW });

    expect(health.stale).toBe(issues.filter((i) => i.category === "staleness").length);
    expect(health.orphans).toBe(issues.filter((i) => i.category === "orphan").length);
  });

  test("size figures cover the corpus, the index and the volume", async () => {
    const { size } = await collectStats(db, { root, dbPath, taxonomy, config, now: NOW });

    // Every file the fixture ships; node_modules and brain.db are not corpus.
    expect(size.corpus).not.toBeNull();
    expect(size.corpus!.files).toBe(29);
    expect(size.corpus!.bytes).toBeGreaterThan(0);

    expect(size.db.bytes).toBeGreaterThan(0);
    expect(size.db.tables.documents).toBe(25);
    expect(size.db.tables.links).toBe(37);
    expect(size.db.tables.chunks).toBe(27);
    // FTS5 and vec0 shadow tables are internals, not row counts anyone asked
    // for.
    expect(size.db.tables).not.toHaveProperty("documents_fts_data");
    expect(size.db.tables).not.toHaveProperty("documents_fts_idx");

    expect(size.freeBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests over in-memory databases
// ---------------------------------------------------------------------------

interface DocRow {
  path: string;
  type: string;
  updated: string;
  status?: string;
  content?: string;
  tags?: string[];
}

function insertDoc(db: Database, d: DocRow): number {
  db.run(
    `INSERT INTO documents
       (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      d.path,
      d.path,
      d.type,
      d.status ?? "active",
      "primary",
      null,
      "2026-01-01",
      d.updated,
      d.content ?? "",
      "hash-" + d.path,
      "markdown",
      "2026-01-01",
    ]
  );
  const id = (db.prepare("SELECT id FROM documents WHERE path = ?").get(d.path) as { id: number }).id;
  for (const tag of d.tags ?? []) {
    db.run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [tag]);
    const tagId = (db.prepare("SELECT id FROM tags WHERE name = ?").get(tag) as { id: number }).id;
    db.run("INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)", [id, tagId]);
  }
  return id;
}

function insertChunk(db: Database, documentId: number, index: number): void {
  db.run(
    `INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate)
     VALUES (?, ?, ?, ?, ?)`,
    [documentId, index, "Heading", "body", 10]
  );
}

/** A taxonomy with the fixture persona's types, staleDays overridable per test. */
function taxonomyWith(overrides: Record<string, unknown> = {}): Taxonomy {
  return buildTaxonomy({
    user: brainConfigSchema.parse({
      taxonomy: {
        types: {
          health: { dir: "health", staleDays: 60, staleSeverity: "warning" },
          journal: { dir: "journal", orphanExempt: true },
          ...overrides,
        },
      },
    }),
  });
}

describe("stale count and brain audit share one threshold", () => {
  test("a per-type staleDays change moves both figures together", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    // Six months old at NOW — stale at 60 days, fresh at 3650.
    insertDoc(db, { path: "health/knee-injury.md", type: "health", updated: "2026-01-01" });
    insertDoc(db, { path: "health/checkup-log.md", type: "health", updated: "2026-06-20" });

    const tight = taxonomyWith();
    const loose = taxonomyWith({ health: { dir: "health", staleDays: 3650 } });

    const tightStats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: tight,
      config: null,
      now: NOW,
    });
    const looseStats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: loose,
      config: null,
      now: NOW,
    });

    const staleIssues = (t: Taxonomy) =>
      audit(db, t, { now: NOW }).filter((i) => i.category === "staleness").length;

    expect(tightStats.health.stale).toBe(1);
    expect(tightStats.health.stale).toBe(staleIssues(tight));

    expect(looseStats.health.stale).toBe(0);
    expect(looseStats.health.stale).toBe(staleIssues(loose));

    db.close();
  });
});

describe("orphans honour orphanExempt", () => {
  test("a document of an exempt type is not counted", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    // Neither has a link in either direction.
    insertDoc(db, { path: "health/lonely.md", type: "health", updated: "2026-06-20" });
    insertDoc(db, { path: "journal/2026-06-15.md", type: "journal", updated: "2026-06-20" });

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
    });

    expect(stats.health.orphans).toBe(1);
    // Same answer as the audit, which is where the rule lives.
    const orphanPaths = audit(db, taxonomyWith(), { now: NOW })
      .filter((i) => i.category === "orphan")
      .map((i) => i.path);
    expect(orphanPaths).toEqual(["health/lonely.md"]);

    db.close();
  });
});

describe("untagged count", () => {
  test("counts non-archived markdown documents with no tags", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    insertDoc(db, { path: "health/tagged.md", type: "health", updated: "2026-06-20", tags: ["knee"] });
    insertDoc(db, { path: "health/bare.md", type: "health", updated: "2026-06-20" });
    // Archived documents are out of the health read, as they are for staleness.
    insertDoc(db, { path: "health/old.md", type: "health", updated: "2026-06-20", status: "archived" });

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
    });

    expect(stats.health.untagged).toBe(1);
    db.close();
  });
});

describe("embedding coverage is absent, not zero, when it cannot be known", () => {
  test("no vec_chunks table and chunks to divide by → null", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    const id = insertDoc(db, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    insertChunk(db, id, 0);
    insertChunk(db, id, 1);

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      // A provider IS configured, so this is not the keyless short-circuit:
      // the table is simply not there.
      embeddingsConfigured: true,
    });

    expect(stats.chunks).toBe(2);
    expect(stats.health.embeddingCoverage).toBeNull();
    // The legacy field keeps its number type.
    expect(stats.embeddings).toBe(0);
    db.close();
  });

  test("a brain that neither embeds nor holds vectors → null, not 0%", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    const id = insertDoc(db, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    insertChunk(db, id, 0);

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      embeddingsConfigured: false,
    });

    expect(stats.health.embeddingCoverage).toBeNull();
    db.close();
  });

  test("a corpus with no links has no broken-link rate", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");
    insertDoc(db, { path: "health/a.md", type: "health", updated: "2026-06-20" });

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
    });

    expect(stats.links).toBe(0);
    expect(stats.health.brokenLinkRate).toBeNull();
    db.close();
  });
});

/** A connection that cannot load extensions — sqlite-vec failing the way a broken install does. */
class NoExtensionDatabase extends Database {
  override loadExtension(): void {
    throw new Error("extension loading refused by the test");
  }
}

/** Collect with console.warn captured, so a test can say what reached stderr. */
async function collectCapturingWarnings(
  db: Database,
  opts: Parameters<typeof collectStats>[1]
): Promise<{ stats: Awaited<ReturnType<typeof collectStats>>; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { stats: await collectStats(db, opts), warnings };
  } finally {
    console.warn = original;
  }
}

describe("vectors are read through the shared loadVecSupport", () => {
  // collectStats used to hand-roll the sqlite-vec import and swallow its
  // failure. The shared read path reports WHY vectors are unreadable, and says
  // so on stderr when the cause is the extension itself (#170).
  test("vec_chunks holding vectors but an extension that will not load → coverage null, and the cause is named", async () => {
    const root = tempDir();
    const dbPath = join(root, "brain.db");
    const writer = openDatabase(dbPath);
    const id = insertDoc(writer, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    insertChunk(writer, id, 0);
    const { load } = await import("sqlite-vec");
    load(writer);
    writer.run("CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4])");
    const chunkId = (writer.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: number }).id;
    writer.run("INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)", [
      chunkId,
      new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
    ]);
    writer.close();

    const db = new NoExtensionDatabase(dbPath, { readonly: true });
    const { stats, warnings } = await collectCapturingWarnings(db, {
      root,
      dbPath,
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      embeddingsConfigured: true,
    });

    expect(stats.health.embeddingCoverage).toBeNull();
    // A vector sits in that table. 0 here would read exactly like a brain
    // holding none, so the count that could not be taken is null (#169).
    expect(stats.embeddings).toBeNull();
    expect(warnings).toEqual([
      "sqlite-vec not available: extension loading refused by the test",
    ]);
    db.close();
  });

  test("a brain with no vec_chunks is answered without loading the extension, and warns nothing", async () => {
    const root = tempDir();
    const dbPath = join(root, "brain.db");
    const writer = openDatabase(dbPath);
    const id = insertDoc(writer, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    insertChunk(writer, id, 0);
    writer.close();

    // Loading would throw here, so a quiet answer proves it was never tried.
    const db = new NoExtensionDatabase(dbPath, { readonly: true });
    const { stats, warnings } = await collectCapturingWarnings(db, {
      root,
      dbPath,
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      embeddingsConfigured: true,
    });

    expect(warnings).toEqual([]);
    // No table is nothing to count: a known 0, not the unknown null.
    expect(stats.embeddings).toBe(0);
    expect(stats.health.embeddingCoverage).toBeNull();
    db.close();
  });
});

describe("counting vectors never migrates the index", () => {
  // Found by review: `collectStats` is exported, so a caller can hand it a
  // WRITABLE connection. It used to reach vec_chunks through initVecSupport,
  // whose vec0 migrations include a bare `DROP TABLE vec_chunks` for an index
  // written before the cosine metric — asking for statistics would have
  // destroyed the vectors and charged a paid re-embedding run to get them
  // back.
  test("a legacy vec_chunks table keeps its rows and its schema", async () => {
    const root = tempDir();
    const dbPath = join(root, "brain.db");
    const db = openDatabase(dbPath);
    const id = insertDoc(db, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    insertChunk(db, id, 0);

    // A pre-cosine, pre-v2 index: the vec0 table with none of the metadata
    // the current schema carries, and no vec_distance_metric in meta.
    const { load } = await import("sqlite-vec");
    load(db);
    db.run("CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[4])");
    const chunkId = (db.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: number }).id;
    db.run("INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)", [
      chunkId,
      new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
    ]);
    const schemaBefore = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'").get() as { sql: string }
    ).sql;

    const stats = await collectStats(db, {
      root,
      dbPath,
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      embeddingsConfigured: true,
    });

    expect(stats.embeddings).toBe(1);
    expect(stats.health.embeddingCoverage).toBe(1);
    // The vector survived, and so did the table it was in.
    expect((db.prepare("SELECT COUNT(*) as c FROM vec_chunks").get() as { c: number }).c).toBe(1);
    expect(
      (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'").get() as { sql: string })
        .sql
    ).toBe(schemaBefore);
    db.close();
  });
});

describe("size figures", () => {
  test("the corpus walk honours configured excludes", async () => {
    const root = tempDir();
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, "attic"), { recursive: true });
    mkdirSync(join(root, "logs"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "notes/keep.md"), "x".repeat(100));
    writeFileSync(join(root, "attic/dropped.md"), "y".repeat(1000));
    writeFileSync(join(root, "logs/dropped.md"), "z".repeat(1000));
    writeFileSync(join(root, "node_modules/dropped.md"), "w".repeat(1000));

    const db = openDatabase(":memory:");
    // `attic` is a user exclude; `logs` and `node_modules` are core defaults.
    const taxonomy = buildTaxonomy({
      user: brainConfigSchema.parse({ exclude: { dirs: ["attic"] } }),
    });

    const stats = await collectStats(db, {
      root,
      dbPath: join(root, "brain.db"),
      taxonomy,
      config: null,
      now: NOW,
    });

    expect(stats.size.corpus).toEqual({ files: 1, bytes: 100 });
    db.close();
  });

  // #139: the walk prunes a directory by testing `dir + "/"`, the indexer
  // tests each file. For `dirs: ["skipme/"]` the first matched and the second
  // did not, so `size.corpus` left out files the index held. Every spelling
  // must give the walk and the per-file filter the same file set.
  for (const entry of ["skipme", "skipme/", "./skipme", "./skipme/"]) {
    test(`the walk and the per-file filter keep the same files for dirs: [${JSON.stringify(entry)}]`, async () => {
      const root = tempDir();
      mkdirSync(join(root, "skipme/sub"), { recursive: true });
      mkdirSync(join(root, "notes"), { recursive: true });
      // Distinct sizes, so the byte total names the file set, not just its size.
      const files: Record<string, number> = {
        "keep.md": 1,
        "notes/keep.md": 2,
        "skipme/a.md": 4,
        "skipme/sub/b.md": 8,
      };
      for (const [file, size] of Object.entries(files)) writeFileSync(join(root, file), "x".repeat(size));

      const taxonomy = buildTaxonomy({ user: brainConfigSchema.parse({ exclude: { dirs: [entry] } }) });
      const perFile = Object.entries(files).filter(([file]) => !taxonomy.isExcludedPath(file));
      const expected = {
        files: perFile.length,
        bytes: perFile.reduce((sum, [, size]) => sum + size, 0),
      };

      const db = openDatabase(":memory:");
      const stats = await collectStats(db, {
        root,
        dbPath: join(root, "brain.db"),
        taxonomy,
        config: null,
        now: NOW,
      });
      db.close();

      expect(stats.size.corpus).toEqual(expected);
      // And the entry works: skipme/ is out of both, whatever its spelling.
      expect(expected).toEqual({ files: 2, bytes: 3 });
    });
  }

  test("brain.db and its journal sidecars are the index, not the corpus", async () => {
    const root = tempDir();
    const dbPath = join(root, "brain.db");
    const db = openDatabase(dbPath);
    insertDoc(db, { path: "health/a.md", type: "health", updated: "2026-06-20" });
    writeFileSync(join(root, "keep.md"), "x".repeat(42));

    const stats = await collectStats(db, {
      root,
      dbPath,
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
    });

    expect(stats.size.corpus).toEqual({ files: 1, bytes: 42 });
    // A rebuild-cost figure: the index is disposable, and its size says what
    // regenerating it buys back, not that it holds anything authoritative.
    expect(stats.size.db.bytes).toBeGreaterThan(0);
    expect(stats.size.db.tables.documents).toBe(1);
    db.close();
  });

  test("a database with no file behind it reports its size as absent", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
    });

    expect(stats.size.db.bytes).toBeNull();
    db.close();
  });

  test("the walk keeps exactly what the indexer's glob would keep", async () => {
    // Pinned because the walk was rewritten from `Glob(...).scanSync` to a
    // pruning readdir: every rule the glob applied has to survive the move.
    // A differential run over this same shape confirmed the two produce an
    // identical file set; this is the part of it that stays checked.
    const root = tempDir();
    for (const dir of [
      "notes/deep/a",
      "logs/x",         // core default exclude
      "node_modules/p", // core default exclude
      "attic/y",        // user dir exclude
      "docs/private",   // user SEGMENT exclude, below a kept directory
      ".git/objects",   // dot directory
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const body = "x".repeat(10);
    for (const file of [
      "notes/keep.md",
      "notes/deep/a/keep.md",
      "logs/x/drop.md",
      "node_modules/p/drop.js",
      "attic/y/drop.md",
      "docs/keep.md",
      "docs/private/drop.md",
      ".git/objects/drop",
      ".hidden.md",     // dot file
      "README.md",      // core default `files` exclude
      "CLAUDE.md",      // likewise
      "AGENTS.md",      // likewise
    ]) {
      writeFileSync(join(root, file), body);
    }
    // A symlink is not the corpus in either direction: its target's bytes are
    // already counted where the target lives, and a directory link is a cycle
    // waiting to happen.
    symlinkSync(join(root, "notes/keep.md"), join(root, "link-to-file.md"));
    symlinkSync(join(root, "notes"), join(root, "link-to-dir"));

    const db = openDatabase(":memory:");
    const taxonomy = buildTaxonomy({
      user: brainConfigSchema.parse({ exclude: { dirs: ["attic"], segments: ["private"] } }),
    });

    const stats = await collectStats(db, {
      root,
      dbPath: join(root, "brain.db"),
      taxonomy,
      config: null,
      now: NOW,
    });

    // notes/keep.md, notes/deep/a/keep.md, docs/keep.md — and nothing else.
    expect(stats.size.corpus).toEqual({ files: 3, bytes: 30 });
    db.close();
  });

  testUnlessRoot("an unreadable EXCLUDED directory does not cost the corpus figure", async () => {
    // Found by review: the walk used to list everything and filter afterwards,
    // so a `workspaces/` the user cannot read — a core default exclude, and a
    // real thing to find in a brain — raised EACCES out of scanSync and took
    // every other figure down with it.
    const root = tempDir();
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, "workspaces/locked"), { recursive: true });
    writeFileSync(join(root, "notes/keep.md"), "x".repeat(70));
    writeFileSync(join(root, "workspaces/locked/secret.md"), "y".repeat(500));
    chmodSync(join(root, "workspaces/locked"), 0o000);

    const db = openDatabase(":memory:");
    try {
      const stats = await collectStats(db, {
        root,
        dbPath: join(root, "brain.db"),
        taxonomy: taxonomyWith(),
        config: null,
        now: NOW,
      });
      expect(stats.size.corpus).toEqual({ files: 1, bytes: 70 });
    } finally {
      chmodSync(join(root, "workspaces/locked"), 0o755);
      db.close();
    }
  });

  testUnlessRoot("an unreadable WANTED directory makes the corpus figure absent, not short", async () => {
    const root = tempDir();
    mkdirSync(join(root, "notes/locked"), { recursive: true });
    writeFileSync(join(root, "notes/keep.md"), "x".repeat(70));
    writeFileSync(join(root, "notes/locked/more.md"), "y".repeat(500));
    chmodSync(join(root, "notes/locked"), 0o000);

    const db = openDatabase(":memory:");
    try {
      const stats = await collectStats(db, {
        root,
        dbPath: join(root, "brain.db"),
        taxonomy: taxonomyWith(),
        config: null,
        now: NOW,
      });
      // 70 bytes would be a wrong answer stated confidently.
      expect(stats.size.corpus).toBeNull();
      // And the command still produced everything else.
      expect(stats.size.db.tables.documents).toBe(0);
    } finally {
      chmodSync(join(root, "notes/locked"), 0o755);
      db.close();
    }
  });

  test("free space is absent, not 0, when the platform call fails", async () => {
    const root = tempDir();
    const db = openDatabase(":memory:");

    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config: null,
      now: NOW,
      statfs: () => {
        throw new Error("statfs unavailable on this platform");
      },
    });

    // The command still produced every other figure.
    expect(stats.size.freeBytes).toBeNull();
    expect(stats.documents).toBe(0);
    db.close();
  });

  test("freeSpaceBytes rejects a nonsensical answer rather than reporting it", () => {
    expect(freeSpaceBytes("/", () => ({ bavail: -1, bsize: 4096 }))).toBeNull();
    expect(freeSpaceBytes("/", () => ({ bavail: 10n, bsize: 4096n }))).toBe(40960);
  });
});

// ---------------------------------------------------------------------------
// The one piece of new configuration
// ---------------------------------------------------------------------------

describe("the stats config block", () => {
  test("validates, and an unknown key inside it is rejected", () => {
    expect(brainConfigSchema.safeParse({ stats: { coverageFloor: 0.5 } }).success).toBe(true);
    expect(
      brainConfigSchema.safeParse({ stats: { coverageFloor: 0.5, brokenLinkCeiling: 0.2 } }).success
    ).toBe(true);
    // .strict() — a typo must not be silently ignored.
    expect(brainConfigSchema.safeParse({ stats: { coverageFlor: 0.5 } }).success).toBe(false);
    // Ratios, not percentages.
    expect(brainConfigSchema.safeParse({ stats: { coverageFloor: 90 } }).success).toBe(false);
    expect(brainConfigSchema.safeParse({ stats: { brokenLinkCeiling: -0.1 } }).success).toBe(false);
  });

  test("the documented defaults apply when the block is missing", () => {
    expect(resolveStatsThresholds(null)).toEqual(DEFAULT_STATS_THRESHOLDS);
    expect(resolveStatsThresholds(brainConfigSchema.parse({}))).toEqual(DEFAULT_STATS_THRESHOLDS);
    expect(resolveStatsThresholds(brainConfigSchema.parse({ stats: {} }))).toEqual(
      DEFAULT_STATS_THRESHOLDS
    );
  });

  test("an explicitly-undefined level falls back instead of vanishing", () => {
    // Found by review. `stats: { coverageFloor: undefined }` is what a
    // brain.config.ts writes when a level is behind a conditional, and zod
    // keeps the key. Spreading the block over the defaults let that undefined
    // win, and JSON.stringify then dropped coverageFloor from --json
    // altogether — a field disappearing from the machine surface.
    const config = brainConfigSchema.parse({ stats: { coverageFloor: undefined } });
    expect(Object.keys(config.stats!)).toContain("coverageFloor");

    const resolved = resolveStatsThresholds(config);
    expect(resolved).toEqual(DEFAULT_STATS_THRESHOLDS);
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(DEFAULT_STATS_THRESHOLDS);
  });

  test("a configured level overrides only itself", async () => {
    const config = brainConfigSchema.parse({ stats: { coverageFloor: 0.5 } });
    expect(resolveStatsThresholds(config)).toEqual({
      coverageFloor: 0.5,
      brokenLinkCeiling: DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling,
    });

    const root = tempDir();
    const db = openDatabase(":memory:");
    const stats = await collectStats(db, {
      root,
      dbPath: ":memory:",
      taxonomy: taxonomyWith(),
      config,
      now: NOW,
    });
    expect(stats.health.thresholds.coverageFloor).toBe(0.5);
    expect(stats.health.thresholds.brokenLinkCeiling).toBe(
      DEFAULT_STATS_THRESHOLDS.brokenLinkCeiling
    );
    db.close();
  });
});
