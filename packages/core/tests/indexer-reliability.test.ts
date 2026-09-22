import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase, migrateVecSchema, getMeta, setMeta } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import type { EmbeddingProvider } from "../src/lib/seams";
import { acquireEmbeddingLock } from "../src/lib/indexer/embedding-lock";
import { Database } from "bun:sqlite";

const taxonomy = buildTaxonomy({ user: null });
let vecAvailable = false;
const probe = new Database(":memory:");
try {
  const { load } = await import("sqlite-vec");
  load(probe);
  vecAvailable = true;
} catch {
  // Keep the same optional-extension policy as indexer.test.ts.
} finally { probe.close(); }
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function markdown(body: string): string {
  return `---\ntitle: Alex Example\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n${body}\n`;
}

function provider(dimensions = 16): EmbeddingProvider {
  return {
    id: `fake:${dimensions}`, dimensions,
    async embed(texts) { return texts.map(() => new Float32Array(dimensions).fill(0.1)); },
    async embedQuery() { return new Float32Array(dimensions).fill(0.1); },
  };
}

async function corpus(body = "Original content.", vectors = true) {
  const root = mkdtempSync(join(tmpdir(), "brain-index-reliability-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "example.md");
  writeFileSync(path, markdown(body));
  const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: 16 });
  cleanups.push(() => db.close());
  if (vectors && !await migrateVecSchema(db, 16)) throw new Error("sqlite-vec required for indexer runtime regressions");
  return { root, path, db, options: { root, taxonomy, quiet: true, graph: false } };
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, pending };
}

describe.skipIf(!vecAvailable)("embedding index reliability", () => {
  test("force changes dimensions in a markdown-only store, then incremental backfill is a no-op", async () => {
    const { db, options } = await corpus();
    await indexAll(db, { ...options, embeddings: true, provider: provider() });
    const changed = await indexAll(db, { ...options, embeddings: true, force: true, provider: provider(8) });
    expect(changed.embeddings).toBe(1);
    expect(getMeta(db, "embedding_dimensions")).toBe("8");
    expect((db.query("SELECT length(embedding) AS bytes FROM vec_chunks").get() as { bytes: number }).bytes).toBe(32);
    expect((await indexAll(db, { ...options, embeddings: true, provider: provider(8) })).embeddings).toBe(0);
  });

  test("an empty old-width table is recreated even if metadata already names the new provider", async () => {
    const { db, options } = await corpus();
    setMeta(db, "embedding_dimensions", "8");
    setMeta(db, "embedding_model", "fake:8");
    expect((await indexAll(db, { ...options, embeddings: true, provider: provider(8) })).embeddings).toBe(1);
  });

  test("a dimension switch re-embeds preserved assets without paying for descriptions again", async () => {
    const { db, root, options } = await corpus();
    writeFileSync(join(root, "example.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let descriptions = 0;
    const enrichment = {
      async describeAsset() { descriptions++; return "A sample image"; },
      async generateChunkContext() { return "Context"; },
    };
    await indexAll(db, { ...options, embeddings: true, provider: provider(), enrichment });
    const switched = await indexAll(db, { ...options, embeddings: true, force: true, provider: provider(8), enrichment });
    expect(descriptions).toBe(1);
    expect(switched.embeddings).toBe(2);
    expect(db.query("SELECT DISTINCT length(embedding) AS bytes FROM vec_chunks").all()).toEqual([{ bytes: 32 }]);
  });

  test("editing during embed does not insert orphan vectors and the next run backfills", async () => {
    const { db, root, path, options } = await corpus();
    const gate = barrier();
    const p = provider();
    const embed = p.embed;
    p.embed = async (texts) => { gate.enter(); await gate.pending; return embed(texts); };
    const running = indexAll(db, { ...options, embeddings: true, provider: p });
    await gate.entered;
    const writer = openDatabase(join(root, "brain.db"));
    try {
      await migrateVecSchema(writer, 16);
      writeFileSync(path, markdown("Changed while provider was running."));
      await indexAll(writer, options);
    } finally { writer.close(); gate.release(); }
    expect((await running).embeddings).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 0 });
    expect((await indexAll(db, { ...options, embeddings: true, provider: provider() })).embeddings).toBe(1);
  });

  test("a second embedding run cannot wipe or duplicate the first one's work", async () => {
    const { db, root, options } = await corpus();
    const gate = barrier();
    const p = provider();
    const embed = p.embed;
    p.embed = async (texts) => { gate.enter(); await gate.pending; return embed(texts); };
    const running = indexAll(db, { ...options, embeddings: true, provider: p });
    await gate.entered;
    const second = openDatabase(join(root, "brain.db"));
    try {
      await migrateVecSchema(second, 16);
      await expect(indexAll(second, { ...options, embeddings: true, force: true, provider: provider(8) })).rejects.toThrow("already active");
    } finally { second.close(); gate.release(); }
    expect((await running).embeddings).toBe(1);
    expect((await indexAll(db, { ...options, embeddings: true, provider: provider() })).embeddings).toBe(0);
  });

  test("results from an old provider are discarded if the store identity changes during the call", async () => {
    const { db, options } = await corpus();
    const p = provider();
    const embed = p.embed;
    p.embed = async (texts) => {
      setMeta(db, "embedding_model", "fake:replacement");
      return embed(texts);
    };
    expect((await indexAll(db, { ...options, embeddings: true, provider: p })).embeddings).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 0 });
  });

  test("a failed run releases its claim for a subsequent retry", async () => {
    const { db, options } = await corpus();
    const p = provider();
    p.embed = async (texts) => texts.map(() => new Float32Array(8));
    await expect(indexAll(db, { ...options, embeddings: true, provider: p })).rejects.toThrow("dimensions");
    expect((await indexAll(db, { ...options, embeddings: true, provider: provider() })).embeddings).toBe(1);
  });

  test("deleting an asset during describe leaves no ghost FTS row", async () => {
    const { root, db, options } = await corpus();
    const asset = join(root, "example.png");
    writeFileSync(asset, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const gate = barrier();
    const running = indexAll(db, {
      ...options, embeddings: true, provider: provider(),
      enrichment: {
        async describeAsset() { gate.enter(); await gate.pending; return "A sample image"; },
        async generateChunkContext() { return "Context"; },
      },
    });
    await gate.entered;
    try { unlinkSync(asset); await indexAll(db, options); } finally { gate.release(); }
    await running;
    expect(db.query("SELECT COUNT(*) AS n FROM documents_fts WHERE rowid NOT IN (SELECT id FROM documents)").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)").get()).toEqual({ n: 0 });
  });

  test("multi-page backfill embeds early, advances past failures, and retries only missing chunks", async () => {
    const sections = Array.from({ length: 620 }, (_, i) => `## Section ${i}\n\n${"Example content. ".repeat(40)}`).join("\n\n");
    const { db, options } = await corpus(sections);
    let generated = 0;
    let generatedAtFirstEmbed = 0;
    let first = true;
    const p = provider();
    const embed = p.embed;
    p.embed = async (texts) => {
      if (first) {
        first = false;
        generatedAtFirstEmbed = generated;
        throw new Error("Transient first-batch failure");
      }
      return embed(texts);
    };
    const stats = await indexAll(db, {
      ...options, embeddings: true, provider: p,
      enrichment: {
        async describeAsset() { return "unused"; },
        async generateChunkContext(_title, body, heading) {
          expect(body).toContain("Section 619");
          generated++;
          return `Context for ${heading}`;
        },
      },
    });
    expect(generated).toBe(620);
    // Work reaches vector storage before generating the full corpus's contexts.
    expect(generatedAtFirstEmbed).toBeGreaterThan(0);
    expect(generatedAtFirstEmbed).toBeLessThan(generated);
    expect(stats.embeddings).toBeGreaterThan(0);
    expect(stats.embeddings).toBeLessThan(620);
    const retry = await indexAll(db, { ...options, embeddings: true, provider: provider() });
    expect(retry.embeddings + stats.embeddings).toBe(620);
    expect(db.query("SELECT COUNT(*) AS n FROM vec_chunks").get()).toEqual({ n: 620 });
  });
});

test("embedding lock excludes another process and recovers after its owner dies", async () => {
  const { db, root } = await corpus("Original content.", false);
  // The child takes the real database claim, then stays alive without holding
  // a SQLite write transaction. Killing it simulates an interrupted cron run.
  const child = Bun.spawn([process.execPath, "--eval", `
    import { openDatabase } from ${JSON.stringify(import.meta.resolve("../src/lib/db.ts"))};
    import { acquireEmbeddingLock } from ${JSON.stringify(import.meta.resolve("../src/lib/indexer/embedding-lock.ts"))};
    const db = openDatabase(process.argv[1]);
    acquireEmbeddingLock(db);
    console.log("ready");
    setInterval(() => {}, 1000);
  `, join(root, "brain.db")], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    expect(() => acquireEmbeddingLock(db)).toThrow("already active");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const release = acquireEmbeddingLock(db);
  release();
  const next = acquireEmbeddingLock(db);
  // Releasing an older owner twice cannot unlock the new owner.
  release();
  expect(() => acquireEmbeddingLock(db)).toThrow("already active");
  next();
});

test("in-memory databases coordinate per handle without creating sidecars", () => {
  const first = new Database(":memory:");
  const second = new Database(":memory:");
  try {
    const releaseFirst = acquireEmbeddingLock(first);
    const releaseSecond = acquireEmbeddingLock(second);
    expect(() => acquireEmbeddingLock(first)).toThrow("already active");
    releaseFirst();
    releaseSecond();
    acquireEmbeddingLock(first)();
  } finally { first.close(); second.close(); }
});
