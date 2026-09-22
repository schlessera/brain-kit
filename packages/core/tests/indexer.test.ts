import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { indexAll, type IndexStats } from "../src/lib/indexer";
import { openDatabase, migrateVecSchema } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import type { EmbeddingProvider } from "../src/lib/seams";
import type { Enrichment } from "../src/lib/enrichment";
// sqlite-vec is optional in some environments — vector-dependent tests skip
// gracefully when the extension cannot load. One probe, in vec-fixture.ts.
import { vecAvailable } from "./vec-fixture";

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
    const root = makeCorpus({ "note.md": md("Note", "Body text.") });
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
