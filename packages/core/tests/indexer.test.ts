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

import { chunkContextKey, forgetCachedEnrichment, getAssetFiles, indexAll, type IndexStats } from "../src/lib/indexer";
import { loadAssetCache, loadContextCache } from "../src/lib/indexer/caches";
import { JOURNAL_SIZE_LIMIT_BYTES, openDatabase, migrateVecSchema } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { collectStats } from "../src/lib/stats";
import { gitIgnoredMatcher } from "../src/lib/git-ignore";
import { CHUNKER_VERSION } from "../src/lib/chunker";
import type { EmbeddingProvider } from "../src/lib/seams";
import { createEnrichment, type Enrichment } from "../src/lib/enrichment";
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

/** A minimal valid document for the persona "Odysseus". */
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
  for (const failure of ["no vision", "empty reply", "whitespace reply"] as const) {
    for (const [extension, mimeType, bytes, kind] of [
      ["png", "image/png", FAKE_PNG, "Image"],
      ["pdf", "application/pdf", Buffer.from("%PDF-1.4\n%%EOF\n"), "PDF"],
    ] as const) {
      test.if(vecAvailable)(`${failure} keeps the ${kind} placeholder and retries unchanged bytes`, async () => {
        const path = `assets/harbour.${extension}`;
        const root = makeCorpus({ [path]: bytes });
        const embedded: string[] = [];
        const { embedImage: _image, embedPdf: _pdf, ...base } = makeProvider();
        const provider: EmbeddingProvider = {
          ...base,
          async embed(texts) { embedded.push(...texts); return base.embed(texts); },
        };
        let completed = 0;
        const enrichment = createEnrichment({
          id: "fake:completions",
          capabilities: { vision: failure !== "no vision" },
          async complete() { completed++; return failure === "empty reply" ? "" : " \n\t "; },
        });
        const reports: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => reports.push(args.join(" "));
        let first: IndexStats;
        try {
          first = await runIndex(root, { embeddings: true, quiet: false, provider, enrichment });
        } finally {
          console.log = log;
        }
        const db1 = await openRead(root);
        let asset: { id: number; content: string; stat_fingerprint: string; content_hash: string };
        try {
          asset = db1.prepare("SELECT id, content, stat_fingerprint, content_hash FROM documents WHERE path = ?")
            .get(path) as typeof asset;
          // First assertion: the old title fallback must fail on stored content.
          expect(asset.content).toBe(`[${kind}: ${path}]`);
          expect(db1.prepare("SELECT content FROM chunks WHERE document_id = ?").get(asset.id))
            .toEqual({ content: asset.content });
          expect(db1.prepare("SELECT content FROM documents_fts WHERE rowid = ?").get(asset.id))
            .toEqual({ content: asset.content });
          expect(db1.prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'title:harbour'").all())
            .toEqual([{ rowid: asset.id }]);
          expect(db1.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 0 });
        } finally { db1.close(); }
        expect(first.assets).toBe(1);
        expect(first.embeddings).toBe(0);
        expect(embedded).toEqual([]);
        expect(readAssetCache(root)).toEqual([]);
        expect(completed).toBe(failure === "no vision" ? 0 : 1);
        expect(reports.some((line) => line.includes(path) && line.includes("undescribed"))).toBe(true);
        expect(reports.some((line) => /no vision|lacks vision|Described:/.test(line))).toBe(false);

        const description = "A lighthouse beside the harbour entrance.";
        const retried: string[] = [];
        const second = await runIndex(root, {
          embeddings: true, provider,
          enrichment: createEnrichment({
            id: "fake:completions", capabilities: { vision: true },
            async complete(req) { retried.push(req.parts![0].kind); return `  ${description}  `; },
          }),
        });
        expect(retried).toEqual([mimeType === "application/pdf" ? "pdf" : "image"]);
        expect(second.assets).toBe(0);
        expect(second.embeddings).toBe(1);
        expect(embedded).toEqual([description]);
        const db2 = await openRead(root);
        try {
          expect(db2.prepare("SELECT id, content, stat_fingerprint, content_hash FROM documents WHERE path = ?").get(path))
            .toEqual({ ...asset, content: description });
          expect(db2.prepare("SELECT content FROM chunks WHERE document_id = ?").get(asset.id))
            .toEqual({ content: description });
          expect(db2.prepare("SELECT content FROM documents_fts WHERE rowid = ?").get(asset.id))
            .toEqual({ content: description });
          expect(db2.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 1 });
        } finally { db2.close(); }
        expect(readAssetCache(root)).toEqual([{ k: `${asset.content_hash}:assets: harbour`, v: description }]);
      });
    }
  }

  test.if(vecAvailable)("mixed nulls, errors and real descriptions deduplicate by bytes without cache poisoning", async () => {
    const absent = Buffer.concat([FAKE_PNG, Buffer.from([1])]);
    const failed = Buffer.from("%PDF-1.4\nfailed\n%%EOF\n");
    const described = Buffer.concat([FAKE_PNG, Buffer.from([2])]);
    const itinerary = Buffer.from("%PDF-1.4\nitinerary\n%%EOF\n");
    const root = makeCorpus({
      "assets/logo.png": absent, "assets/twin.png": absent,
      "assets/report.pdf": failed, "assets/copy.pdf": failed,
      "assets/shore.png": described, "assets/itinerary.pdf": itinerary,
    });
    const called: string[] = [];
    const keyOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
    const successful = new Map([
      [keyOf(described), "A diagram of the rocky shoreline."],
      [keyOf(itinerary), "assets: itinerary"], // A genuine description may equal its title.
    ]);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    let first: IndexStats;
    try {
      first = await runIndex(root, {
        embeddings: true, provider: makeProvider(),
        enrichment: createEnrichment({
          id: "fake:mixed", capabilities: { vision: true },
          async complete(req) {
            const part = req.parts![0];
            if (part.kind !== "image" && part.kind !== "pdf") throw new Error("expected image/PDF part");
            const key = keyOf(part.data);
            called.push(key);
            if (key === keyOf(failed)) throw new Error("fake describe failure");
            return successful.get(key) ?? " \t ";
          },
        }),
      });
    } finally { console.warn = warn; }
    expect(first.assets).toBe(6);
    expect(first.embeddings).toBe(2);
    expect(called.sort()).toEqual([absent, failed, described, itinerary].map(keyOf).sort());
    expect(warnings.filter((line) => line.includes("fake describe failure")).length).toBe(2);
    expect(readAssetCache(root).map((e) => e.v).sort()).toEqual([...successful.values()].sort());
    const db1 = await openRead(root);
    try {
      for (const path of ["assets/logo.png", "assets/twin.png", "assets/report.pdf", "assets/copy.pdf"]) {
        expect(db1.prepare("SELECT content FROM documents WHERE path = ?").get(path))
          .toEqual({ content: `[${path.endsWith("pdf") ? "PDF" : "Image"}: ${path}]` });
      }
      expect(db1.prepare("SELECT content FROM documents WHERE path = 'assets/itinerary.pdf'").get())
        .toEqual({ content: "assets: itinerary" });
    } finally { db1.close(); }

    const retried: string[] = [];
    const second = await runIndex(root, {
      embeddings: true, provider: makeProvider(),
      enrichment: createEnrichment({
        id: "fake:mixed", capabilities: { vision: true },
        async complete(req) {
          const part = req.parts![0];
          if (part.kind !== "image" && part.kind !== "pdf") throw new Error("expected image/PDF part");
          const key = keyOf(part.data);
          retried.push(key);
          return key === keyOf(absent) ? "A harbour logo." : "A voyage report.";
        },
      }),
    });
    expect(second.assets).toBe(0);
    expect(second.embeddings).toBe(4);
    expect(retried.sort()).toEqual([absent, failed].map(keyOf).sort());
    expect(readAssetCache(root).map((e) => e.v).sort())
      .toEqual(["A harbour logo.", "A harbour logo.", "A voyage report.", "A voyage report.", ...successful.values()].sort());
    const db2 = await openRead(root);
    try {
      expect(db2.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 6 });
      expect(db2.prepare("SELECT content FROM documents WHERE path = 'assets/shore.png'").get())
        .toEqual({ content: successful.get(keyOf(described))! });
    } finally { db2.close(); }
  });

  test.if(vecAvailable)("historical title-only caches remain until targeted forgetting resets twins and regenerates", async () => {
    const root = makeCorpus({
      "assets/logo.png": FAKE_PNG, "assets/twin.png": FAKE_PNG,
      "assets/shore.png": Buffer.concat([FAKE_PNG, Buffer.from([3])]),
    });
    await runIndex(root, { embeddings: true });
    const seed = await openRead(root);
    const rows = seed.prepare("SELECT path, content_hash, title FROM documents ORDER BY path").all() as { path: string; content_hash: string; title: string }[];
    seed.close();
    const historic = rows.map((r) => ({ k: `${r.content_hash}:${r.title}`, v: r.title }));
    writeFileSync(join(root, ".asset-cache.jsonl"), historic.map((e) => JSON.stringify(e)).sort().join("\n") + "\n");
    const before = readFileSync(join(root, ".asset-cache.jsonl"), "utf8");
    const { enrichment, described } = countingEnrichment();
    const first = await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment });
    expect(first.embeddings).toBe(3);
    expect(described).toEqual([]); // Stored strings are not classified by title equality.
    expect(readFileSync(join(root, ".asset-cache.jsonl"), "utf8")).toBe(before);

    const db = await openRead(root);
    try {
      expect(await forgetCachedEnrichment(db, root, "assets/logo.png")).toBe(2);
      for (const path of ["assets/logo.png", "assets/twin.png"]) {
        expect(db.prepare("SELECT content FROM documents WHERE path = ?").get(path))
          .toEqual({ content: `[Image: ${path}]` });
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 1 });
    } finally { db.close(); }
    const retained = historic.filter((e) => e.v === "assets: shore");
    expect(retained.length).toBe(1);
    expect(readAssetCache(root)).toEqual(retained);
    const second = await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment });
    expect(second.embeddings).toBe(2);
    expect(described.length).toBe(1); // Twins share the regeneration call.
    const regenerated = `Fake description of ${described[0]}`;
    expect(readAssetCache(root).filter((e) => e.v === regenerated).length).toBe(2);
    expect(readAssetCache(root)).toContainEqual(retained[0]);
    const after = await openRead(root);
    try {
      expect(after.prepare("SELECT content FROM documents WHERE path = 'assets/logo.png'").get())
        .toEqual({ content: regenerated });
      expect(after.prepare("SELECT content FROM documents WHERE path = 'assets/twin.png'").get())
        .toEqual({ content: regenerated });
    } finally { after.close(); }
  });

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

describe("chunk contexts get the document's summary (#427)", () => {
  test.if(vecAvailable)("the index passes the frontmatter summary to generateChunkContext", async () => {
    const body = ["zeppelin", "blimp"].flatMap((word) => [`## About ${word}`, "", `${word} `.repeat(120).trim(), ""]);
    const doc = [
      "---",
      "type: note",
      "title: Airships",
      "summary: Lighter-than-air craft, compared",
      'created: "2026-01-01"',
      'updated: "2026-01-02"',
      "---",
      "",
      ...body,
    ].join("\n");
    const root = makeCorpus({ "notes/airships.md": doc });
    const summaries: Array<string | null | undefined> = [];
    const enrichment: Enrichment = {
      ...makeEnrichment(),
      async generateChunkContext(_title, _text, heading, _content, summary) {
        summaries.push(summary);
        return `Context for ${heading}`;
      },
    };
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment });
    expect(summaries).toEqual(["Lighter-than-air craft, compared", "Lighter-than-air craft, compared"]);
  });

  test.if(!vecAvailable)("skipped — sqlite-vec unavailable in this environment", () => {});
});

describe("assets git ignores are not indexed (#433)", () => {
  /** A corpus in its own git work tree, with `ignore` as its .gitignore. */
  function gitCorpus(files: Record<string, string | Buffer>, ignore: string): string {
    const root = makeCorpus({ ...files, ".gitignore": ignore });
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    return root;
  }

  function countingDescriber(): { enrichment: Enrichment; described: string[] } {
    const described: string[] = [];
    const base = makeEnrichment();
    return {
      described,
      enrichment: {
        ...base,
        async describeAsset(buffer, mimeType, context) {
          described.push(context);
          return base.describeAsset(buffer, mimeType, context);
        },
      },
    };
  }

  async function indexedPaths(root: string): Promise<string[]> {
    const db = await openRead(root);
    const rows = db.prepare("SELECT path FROM documents ORDER BY path").all() as { path: string }[];
    db.close();
    return rows.map((r) => r.path);
  }

  const FILES = {
    "notes/alpha.md": md("Alpha", "alpha content"),
    "assets/logo.png": FAKE_PNG,
    // Other bytes than the logo's: identical bytes would share one vision
    // call (#408) and hide a call made for this one.
    "hidden/photo.png": Buffer.concat([FAKE_PNG, Buffer.from([0x01])]),
    "hidden/local.md": md("Local", "a local-only note"),
  };

  test("an ignored PNG is neither indexed nor described; ignored markdown still is", async () => {
    const root = gitCorpus(FILES, "hidden/\n");
    const counting = countingDescriber();
    await runIndex(root, { embeddings: true, provider: makeProvider(), enrichment: counting.enrichment });

    expect(counting.described).toEqual(["assets: logo"]);
    expect(await indexedPaths(root)).toEqual(["assets/logo.png", "hidden/local.md", "notes/alpha.md"]);
  });

  test("an indexed PNG that becomes ignored is removed on the next run", async () => {
    const root = gitCorpus(FILES, "");
    await runIndex(root, withEnrichment());
    expect(await indexedPaths(root)).toContain("hidden/photo.png");

    writeFileSync(join(root, ".gitignore"), "*.png\n!assets/*.png\n");
    const stats = await runIndex(root);
    expect(stats.deleted).toBe(1);
    expect(await indexedPaths(root)).toEqual(["assets/logo.png", "hidden/local.md", "notes/alpha.md"]);
  });

  test("brain stats leaves the ignored PNG out of the corpus, as the index does", async () => {
    const root = gitCorpus(FILES, "hidden/\n");
    await runIndex(root);
    const corpus = async () => {
      const db = openDatabase(join(root, "brain.db"));
      try {
        return (await collectStats(db, { root, dbPath: join(root, "brain.db"), taxonomy, config: null })).size.corpus;
      } finally {
        db.close();
      }
    };
    const withIgnored = await corpus();
    // The same tree without the ignored PNG on disk at all.
    unlinkSync(join(root, "hidden/photo.png"));
    const without = await corpus();
    expect(withIgnored).toEqual(without);
    expect(withIgnored!.files).toBe(3); // alpha.md, logo.png and local.md: ignored markdown still counts
  });

  test("outside a git work tree the PNG is indexed as before", async () => {
    const root = makeCorpus(FILES);
    expect(Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"]).exitCode).not.toBe(0);
    await runIndex(root, withEnrichment());
    expect(await indexedPaths(root)).toContain("hidden/photo.png");
  });

  // Git lists ignored paths sorted, so each case is the only ignored one: its
  // U+FEFF opens the output, where a default decoder drops it as a BOM.
  test("a leading U+FEFF in an ignored file name is part of the name", () => {
    const file = gitCorpus({ "\uFEFFphoto.png": FAKE_PNG, "photo.png": FAKE_PNG }, "/\uFEFFphoto.png\n");
    const ignoredFile = gitIgnoredMatcher(file);
    expect([ignoredFile("\uFEFFphoto.png"), ignoredFile("photo.png")]).toEqual([true, false]);
  });

  test("a leading U+FEFF in an ignored directory name is part of the name", () => {
    const dir = gitCorpus({ "\uFEFFmedia/a.png": FAKE_PNG, "media/a.png": FAKE_PNG }, "/\uFEFFmedia/\n");
    const ignoredDir = gitIgnoredMatcher(dir);
    expect([ignoredDir("\uFEFFmedia/a.png"), ignoredDir("media/a.png")]).toEqual([true, false]);
  });

  test("assets a submodule ignores are left out too", () => {
    const git = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", cwd, "-c", "protocol.file.allow=always", ...args], { stderr: "pipe" });
      expect(r.exitCode).toBe(0);
    };
    const identity = ["-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "-c", "commit.gpgsign=false"];
    const sub = makeCorpus({ ".gitignore": "hidden.png\n", "README.txt": "photo archive\n" });
    git(sub, "init", "-q");
    git(sub, "add", "-A");
    git(sub, ...identity, "commit", "-qm", "sub");

    const root = gitCorpus({ "notes/alpha.md": md("Alpha", "alpha content") }, "");
    git(root, "submodule", "add", "-q", sub, "vendor/photos");
    writeFileSync(join(root, "vendor/photos/hidden.png"), FAKE_PNG);
    writeFileSync(join(root, "vendor/photos/kept.png"), Buffer.concat([FAKE_PNG, Buffer.from([0x02])]));

    const ignored = gitIgnoredMatcher(root);
    expect([ignored("vendor/photos/hidden.png"), ignored("vendor/photos/kept.png")]).toEqual([true, false]);
    expect(getAssetFiles(root, taxonomy).map((a) => a.path)).toEqual(["vendor/photos/kept.png"]);
  });

  test("the matcher answers for files, for everything under an ignored directory, and nothing else", () => {
    const root = gitCorpus(
      { "a/b/c.png": FAKE_PNG, "a/keep.png": FAKE_PNG, "x.png": FAKE_PNG, "y.png": FAKE_PNG },
      "a/b/\nx.png\n"
    );
    const ignored = gitIgnoredMatcher(root);
    expect(["a/b/c.png", "a/b/deeper/d.png", "x.png", "a/keep.png", "y.png", "a/bb/c.png"].map(ignored)).toEqual([
      true, true, true, false, false, false,
    ]);
  });
});

describe("each document remembers its chunker version (#426)", () => {
  /** A body long enough to be its own chunk, then a two-line closing section. */
  const withStub = (title: string) =>
    [
      "---", "type: note", `title: ${title}`, 'created: "2026-01-01"', 'updated: "2026-01-02"', "---", "",
      "## Body", "", "word ".repeat(600).trim(), "",
      "## Related", "", "- [[one]]", "- [[two]]", "",
    ].join("\n");

  function rows(root: string, path: string): { version: number | null; chunks: Array<{ id: number; heading: string }> } {
    const db = new Database(join(root, "brain.db"), { readonly: true });
    const doc = db.prepare("SELECT id, chunker_version FROM documents WHERE path = ?").get(path) as {
      id: number;
      chunker_version: number | null;
    };
    const chunks = db
      .prepare("SELECT id, heading FROM chunks WHERE document_id = ? ORDER BY chunk_index")
      .all(doc.id) as Array<{ id: number; heading: string }>;
    db.close();
    return { version: doc.chunker_version, chunks };
  }

  /** Put a document back the way the previous chunker left it: version 1, the stub as its own chunk. */
  function downgrade(root: string, path: string): void {
    const db = new Database(join(root, "brain.db"));
    const { id } = db.prepare("SELECT id FROM documents WHERE path = ?").get(path) as { id: number };
    db.run("UPDATE documents SET chunker_version = 1 WHERE id = ?", [id]);
    db.run("DELETE FROM chunks WHERE document_id = ?", [id]);
    const insert = db.prepare(
      "INSERT INTO chunks (document_id, chunk_index, heading, content, token_estimate) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run(id, 0, "Body", "word ".repeat(600).trim(), 600);
    insert.run(id, 1, "Related", "- [[one]]\n- [[two]]", 5);
    db.close();
  }

  test("a document chunked by an older version is re-chunked on the next run, once", async () => {
    const root = makeCorpus({ "notes/alpha.md": withStub("Alpha") });
    await runIndex(root);
    expect(rows(root, "notes/alpha.md").chunks.map((c) => c.heading)).toEqual(["Body"]);

    downgrade(root, "notes/alpha.md");
    expect(rows(root, "notes/alpha.md").chunks.map((c) => c.heading)).toEqual(["Body", "Related"]);

    const upgraded = await runIndex(root);
    expect(upgraded).toMatchObject({ updated: 1, unchanged: 0 });
    const after = rows(root, "notes/alpha.md");
    expect(after).toMatchObject({ version: CHUNKER_VERSION });
    expect(after.chunks.map((c) => c.heading)).toEqual(["Body"]);

    expect(await runIndex(root)).toMatchObject({ updated: 0, unchanged: 1 });
    expect(rows(root, "notes/alpha.md").chunks).toEqual(after.chunks);
  });

  test("a document stamped by a newer chunker (a rollback) is re-chunked by this one", async () => {
    const root = makeCorpus({ "notes/alpha.md": withStub("Alpha") });
    await runIndex(root);
    downgrade(root, "notes/alpha.md");
    const db = new Database(join(root, "brain.db"));
    db.run("UPDATE documents SET chunker_version = ? WHERE path = 'notes/alpha.md'", [CHUNKER_VERSION + 1]);
    db.close();

    expect(await runIndex(root)).toMatchObject({ updated: 1, unchanged: 0 });
    const after = rows(root, "notes/alpha.md");
    expect(after.version).toBe(CHUNKER_VERSION);
    expect(after.chunks.map((c) => c.heading)).toEqual(["Body"]);
  });

  test("a document the upgrade run could not read keeps its old version and is re-chunked later", async () => {
    const alpha = withStub("Alpha");
    const root = makeCorpus({ "notes/alpha.md": alpha, "notes/beta.md": withStub("Beta") });
    await runIndex(root);
    downgrade(root, "notes/alpha.md");
    downgrade(root, "notes/beta.md");

    // Alpha is unreadable for the upgrade run (broken frontmatter), then comes back byte for byte.
    writeFileSync(join(root, "notes/alpha.md"), "---\ntitle: [broken\n---\n");
    await runIndex(root);
    expect(rows(root, "notes/beta.md").version).toBe(CHUNKER_VERSION);
    expect(rows(root, "notes/alpha.md").version).toBe(1);

    writeFileSync(join(root, "notes/alpha.md"), alpha);
    const later = await runIndex(root);
    expect(later).toMatchObject({ updated: 1 });
    const after = rows(root, "notes/alpha.md");
    expect(after.version).toBe(CHUNKER_VERSION);
    expect(after.chunks.map((c) => c.heading)).toEqual(["Body"]);
  });
});
