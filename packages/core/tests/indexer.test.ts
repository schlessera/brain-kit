import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { chunkContextKey, forgetCachedEnrichment, indexAll, type IndexStats } from "../src/lib/indexer";
import { loadAssetCache, loadContextCache } from "../src/lib/indexer/caches";
import { JOURNAL_SIZE_LIMIT_BYTES, openDatabase, migrateVecSchema } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import type { EmbeddingProvider } from "../src/lib/seams";
import type { Enrichment } from "../src/lib/enrichment";
// sqlite-vec is optional in some environments — vector-dependent tests skip
// gracefully when the extension cannot load. One probe, in vec-fixture.ts.
import { vecAvailable } from "./vec-fixture";
import { makeTempBrain, runCli } from "./cli-harness";

// In-process integration tests for the incremental indexer. The port takes
// `root` + `taxonomy` as parameters (the reference brain used module-level
// ROOT/DB_PATH constants and had to drive a subprocess), so each test builds a
// throwaway corpus in a tmpdir and calls indexAll() directly. No network is
// ever touched — the embedding provider and enrichment are deterministic fakes
// injected via IndexOptions.

const DIM = 16;
const taxonomy = buildTaxonomy({ user: null });

const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** A minimal valid document for the persona "Alex Example". */
function md(title: string, body: string): string {
  return [
    "---",
    "type: note",
    `title: ${title}`,
    'created: "2026-01-01"',
    'updated: "2026-01-02"',
    "tags: [test]",
    "---",
    "",
    "## Section",
    "",
    body,
    "",
  ].join("\n");
}

function makeCorpus(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-indexer-test-"));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** Deterministic pseudo-vector — content-independent, never from a network. */
function fakeVector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < v.length; i++) {
    v[i] = ((seed * 31 + i * 7) % 97) / 97;
  }
  return v;
}

function makeProvider(mode: "ok" | "fail-embed" = "ok", id = "fake:v1"): EmbeddingProvider {
  return {
    id,
    dimensions: DIM,
    async embed(texts) {
      if (mode === "fail-embed") throw new Error("fake embed failure");
      return texts.map((t, i) => fakeVector(t.length + i));
    },
    async embedQuery(text) {
      return fakeVector(text.length);
    },
    async embedImage(_buffer, _mimeType, description) {
      if (mode === "fail-embed") throw new Error("fake image-embed failure");
      return fakeVector(description.length + 1);
    },
    async embedPdf(_buffer, description) {
      if (mode === "fail-embed") throw new Error("fake pdf-embed failure");
      return fakeVector(description.length + 2);
    },
  };
}

function makeEnrichment(mode: "ok" | "fail-describe" = "ok"): Enrichment {
  return {
    async describeAsset(_buffer, _mimeType, context) {
      if (mode === "fail-describe") throw new Error("fake describe failure");
      return `Fake description of ${context}`;
    },
    async generateChunkContext(_docTitle, _docText, chunkHeading) {
      return `Context for ${chunkHeading}`;
    },
  };
}

interface IndexRun {
  embeddings?: boolean;
  force?: boolean;
  quiet?: boolean;
  provider?: EmbeddingProvider;
  enrichment?: Enrichment;
}

/** Open a writable db (loading sqlite-vec when available), index, close. */
async function runIndex(root: string, run: IndexRun = {}): Promise<IndexStats> {
  const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: DIM });
  if (vecAvailable) await migrateVecSchema(db, DIM);
  const stats = await indexAll(db, {
    root,
    taxonomy,
    quiet: run.quiet ?? true,
    force: run.force,
    embeddings: run.embeddings,
    provider: run.provider,
    enrichment: run.enrichment,
  });
  db.close();
  return stats;
}

/** Open a read handle with sqlite-vec loaded for vec_chunks queries. */
async function openRead(root: string): Promise<Database> {
  const db = new Database(join(root, "brain.db"));
  if (vecAvailable) {
    const { load } = await import("sqlite-vec");
    load(db);
  }
  return db;
}

function readJsonl(path: string): Array<{ k: string; v: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readAssetCache(root: string): Array<{ k: string; v: string }> {
  return readJsonl(join(root, ".asset-cache.jsonl"));
}

function readContextCache(root: string): Array<{ k: string; v: string }> {
  return readJsonl(join(root, ".context-cache.jsonl"));
}

/**
 * A document whose sections are each big enough to stay a chunk of their own,
 * so an enrichment run generates a context per chunk instead of reusing the
 * summary of a single-chunk document.
 */
function mdSections(title: string, words: string[]): string {
  const sections = words.flatMap((word) => [`## About ${word}`, "", `${word} `.repeat(120).trim(), ""]);
  return ["---", "type: note", `title: ${title}`, 'created: "2026-01-01"', 'updated: "2026-01-02"', "---", "", ...sections].join("\n");
}

/** The fake enrichment, counting its vision calls. */
function countingEnrichment(): { enrichment: Enrichment; described: string[]; contexts: string[] } {
  const described: string[] = [];
  const contexts: string[] = [];
  const base = makeEnrichment("ok");
  return {
    described,
    contexts,
    enrichment: {
      async describeAsset(buffer, mimeType, context) {
        described.push(context);
        return base.describeAsset(buffer, mimeType, context);
      },
      async generateChunkContext(docTitle, docText, chunkHeading, chunkText) {
        contexts.push(chunkHeading);
        return base.generateChunkContext(docTitle, docText, chunkHeading, chunkText);
      },
    },
  };
}

/** An embeddings run with the working fakes. */
function withEnrichment(): IndexRun {
  return { embeddings: true, provider: makeProvider(), enrichment: makeEnrichment() };
}

/** Every line of a sidecar, raw. */
function sidecarLines(root: string, file: string): string[] {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}

describe("incremental indexing (default mode)", () => {
  test("second run reports everything unchanged and keeps row ids stable", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "quixotic content about zeppelins"),
      "me/beta.md": md("Beta", "beta content about submarines"),
      "notes/gamma.md": md("Gamma", "gamma content about gliders"),
    });

    const run1 = await runIndex(root);
    expect(run1.added).toBe(3);

    const db1 = await openRead(root);
    const before = db1.prepare("SELECT id, path FROM documents ORDER BY path").all();
    db1.close();
    expect(before.length).toBe(3);

    const run2 = await runIndex(root);
    expect(run2).toMatchObject({ added: 0, updated: 0, deleted: 0, unchanged: 3 });

    const db2 = await openRead(root);
    const after = db2.prepare("SELECT id, path FROM documents ORDER BY path").all();
    db2.close();
    expect(after).toEqual(before);
  });
});

describe("force rebuild preserves assets", () => {
  test("asset documents, chunks, and FTS rows survive --force without --embeddings", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "assets/logo.png": FAKE_PNG,
    });

    // No enrichment: the asset is registered with a descriptor placeholder
    // instead of a generated description.
    const seed = await runIndex(root, { embeddings: true });
    expect(seed.assets).toBe(1);

    const db1 = await openRead(root);
    const assetBefore = db1
      .prepare("SELECT id, content FROM documents WHERE path = 'assets/logo.png'")
      .get() as { id: number; content: string } | null;
    expect(assetBefore).not.toBeNull();
    expect(assetBefore!.content).toBe("[Image: assets/logo.png]");
    db1.close();

    const force = await runIndex(root, { force: true });
    // Markdown was wiped + re-inserted (reported as updated since it existed
    // before the wipe); the asset was not touched.
    expect(force.updated).toBe(1);

    const db2 = await openRead(root);
    const assetAfter = db2
      .prepare("SELECT id, content FROM documents WHERE path = 'assets/logo.png'")
      .get() as { id: number; content: string } | null;
    expect(assetAfter).not.toBeNull();
    // Same row — not deleted and re-created
    expect(assetAfter!.id).toBe(assetBefore!.id);

    const chunkCount = db2
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?")
      .get(assetBefore!.id) as { n: number };
    expect(chunkCount.n).toBe(1);

    const ftsRow = db2
      .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE rowid = ?")
      .get(assetBefore!.id) as { n: number };
    expect(ftsRow.n).toBe(1);
    db2.close();
  });
});

describe("deletion sweep", () => {
  test("removes documents, chunks, and FTS rows for deleted markdown and assets", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha stays"),
      "notes/beta.md": md("Beta", "beta will be deleted"),
      "assets/logo.png": FAKE_PNG,
    });

    const seed = await runIndex(root, { embeddings: true });
    expect(seed.assets).toBe(1);

    const db1 = await openRead(root);
    const doomed = db1
      .prepare(
        "SELECT id, path FROM documents WHERE path IN ('notes/beta.md', 'assets/logo.png') ORDER BY path"
      )
      .all() as { id: number; path: string }[];
    expect(doomed.length).toBe(2);
    db1.close();

    unlinkSync(join(root, "notes/beta.md"));
    unlinkSync(join(root, "assets/logo.png"));

    const sweep = await runIndex(root); // plain run — no embeddings needed
    expect(sweep.deleted).toBe(2);

    const db2 = await openRead(root);
    for (const { id, path } of doomed) {
      const doc = db2.prepare("SELECT id FROM documents WHERE path = ?").get(path);
      expect(doc).toBeNull();
      const chunks = db2
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?")
        .get(id) as { n: number };
      expect(chunks.n).toBe(0);
      const fts = db2
        .prepare("SELECT COUNT(*) AS n FROM documents_fts WHERE rowid = ?")
        .get(id) as { n: number };
      expect(fts.n).toBe(0);
    }
    const alpha = db2
      .prepare("SELECT id FROM documents WHERE path = 'notes/alpha.md'")
      .get();
    expect(alpha).not.toBeNull();
    db2.close();
  });
});

describe("invalid files", () => {
  test("broken frontmatter is skipped while the rest of the run completes", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "notes/broken.md": '---\ntitle: "Unclosed\ntype: note\n---\n\nbody\n',
      "notes/untitled.md": "---\ntype: note\n---\n\nno title here\n",
      "notes/beta.md": md("Beta", "beta content"),
    });

    // Capture warnings to assert the skips are surfaced (not silent).
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await runIndex(root, { quiet: false });
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain("invalid frontmatter");
    expect(warnings.join("\n")).toContain("missing required frontmatter");

    const db = await openRead(root);
    const paths = (
      db.prepare("SELECT path FROM documents ORDER BY path").all() as { path: string }[]
    ).map((r) => r.path);
    expect(paths).toEqual(["notes/alpha.md", "notes/beta.md"]);
    db.close();
  });
});

describe("embedding provider change (mismatch requires --force)", () => {
  test.if(vecAvailable)(
    "a different provider is refused without --force, then re-embeds with it",
    async () => {
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content"),
      });

      // Seed vectors with provider A.
      const seed = await runIndex(root, { embeddings: true, provider: makeProvider("ok", "fake:A") });
      expect(seed.embeddings).toBeGreaterThan(0);

      const db1 = await openRead(root);
      const vecsA = db1.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
      const modelA = db1
        .prepare("SELECT value FROM index_metadata WHERE key = 'embedding_model'")
        .get() as { value: string };
      expect(vecsA.n).toBe(1);
      expect(modelA.value).toBe("fake:A");
      db1.close();

      // Provider B without --force: refuse silently re-embedding. Stored
      // vectors + metadata stay intact so search-engine reports the mismatch.
      const noForce = await runIndex(root, { embeddings: true, provider: makeProvider("ok", "fake:B") });
      expect(noForce.embeddings).toBe(0);

      const db2 = await openRead(root);
      const vecsStill = db2.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
      const modelStill = db2
        .prepare("SELECT value FROM index_metadata WHERE key = 'embedding_model'")
        .get() as { value: string };
      expect(vecsStill.n).toBe(1);
      expect(modelStill.value).toBe("fake:A"); // unchanged — not silently switched
      db2.close();

      // Provider B with --force: drop vectors and re-embed under B.
      const forced = await runIndex(root, {
        embeddings: true,
        force: true,
        provider: makeProvider("ok", "fake:B"),
      });
      expect(forced.embeddings).toBe(1);

      const db3 = await openRead(root);
      const vecsB = db3.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
      const modelB = db3
        .prepare("SELECT value FROM index_metadata WHERE key = 'embedding_model'")
        .get() as { value: string };
      expect(vecsB.n).toBe(1);
      expect(modelB.value).toBe("fake:B");
      db3.close();
    }
  );

  test.if(vecAvailable)(
    "a legacy bare model name re-embeds without --force and is upgraded in place",
    async () => {
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content"),
      });

      await runIndex(root, { embeddings: true, provider: makeProvider("ok", "fake:A") });

      // Rewind the metadata to the pre-namespace form a brain last embedded by
      // an older version carries. Same vectors, same model, unnamespaced name.
      const rewind = await openRead(root);
      rewind.run(
        "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('embedding_model', 'A')"
      );
      rewind.close();

      // Same provider, no --force: this must NOT be read as a provider change.
      // Before the identity fix it was, so the run refused, search-engine
      // skipped vector search, and only a paid --force re-embed cleared it.
      const next = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("ok", "fake:A"),
      });
      expect(next.embeddings).toBe(0); // nothing changed — no re-embed needed

      const after = await openRead(root);
      const vecs = after.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as {
        n: number;
      };
      const model = after
        .prepare("SELECT value FROM index_metadata WHERE key = 'embedding_model'")
        .get() as { value: string };
      expect(vecs.n).toBe(1); // vectors kept, not dropped
      expect(model.value).toBe("fake:A"); // metadata upgraded to the namespaced id
      after.close();
    }
  );

  test.if(vecAvailable)(
    "a run refused for mismatch still banks the descriptions it produced",
    async () => {
      // The refusal happens AFTER the asset phase, so a run that declines to
      // embed has still paid a vision model for its descriptions. Dropping
      // them on the floor means paying again next run. This is easy to lose
      // when the phase's "did it embed anything" answer is used to decide
      // whether the sidecar caches are written.
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content"),
      });

      // Seed vectors with provider A and no assets in play.
      await runIndex(root, { embeddings: true, provider: makeProvider("ok", "fake:A") });

      // Add an asset, then run with a DIFFERENT provider and no --force: the
      // embedding pass is refused, but the description must survive.
      mkdirSync(join(root, "media"), { recursive: true });
      writeFileSync(join(root, "media/photo.png"), FAKE_PNG);
      const refused = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("ok", "fake:B"),
        enrichment: makeEnrichment("ok"),
      });
      expect(refused.embeddings).toBe(0); // refused, as the test above pins

      const cached = readAssetCache(root);
      expect(cached.length).toBe(1);
      expect(cached[0].v).toContain("Fake description of");
    }
  );

  test.if(!vecAvailable)("skipped — sqlite-vec unavailable in this environment", () => {});
});

describe("asset cache non-poisoning", () => {
  test("a no-enrichment --embeddings run leaves no placeholder in .asset-cache.jsonl", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "assets/logo.png": FAKE_PNG,
    });

    // No provider and no enrichment: the asset is registered with a descriptor
    // placeholder, nothing is embedded, and no sidecar is written.
    await runIndex(root, { embeddings: true });

    const db = await openRead(root);
    const asset = db
      .prepare("SELECT content FROM documents WHERE path = 'assets/logo.png'")
      .get() as { content: string };
    expect(asset.content).toBe("[Image: assets/logo.png]");
    db.close();

    // The committed sidecar cache must never learn placeholders or title
    // fallbacks (the file may legitimately not exist at all).
    for (const entry of readAssetCache(root)) {
      expect(entry.v.startsWith("[Image:")).toBe(false);
      expect(entry.v.startsWith("[PDF:")).toBe(false);
      expect(entry.v).not.toBe("assets: logo");
    }
  });

  test("the sidecar rehydrates a lost brain.db even without enrichment", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "assets/logo.png": FAKE_PNG,
    });

    // A run with a working provider + enrichment banks the description.
    const first = await runIndex(root, {
      embeddings: true,
      provider: makeProvider("ok"),
      enrichment: makeEnrichment("ok"),
    });
    expect(first.assets).toBeGreaterThan(0);
    const banked = readAssetCache(root);
    expect(banked.length).toBe(1);
    expect(banked[0].v).toBe("Fake description of assets: logo");

    // Wipe the db and re-index with no provider/enrichment, so nothing can be
    // re-described — the description must come from the sidecar cache.
    unlinkSync(join(root, "brain.db"));
    await runIndex(root, { embeddings: true });

    const db = await openRead(root);
    const asset = db
      .prepare("SELECT content FROM documents WHERE path = 'assets/logo.png'")
      .get() as { content: string };
    expect(asset.content).toBe("Fake description of assets: logo");
    db.close();

    // The db was never re-saved (no provider → embedding block skipped), so the
    // sidecar is unchanged: banking it back out from the db is lossless.
    expect(readAssetCache(root)).toEqual(banked);
  });

  test("an asset deleted from the corpus loses its sidecar entry", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "assets/logo.png": FAKE_PNG,
    });

    const first = await runIndex(root, {
      embeddings: true,
      provider: makeProvider("ok"),
      enrichment: makeEnrichment("ok"),
    });
    expect(first.assets).toBeGreaterThan(0);
    expect(readAssetCache(root).length).toBe(1);

    // Keys are content-hash-derived, so a deleted asset strands its old key.
    // Those are evicted, not hoarded — a shrinking cache is expected.
    unlinkSync(join(root, "assets/logo.png"));
    await runIndex(root, { embeddings: true, provider: makeProvider("ok") });

    expect(readAssetCache(root)).toEqual([]);
  });
});

describe("stat-fingerprint fast path", () => {
  test("touching an asset updates the fingerprint without re-registering it", async () => {
    const root = makeCorpus({
      "notes/alpha.md": md("Alpha", "alpha content"),
      "assets/logo.png": FAKE_PNG,
    });

    await runIndex(root, { embeddings: true });

    const db1 = await openRead(root);
    const before = db1
      .prepare(
        "SELECT id, stat_fingerprint, indexed_at, content_hash FROM documents WHERE path = 'assets/logo.png'"
      )
      .get() as { id: number; stat_fingerprint: string; indexed_at: string; content_hash: string };
    expect(before.stat_fingerprint).not.toBeNull();
    db1.close();

    // Same bytes, new mtime.
    const touched = new Date(Date.now() + 5000);
    utimesSync(join(root, "assets/logo.png"), touched, touched);

    const run = await runIndex(root, { embeddings: true });
    expect(run.assets).toBe(0); // not re-registered

    const db2 = await openRead(root);
    const after = db2
      .prepare(
        "SELECT id, stat_fingerprint, indexed_at, content_hash FROM documents WHERE path = 'assets/logo.png'"
      )
      .get() as { id: number; stat_fingerprint: string; indexed_at: string; content_hash: string };
    expect(after.id).toBe(before.id);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.indexed_at).toBe(before.indexed_at); // no INSERT OR REPLACE happened
    expect(after.stat_fingerprint).not.toBe(before.stat_fingerprint); // fast path recorded
    db2.close();
  });
});

describe("frontmatter date handling", () => {
  test("unquoted YAML dates are stored as YYYY-MM-DD", async () => {
    const root = makeCorpus({
      "notes/dated.md": [
        "---",
        "type: note",
        "title: Dated",
        "created: 2026-01-15", // unquoted — gray-matter parses these into Date objects
        "updated: 2026-02-20",
        "deadline: 2026-03-01",
        "tags: [test]",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    });

    await runIndex(root);

    const db = await openRead(root);
    const doc = db
      .prepare("SELECT created, updated, deadline FROM documents WHERE path = 'notes/dated.md'")
      .get() as { created: string; updated: string; deadline: string };
    expect(doc.created).toBe("2026-01-15");
    expect(doc.updated).toBe("2026-02-20");
    expect(doc.deadline).toBe("2026-03-01");
    db.close();
  });
});

describe("provider failure semantics (fake provider)", () => {
  test.if(vecAvailable)(
    "failed describeAsset keeps the placeholder, never poisons the cache, and self-heals next run",
    async () => {
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content"),
        "assets/logo.png": FAKE_PNG,
      });

      const first = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("ok"),
        enrichment: makeEnrichment("fail-describe"),
      });
      expect(first.assets).toBe(1);

      const db1 = await openRead(root);
      const asset1 = db1
        .prepare("SELECT id, content FROM documents WHERE path = 'assets/logo.png'")
        .get() as { id: number; content: string };
      // Description failed → placeholder persisted, never fallback junk.
      expect(asset1.content).toBe("[Image: assets/logo.png]");
      db1.close();

      for (const entry of readAssetCache(root)) {
        expect(entry.v.startsWith("[Image:")).toBe(false);
        expect(entry.v).not.toBe("assets: logo");
      }

      // Second run with a working enrichment: the self-heal queue retries the
      // description even though the file bytes are unchanged.
      const second = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("ok"),
        enrichment: makeEnrichment("ok"),
      });
      expect(second.assets).toBe(0); // not re-registered — self-healed in place

      const db2 = await openRead(root);
      const asset2 = db2
        .prepare("SELECT id, content FROM documents WHERE path = 'assets/logo.png'")
        .get() as { id: number; content: string };
      expect(asset2.id).toBe(asset1.id);
      expect(asset2.content).toBe("Fake description of assets: logo");
      const chunk = db2
        .prepare("SELECT content FROM chunks WHERE document_id = ? AND chunk_index = 0")
        .get(asset2.id) as { content: string };
      expect(chunk.content).toBe("Fake description of assets: logo");
      db2.close();

      const values = readAssetCache(root).map((e) => e.v);
      expect(values).toContain("Fake description of assets: logo");
    }
  );

  test.if(vecAvailable)(
    "failed embed batches leave no vectors; the next run backfills every missing one",
    async () => {
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content about airships"),
        "notes/beta.md": md("Beta", "beta content about railways"),
        "assets/logo.png": FAKE_PNG,
      });

      const first = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("fail-embed"),
        enrichment: makeEnrichment("ok"),
      });
      expect(first.embeddings).toBe(0);

      const db1 = await openRead(root);
      const vecs1 = db1.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
      expect(vecs1.n).toBe(0);
      // Descriptions succeeded even though embedding failed.
      const asset1 = db1
        .prepare("SELECT content FROM documents WHERE path = 'assets/logo.png'")
        .get() as { content: string };
      expect(asset1.content).toBe("Fake description of assets: logo");
      db1.close();

      // Self-healing backfill: with no file changes at all, the next run embeds
      // every chunk that lacks a vector.
      const second = await runIndex(root, {
        embeddings: true,
        provider: makeProvider("ok"),
        enrichment: makeEnrichment("ok"),
      });
      expect(second.added).toBe(0);
      expect(second.updated).toBe(0);

      const db2 = await openRead(root);
      const chunks = db2.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
      const vecs2 = db2.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
      expect(chunks.n).toBeGreaterThan(0);
      expect(vecs2.n).toBe(chunks.n);
      expect(second.embeddings).toBe(chunks.n);
      db2.close();
    }
  );

  test.if(vecAvailable)(
    "a provider without embedImage or embedPdf embeds each asset's description through embed()",
    async () => {
      // The EmbeddingProvider contract's degradation promise, on core's side
      // (#342): the published suite can only check that such a provider's
      // embed() yields a vector for a description; this checks that core sends it one.
      const root = makeCorpus({
        "notes/alpha.md": md("Alpha", "alpha content"),
        "assets/logo.png": FAKE_PNG,
        "assets/itinerary.pdf": "%PDF-1.4\n%%EOF\n",
      });
      const { embedImage: _image, embedPdf: _pdf, ...textOnly } = makeProvider("ok");
      const calls: string[][] = [];
      const provider: EmbeddingProvider = {
        ...textOnly,
        async embed(texts) {
          calls.push(texts);
          return textOnly.embed(texts);
        },
      };

      const stats = await runIndex(root, {
        embeddings: true,
        provider,
        enrichment: makeEnrichment("ok"),
      });
      expect(stats.assets).toBe(2);

      const descriptions = [
        "Fake description of assets: itinerary",
        "Fake description of assets: logo",
      ];
      const alone = calls.filter((texts) => texts.length === 1).map(([text]) => text);
      expect(descriptions.filter((d) => !alone.includes(d))).toEqual([]);

      const db = await openRead(root);
      const assetVectors = db
        .prepare(
          `SELECT COUNT(*) AS n FROM vec_chunks v
             JOIN chunks c ON c.id = v.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE d.asset_type != 'markdown'`
        )
        .get() as { n: number };
      db.close();
      expect(assetVectors.n).toBe(2);
    }
  );

  test.if(!vecAvailable)("skipped — sqlite-vec unavailable in this environment", () => {});
});


describe("sidecar cache pruning", () => {
  test("an entry whose asset is gone is dropped, and live ones are kept", async () => {
    const root = makeCorpus({
      "note.md": md("Note", "Body text."),
      "assets/logo.png": FAKE_PNG,
    });
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: makeEnrichment() });

    const cachePath = join(root, ".asset-cache.jsonl");
    const before = readFileSync(cachePath, "utf-8").split("\n").filter(Boolean);
    // Stands in for an asset deleted before this run: the key is unreachable,
    // which is the only property being tested.
    writeFileSync(
      cachePath,
      [...before, JSON.stringify({ k: "deadbeef:Gone", v: "a description of nothing" })].join("\n") + "\n"
    );

    await runIndex(root);

    const after = readFileSync(cachePath, "utf-8");
    expect(after).not.toContain("deadbeef:Gone");
    expect(after).not.toContain("a description of nothing");
    for (const line of before) expect(after).toContain(line);
  });

  test("deleting an asset removes its description from the tracked cache", async () => {
    const root = makeCorpus({
      "note.md": md("Note", "Body text."),
      "assets/logo.png": FAKE_PNG,
    });
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: makeEnrichment() });
    expect(readFileSync(join(root, ".asset-cache.jsonl"), "utf-8").trim()).not.toBe("");

    unlinkSync(join(root, "assets/logo.png"));
    await runIndex(root);

    // The whole point: a deletion is a deletion, without needing an
    // --embeddings pass to notice.
    expect(readFileSync(join(root, ".asset-cache.jsonl"), "utf-8").trim()).toBe("");
  });

  test("a run with nothing to prune leaves the file byte-identical", async () => {
    // content-hygiene relies on a no-op index producing no git diff.
    const root = makeCorpus({ "note.md": mdSections("Note", ["zeppelin", "blimp"]) });
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: makeEnrichment() });

    const cachePath = join(root, ".context-cache.jsonl");
    const before = readFileSync(cachePath, "utf-8");
    await runIndex(root);
    expect(readFileSync(cachePath, "utf-8")).toBe(before);
  });

  test("a malformed line is left alone rather than silently discarded", async () => {
    const root = makeCorpus({ "note.md": md("Note", "Body text.") });
    await runIndex(root);
    const cachePath = join(root, ".asset-cache.jsonl");
    writeFileSync(cachePath, "not json at all\n");
    await runIndex(root);
    expect(readFileSync(cachePath, "utf-8")).toContain("not json at all");
  });
});

describe("sidecar caches are appended, never rebuilt (#408)", () => {
  test("a committed value survives a run whose database generated another", async () => {
    const root = makeCorpus({ "notes/airships.md": mdSections("Airships", ["zeppelin", "blimp"]) });
    await runIndex(root, withEnrichment());
    const generated = readContextCache(root);
    expect(generated.length).toBe(2);
    const key = generated[0].k;

    // Another clone generated "A" for this key and committed it. This clone's
    // database still holds its own text for the same chunk.
    const committed = generated.map((e) => (e.k === key ? { k: key, v: "A" } : e));
    writeFileSync(
      join(root, ".context-cache.jsonl"),
      committed.map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const db = await openRead(root);
    const stored = db.prepare("SELECT context FROM chunks WHERE context = ?").get(generated[0].v);
    db.close();
    expect(stored).not.toBeNull();

    await runIndex(root, withEnrichment());

    const lines = readContextCache(root).filter((e) => e.k === key);
    expect(lines).toEqual([{ k: key, v: "A" }]);
  });

  test("an embeddings run with nothing new leaves both files byte-identical and unwritten", async () => {
    const root = makeCorpus({
      "notes/airships.md": mdSections("Airships", ["zeppelin", "blimp"]),
      "assets/logo.png": FAKE_PNG,
    });
    await runIndex(root, withEnrichment());

    const files = [".context-cache.jsonl", ".asset-cache.jsonl"].map((f) => join(root, f));
    const past = new Date("2026-01-01T00:00:00Z");
    const before = files.map((f) => {
      utimesSync(f, past, past);
      return { bytes: readFileSync(f, "utf-8"), mtime: statSync(f).mtimeMs };
    });
    expect(before.every((b) => b.bytes.trim() !== "")).toBe(true);

    await runIndex(root, withEnrichment());

    const after = files.map((f) => ({ bytes: readFileSync(f, "utf-8"), mtime: statSync(f).mtimeMs }));
    expect(after).toEqual(before);
  });

  test.if(vecAvailable)("an embeddings run refused for a provider mismatch removes no line", async () => {
    const root = makeCorpus({
      "notes/airships.md": mdSections("Airships", ["zeppelin", "blimp"]),
      "assets/logo.png": FAKE_PNG,
    });
    await runIndex(root, { embeddings: true, provider: makeProvider("ok", "fake:A"), enrichment: makeEnrichment() });

    // Another clone indexed a document this one has not generated contexts
    // for yet, and committed its lines.
    const doc = mdSections("Railways", ["locomotive", "tender"]);
    const other = makeCorpus({ "notes/railways.md": doc });
    await runIndex(other, withEnrichment());
    const theirs = sidecarLines(other, ".context-cache.jsonl");
    expect(theirs.length).toBe(2);
    const ours = sidecarLines(root, ".context-cache.jsonl");
    writeFileSync(join(root, ".context-cache.jsonl"), [...ours, ...theirs].sort().join("\n") + "\n");
    writeFileSync(join(root, "notes/railways.md"), doc);
    const before = {
      contexts: sidecarLines(root, ".context-cache.jsonl"),
      assets: sidecarLines(root, ".asset-cache.jsonl"),
    };
    expect(before.assets.length).toBe(1);

    const refused = await runIndex(root, {
      embeddings: true,
      provider: makeProvider("ok", "fake:B"),
      enrichment: makeEnrichment(),
    });
    expect(refused.embeddings).toBe(0);

    expect(sidecarLines(root, ".context-cache.jsonl")).toEqual(before.contexts);
    expect(sidecarLines(root, ".asset-cache.jsonl")).toEqual(before.assets);
  });

  test("byte-identical assets under two titles in one run are described once", async () => {
    const root = makeCorpus({
      "assets/logo.png": FAKE_PNG,
      "assets/logo-copy.png": FAKE_PNG,
    });
    const counting = countingEnrichment();
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });

    expect(counting.described.length).toBe(1);
    const db = await openRead(root);
    const rows = db
      .prepare("SELECT content FROM documents WHERE asset_type != 'markdown' ORDER BY path")
      .all() as { content: string }[];
    db.close();
    expect(rows.map((r) => r.content)).toEqual([
      `Fake description of ${counting.described[0]}`,
      `Fake description of ${counting.described[0]}`,
    ]);
  });

  test("a second copy of an asset is described from the first one's cache entry", async () => {
    const root = makeCorpus({ "assets/logo.png": FAKE_PNG });
    const counting = countingEnrichment();
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });
    expect(counting.described).toEqual(["assets: logo"]);

    writeFileSync(join(root, "assets/emblem.png"), FAKE_PNG);
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });

    expect(counting.described).toEqual(["assets: logo"]);
    const db = await openRead(root);
    const emblem = db.prepare("SELECT content FROM documents WHERE path = 'assets/emblem.png'").get() as {
      content: string;
    };
    db.close();
    expect(emblem.content).toBe("Fake description of assets: logo");
  });

  test("an asset whose title rule changed keeps its description", async () => {
    const root = makeCorpus({ "assets/logo.png": FAKE_PNG });
    await runIndex(root, withEnrichment());
    const [entry] = readAssetCache(root);
    const hash = entry.k.slice(0, entry.k.indexOf(":"));

    // The same bytes, titled by another version's rule.
    const renamed = { k: `${hash}:Logo (old rule)`, v: "Described under the old rule" };
    writeFileSync(join(root, ".asset-cache.jsonl"), JSON.stringify(renamed) + "\n");
    await runIndex(root);

    expect(readAssetCache(root)).toEqual([renamed]);
  });

  test("a key that appears twice loads as its first line in sorted order, whichever line comes first in the file", () => {
    const root = makeCorpus({});
    const contextKey = "0".repeat(64);
    const assetKey = `${"f".repeat(64)}:T`;
    const loaders = [
      { file: ".context-cache.jsonl", key: contextKey, load: loadContextCache },
      { file: ".asset-cache.jsonl", key: assetKey, load: loadAssetCache },
    ];
    const orders = [
      ["Z", "A"],
      ["A", "Z"],
    ];
    const loaded: string[] = [];
    for (const { file, key, load } of loaders) {
      for (const order of orders) {
        writeFileSync(join(root, file), order.map((v) => JSON.stringify({ k: key, v })).join("\n") + "\n");
        loaded.push(`${file} ${order.join("")}: ${load(root).get(key)}`);
      }
    }
    expect(loaded).toEqual([
      ".context-cache.jsonl ZA: A",
      ".context-cache.jsonl AZ: A",
      ".asset-cache.jsonl ZA: A",
      ".asset-cache.jsonl AZ: A",
    ]);
  });

  test("a write collapses a duplicated key to its first line in sorted order", async () => {
    const root = makeCorpus({ "notes/airships.md": mdSections("Airships", ["zeppelin", "blimp"]) });
    await runIndex(root, withEnrichment());
    const [first, second] = readContextCache(root);

    // A union merge left two lines for one key, "Z" before "A" in file order,
    // and lost the other key, so the next run has one to add and must write.
    const key = first.k;
    writeFileSync(
      join(root, ".context-cache.jsonl"),
      [JSON.stringify({ k: key, v: "Z" }), JSON.stringify({ k: key, v: "A" })].join("\n") + "\n"
    );

    await runIndex(root, withEnrichment());
    expect(readContextCache(root)).toEqual([{ k: key, v: "A" }, second].sort((a, b) => (a.k < b.k ? -1 : 1)));
  });
});

describe("brain index --forget-cache (#408)", () => {
  test("removes exactly one document's lines, reports the count, and the next run regenerates them", async () => {
    const root = makeTempBrain();
    fixtures.push(root);
    const doc = "notes/airships-forget.md";
    writeFileSync(join(root, doc), mdSections("Airships", ["zeppelin", "blimp", "dirigible"]));
    await runIndex(root, withEnrichment());

    const db = await openRead(root);
    const chunks = db
      .prepare(
        "SELECT c.heading, c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ?"
      )
      .all(doc) as { heading: string; content: string }[];
    db.close();
    expect(chunks.length).toBe(3);
    const ours = new Set(chunks.map((c) => chunkContextKey("Airships", c.heading, c.content)));
    const before = readContextCache(root);
    expect(before.filter((e) => ours.has(e.k)).length).toBe(3);
    expect(before.filter((e) => !ours.has(e.k)).length).toBeGreaterThan(0);

    const result = await runCli(root, ["index", "--forget-cache", doc, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: doc, forgotten: 3 });
    const after = readContextCache(root);
    expect(after).toEqual(before.filter((e) => !ours.has(e.k)));

    const counting = countingEnrichment();
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });
    expect(counting.contexts.sort()).toEqual(["About blimp", "About dirigible", "About zeppelin"]);
    expect(readContextCache(root)).toEqual(before);
  }, 60_000);

  test("an unindexed path is a usage error", async () => {
    const root = makeTempBrain();
    fixtures.push(root);
    const result = await runCli(root, ["index", "--forget-cache", "notes/nowhere.md", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No indexed document found at: notes/nowhere.md");
  });

  test("forgetting a document also resets another document whose chunks share its keys", async () => {
    // A context key is title + heading + text, with no path in it.
    const twin = mdSections("Airships", ["zeppelin", "blimp"]);
    const root = makeCorpus({ "notes/airships.md": twin, "me/airships.md": twin });
    await runIndex(root, withEnrichment());
    expect(readContextCache(root).map((e) => e.v).sort()).toEqual(["Context for About blimp", "Context for About zeppelin"]);

    const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: DIM });
    const withContext = db
      .prepare("SELECT d.path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.context IS NOT NULL ORDER BY d.path")
      .all();
    expect(withContext).toEqual([
      { path: "me/airships.md" },
      { path: "me/airships.md" },
      { path: "notes/airships.md" },
      { path: "notes/airships.md" },
    ]);
    expect(await forgetCachedEnrichment(db, root, "notes/airships.md")).toBe(2);
    const stale = db
      .prepare("SELECT d.path, c.context FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.context IS NOT NULL")
      .all();
    db.close();
    expect(stale).toEqual([]);

    const fresh: Enrichment = {
      ...makeEnrichment(),
      async generateChunkContext(_docTitle, _docText, chunkHeading) {
        return `Regenerated for ${chunkHeading}`;
      },
    };
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: fresh });
    expect(readContextCache(root).map((e) => e.v).sort()).toEqual([
      "Regenerated for About blimp",
      "Regenerated for About zeppelin",
    ]);
  });

  test("forgetting an asset resets every copy of its bytes and the next run describes them once", async () => {
    const root = makeCorpus({
      "notes/airships.md": mdSections("Airships", ["zeppelin", "blimp"]),
      "assets/logo.png": FAKE_PNG,
      "assets/emblem.png": FAKE_PNG,
    });
    await runIndex(root, withEnrichment());
    const contexts = sidecarLines(root, ".context-cache.jsonl");
    expect(readAssetCache(root).length).toBe(2);

    const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: DIM });
    const forgotten = await forgetCachedEnrichment(db, root, "assets/logo.png");
    const rows = db
      .prepare("SELECT path, content FROM documents WHERE asset_type != 'markdown' ORDER BY path")
      .all();
    db.close();
    expect(forgotten).toBe(2);
    expect(readAssetCache(root)).toEqual([]);
    expect(sidecarLines(root, ".context-cache.jsonl")).toEqual(contexts);
    expect(rows).toEqual([
      { path: "assets/emblem.png", content: "[Image: assets/emblem.png]" },
      { path: "assets/logo.png", content: "[Image: assets/logo.png]" },
    ]);

    const counting = countingEnrichment();
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });
    expect(counting.described.length).toBe(1);
    expect(readAssetCache(root).length).toBe(2);
  });
});

describe("the WAL after an index run (#423)", () => {
  /** Enough text that indexing it writes several MB through the WAL. */
  function bulkyCorpus(): string {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) {
      const words = Array.from({ length: 3000 }, (_, j) => `word${(i * 7919 + j * 104729) % 50021}`);
      files[`notes/bulk-${i}.md`] = md(`Bulk ${i}`, words.join(" "));
    }
    return makeCorpus(files);
  }

  function walBytes(root: string): number {
    const wal = join(root, "brain.db-wal");
    return existsSync(wal) ? statSync(wal).size : 0;
  }

  test("a writable connection caps the journal at JOURNAL_SIZE_LIMIT_BYTES", () => {
    const root = makeCorpus({});
    const db = openDatabase(join(root, "brain.db"));
    const { journal_size_limit } = db.prepare("PRAGMA journal_size_limit").get() as { journal_size_limit: number };
    db.close();
    expect(journal_size_limit).toBe(JOURNAL_SIZE_LIMIT_BYTES);
  });

  test("with another connection open and idle, the run leaves an empty WAL", async () => {
    const root = bulkyCorpus();
    const idle = openDatabase(join(root, "brain.db"));
    try {
      const stats = await runIndex(root);
      expect(stats.added).toBe(120);
      // The idle connection keeps the WAL file from being removed on close,
      // so its size is what the checkpoint left behind.
      expect(existsSync(join(root, "brain.db-wal"))).toBe(true);
      expect(walBytes(root)).toBe(0);
    } finally {
      idle.close();
    }
  });

  test.if(vecAvailable)("a run that fails after committing markdown still truncates the WAL, and rethrows its own error", async () => {
    const root = bulkyCorpus();
    const dbPath = join(root, "brain.db");
    const idle = openDatabase(dbPath);
    const db = openDatabase(dbPath, { embeddingDimensions: DIM });
    try {
      await migrateVecSchema(db, DIM);
      db.run("PRAGMA busy_timeout=1234");
      // The embedding phase reads the provider's id after markdown is
      // persisted; this one fails there, as a broken provider would.
      const provider = {
        ...makeProvider(),
        get id(): string {
          throw new Error("injected failure after the markdown commit");
        },
      } as EmbeddingProvider;
      await expect(
        indexAll(db, { root, taxonomy, quiet: true, embeddings: true, provider })
      ).rejects.toThrow("injected failure after the markdown commit");

      expect((idle.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(120);
      expect(walBytes(root)).toBe(0);
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
    } finally {
      db.close();
      idle.close();
    }
  });

  test("a reader holding a transaction open makes the checkpoint busy, not the run", async () => {
    const root = bulkyCorpus();
    await runIndex(root);
    writeFileSync(join(root, "notes/bulk-0.md"), md("Bulk 0", "rewritten so the run writes"));

    const reader = openDatabase(join(root, "brain.db"));
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      reader.run("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM documents").get();
      const started = Date.now();
      const stats = await runIndex(root, { quiet: false });
      expect(stats.updated).toBe(1);
      expect(Date.now() - started).toBeLessThan(4000); // did not wait out the busy timeout
      expect(logged.filter((line) => line.includes("WAL checkpoint"))).toEqual([
        "WAL checkpoint busy: another connection holds a lock; the WAL is left for a later run",
      ]);
      expect(walBytes(root)).toBeGreaterThan(0);
    } finally {
      console.log = log;
      reader.run("ROLLBACK");
      reader.close();
    }
  });
});

describe("an unchanged chunk keeps its vector (#417)", () => {
  /** The working fake provider, recording every text it is asked to embed. */
  function countingProvider(id = "fake:v1"): { provider: EmbeddingProvider; embedded: string[] } {
    const embedded: string[] = [];
    const base = makeProvider("ok", id);
    return {
      embedded,
      provider: {
        ...base,
        async embed(texts) {
          embedded.push(...texts);
          return base.embed(texts);
        },
      },
    };
  }

  const THREE = ["zeppelin", "blimp", "dirigible"];
  const doc = mdSections("Airships", THREE);
  /** The same document with the blimp section's text changed. */
  const edited = doc.replace("blimp ".repeat(120).trim(), `${"blimp ".repeat(119)}airship`);

  async function chunkIds(root: string): Promise<Record<string, number>> {
    const db = await openRead(root);
    const rows = db.prepare("SELECT id, heading FROM chunks ORDER BY chunk_index").all() as { id: number; heading: string }[];
    db.close();
    return Object.fromEntries(rows.map((r) => [r.heading, r.id]));
  }

  async function vectorCount(root: string): Promise<number> {
    const db = await openRead(root);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
    db.close();
    return n;
  }

  test.if(vecAvailable)("editing one of three sections embeds that section alone", async () => {
    expect(edited).not.toBe(doc);
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());
    const before = await chunkIds(root);
    expect(Object.keys(before)).toEqual(["About zeppelin", "About blimp", "About dirigible"]);
    expect(await vectorCount(root)).toBe(3);

    writeFileSync(join(root, "notes/airships.md"), edited);
    const counting = countingProvider();
    const stats = await runIndex(root, { embeddings: true, provider: counting.provider, enrichment: makeEnrichment() });

    expect(counting.embedded.length).toBe(1);
    expect(counting.embedded[0]).toContain("airship");
    expect(stats.updated).toBe(1);
    expect(stats.embeddings).toBe(1);
    const after = await chunkIds(root);
    expect(after["About zeppelin"]).toBe(before["About zeppelin"]);
    expect(after["About dirigible"]).toBe(before["About dirigible"]);
    expect(after["About blimp"]).not.toBe(before["About blimp"]);
    expect(await vectorCount(root)).toBe(3);
  });

  test.if(vecAvailable)("an edit that archives a document updates its kept vectors' filter columns", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());
    writeFileSync(join(root, "notes/airships.md"), doc.replace("type: note", "type: note\nstatus: archived"));
    const counting = countingProvider();
    await runIndex(root, { embeddings: true, provider: counting.provider, enrichment: makeEnrichment() });

    expect(counting.embedded).toEqual([]);
    const db = await openRead(root);
    const flags = db.prepare("SELECT is_archived FROM vec_chunks ORDER BY chunk_id").all();
    db.close();
    expect(flags).toEqual([{ is_archived: 1 }, { is_archived: 1 }, { is_archived: 1 }]);
  });

  test.if(vecAvailable)("a title-only edit re-embeds every chunk, incrementally and under --force", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());
    const before = await chunkIds(root);

    // The title is part of every chunk's embedding text.
    writeFileSync(join(root, "notes/airships.md"), doc.replace("title: Airships", "title: Lighter than air"));
    const incremental = countingProvider();
    await runIndex(root, { embeddings: true, provider: incremental.provider, enrichment: makeEnrichment() });
    expect(incremental.embedded.length).toBe(3);
    expect(incremental.embedded.every((text) => text.startsWith("[Lighter than air]"))).toBe(true);
    const after = await chunkIds(root);
    for (const heading of Object.keys(before)) expect(after[heading]).not.toBe(before[heading]);

    // A later --force carries only vectors embedded under the current title.
    const forced = countingProvider();
    await runIndex(root, { embeddings: true, force: true, provider: forced.provider, enrichment: makeEnrichment() });
    expect(forced.embedded).toEqual([]);
  });

  test.if(vecAvailable)("an edit indexed while sqlite-vec was unavailable has its vectors' filters repaired later", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());

    // Archived and retyped, text unchanged, indexed on a connection that
    // never loaded the extension: the kept vectors cannot be touched then.
    writeFileSync(
      join(root, "notes/airships.md"),
      doc.replace("type: note", "type: context\nstatus: archived")
    );
    const bare = openDatabase(join(root, "brain.db"), { embeddingDimensions: DIM });
    const stats = await indexAll(bare, { root, taxonomy, quiet: true });
    bare.close();
    expect(stats.updated).toBe(1);

    const filters = async () => {
      const db = await openRead(root);
      const rows = db.prepare("SELECT is_archived, doc_type FROM vec_chunks ORDER BY chunk_id").all();
      db.close();
      return rows;
    };
    const stale = { is_archived: 0, doc_type: "note" };
    expect(await filters()).toEqual([stale, stale, stale]);

    // The next run that can load it, embeddings or not, repairs them.
    await runIndex(root);
    const fresh = { is_archived: 1, doc_type: "context" };
    expect(await filters()).toEqual([fresh, fresh, fresh]);
  });

  test.if(vecAvailable)("a brain with the extension loaded and no vector table indexes an edit", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    const index = async () => {
      const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: DIM });
      try {
        const { load } = await import("sqlite-vec");
        load(db);
        return await indexAll(db, { root, taxonomy, quiet: true });
      } finally {
        db.close();
      }
    };
    expect((await index()).added).toBe(1);
    writeFileSync(join(root, "notes/airships.md"), edited.replace("type: note", "type: note\nstatus: archived"));
    expect((await index()).updated).toBe(1);
    const db = new Database(join(root, "brain.db"), { readonly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_chunks'").get();
    db.close();
    expect(table).toBeNull();
  });

  test.if(vecAvailable)("--force with the same provider reuses every unchanged vector", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());

    const counting = countingProvider();
    const stats = await runIndex(root, {
      embeddings: true,
      force: true,
      provider: counting.provider,
      enrichment: makeEnrichment(),
    });

    expect(counting.embedded).toEqual([]);
    expect(stats.embeddings).toBe(3); // written back from the carried vectors
    expect(await vectorCount(root)).toBe(3);
  });

  test.if(vecAvailable)("--force with a different provider re-embeds everything", async () => {
    const root = makeCorpus({ "notes/airships.md": doc });
    await runIndex(root, withEnrichment());

    const counting = countingProvider("fake:other");
    const stats = await runIndex(root, {
      embeddings: true,
      force: true,
      provider: counting.provider,
      enrichment: makeEnrichment(),
    });

    expect(counting.embedded.length).toBe(3);
    expect(stats.embeddings).toBe(3);
  });

  test.if(!vecAvailable)("skipped — sqlite-vec unavailable in this environment", () => {});
});
