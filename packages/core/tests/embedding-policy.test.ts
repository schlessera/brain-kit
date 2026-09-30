import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { audit, loadAuditDocs } from "../src/lib/auditor";
import { brainConfigSchema, type BrainConfig } from "../src/lib/config";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import { createEnrichment } from "../src/lib/enrichment";
import { indexAll } from "../src/lib/indexer";
import { chunkContextKey, loadContextCache } from "../src/lib/indexer/caches";
import type { CompletionProvider } from "../src/lib/seams";
import { collectStats } from "../src/lib/stats";
import { buildTaxonomy, type Taxonomy } from "../src/lib/taxonomy";
import { runCli } from "./cli-harness";
import { fakeEmbeddingProvider } from "./vec-fixture";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function config(embed?: boolean, noteEmbed?: boolean): BrainConfig {
  return { taxonomy: { types: {
    generated: { dir: "generated", ...(embed === undefined ? {} : { embed }) },
    note: { dir: "notes", ...(noteEmbed === undefined ? {} : { embed: noteEmbed }) },
  } } };
}

function taxonomy(embed?: boolean, noteEmbed?: boolean): Taxonomy {
  return buildTaxonomy({ user: config(embed, noteEmbed) });
}

function markdown(type: string, title: string, marker: string, link: string): string {
  return `---\ntitle: ${title}\ntype: ${type}\nstatus: active\ncreated: "2026-07-01"\nupdated: "2026-07-01"\ntags: [fixture]\n---\n` +
    `## First section\n\n${(marker + " telescope orchard evidence. ").repeat(40)}\n\n[[${link}]]\n\n` +
    `## Second section\n\n${(marker + " observatory measurements. ").repeat(40)}\n\n[TODO: confirm the fixture.]\n`;
}

async function corpus(embed?: boolean, assets = false) {
  const root = mkdtempSync(join(tmpdir(), "brain-embedding-policy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "generated"));
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "generated/bulk.md"), markdown("generated", "Generated bulletin", "optedoutmarker", "notes/eligible"));
  writeFileSync(join(root, "notes/eligible.md"), markdown("note", "Field notes", "eligiblemarker", "generated/bulk"));
  if (assets) {
    writeFileSync(join(root, "generated/picture.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "generated/report.pdf"), "%PDF-1.0 fixture");
  }
  const dbPath = join(root, "brain.db");
  const db = openDatabase(dbPath, { embeddingDimensions: 16 });
  cleanups.push(() => db.close());
  if (!await migrateVecSchema(db, 16)) throw new Error("sqlite-vec is required for embedding policy regressions");
  const options = { root, taxonomy: taxonomy(embed), quiet: true, graph: false };
  return { db, dbPath, root, options };
}

function recordingProviders(multimodal = true) {
  const texts: string[] = [];
  const images: string[] = [];
  const pdfs: string[] = [];
  const contexts: string[] = [];
  const descriptions: string[] = [];
  const provider = fakeEmbeddingProvider();
  const embed = provider.embed;
  provider.embed = async (input) => { texts.push(...input); return embed(input); };
  if (multimodal) {
    provider.embedImage = async (_bytes, _mime, description) => {
      images.push(description); return new Float32Array(16).fill(0.1);
    };
    provider.embedPdf = async (_bytes, description) => {
      pdfs.push(description); return new Float32Array(16).fill(0.1);
    };
  }
  const completion: CompletionProvider = {
    id: "fake:policy-completion", capabilities: { vision: true },
    async complete(request) {
      if (request.parts?.length) {
        descriptions.push(request.prompt);
        return "A searchable asset description with assetdescriptionmarker.";
      }
      contexts.push(request.prompt);
      return "Fixture chunk context.";
    },
  };
  return { provider, enrichment: createEnrichment(completion), texts, images, pdfs, contexts, descriptions };
}

function chunks(db: Database, type?: string): number[] {
  return (db.query(`SELECT c.id FROM chunks c JOIN documents d ON d.id=c.document_id
    ${type ? "WHERE d.type = ?" : ""} ORDER BY c.id`).all(...(type ? [type] : [])) as { id: number }[]).map((r) => r.id);
}

function vectors(db: Database, type?: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM vec_chunks v JOIN chunks c ON c.id=v.chunk_id
    JOIN documents d ON d.id=c.document_id ${type ? "WHERE d.type = ?" : ""}`)
    .get(...(type ? [type] : [])) as { n: number }).n;
}

async function stats(f: Awaited<ReturnType<typeof corpus>>, t: Taxonomy, embeddingsConfigured = true) {
  return collectStats(f.db, { root: f.root, dbPath: f.dbPath, taxonomy: t, config: null, embeddingsConfigured });
}

describe("per-type embedding policy", () => {
  test("embed is an optional boolean, validated rather than coerced", () => {
    for (const embed of [undefined, true, false]) expect(brainConfigSchema.safeParse(config(embed)).success).toBe(true);
    for (const embed of ["false", 0, null, [], {}]) {
      expect(brainConfigSchema.safeParse({ taxonomy: { types: { generated: { dir: "generated", embed } } } }).success).toBe(false);
    }
  });

  test("opted-out markdown keeps FTS, links, audit and counts without context or vector work", async () => {
    const f = await corpus(false);
    const p = recordingProviders();
    await indexAll(f.db, { ...f.options, ...p, embeddings: true });
    expect(chunks(f.db, "generated").length).toBeGreaterThan(1);
    expect(p.contexts.filter((s) => s.includes('title="Generated bulletin"'))).toHaveLength(0);
    expect(p.texts.filter((s) => s.includes("optedoutmarker"))).toHaveLength(0);
    expect(vectors(f.db, "generated")).toBe(0);
    // Positive controls make the zero-call assertions about the policy.
    expect(p.contexts.filter((s) => s.includes('title="Field notes"')).length).toBeGreaterThan(1);
    expect(p.texts.length).toBeGreaterThan(1);
    expect(vectors(f.db, "note")).toBe(chunks(f.db, "note").length);
    expect(f.db.query("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'optedoutmarker'").all()).toHaveLength(1);
    expect(f.db.query("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'optedoutmarker'").all().length).toBeGreaterThan(1);
    expect(f.db.query("SELECT target_id FROM links WHERE target_id IS NOT NULL").all()).toHaveLength(2);
    expect(loadAuditDocs(f.db).some((d) => d.type === "generated")).toBe(true);
    expect(audit(f.db, f.options.taxonomy).some((i) => i.path === "generated/bulk.md" && i.category === "todo")).toBe(true);
    const measured = await stats(f, f.options.taxonomy);
    expect(measured.documents).toBe(2);
    expect(measured.byType.generated).toBe(1);
    expect(measured.chunks).toBe(chunks(f.db).length);
    expect(measured.health.embeddingCoverage).toBe(1);
  });

  for (const embed of [undefined, true]) {
    test(`absent/true policy (${String(embed)}) preserves generation`, async () => {
      const f = await corpus(embed);
      const p = recordingProviders();
      await indexAll(f.db, { ...f.options, ...p, embeddings: true });
      expect(p.contexts.filter((s) => s.includes('title="Generated bulletin"')).length).toBeGreaterThan(1);
      expect(p.texts.filter((s) => s.includes("optedoutmarker")).length).toBeGreaterThan(1);
      expect(vectors(f.db)).toBe(chunks(f.db).length);
    });
  }

  test("unchanged policy flips remove markdown and asset vectors without embeddings, then backfill idempotently", async () => {
    const f = await corpus(true, true);
    const p = recordingProviders();
    await indexAll(f.db, { ...f.options, ...p, embeddings: true });
    const initial = vectors(f.db, "generated");
    expect(initial).toBeGreaterThan(3);
    const bytes = readFileSync(join(f.root, "generated/bulk.md"));
    const off = taxonomy(false);
    for (let i = 0; i < 2; i++) {
      await indexAll(f.db, { ...f.options, taxonomy: off });
      expect(vectors(f.db, "generated")).toBe(0);
    }
    expect(readFileSync(join(f.root, "generated/bulk.md"))).toEqual(bytes);
    expect(chunks(f.db, "generated")).toHaveLength(initial);
    expect(f.db.query("SELECT context FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.type='generated' AND d.asset_type='markdown' AND c.context IS NOT NULL").all().length).toBeGreaterThan(1);
    const on = taxonomy(true);
    await indexAll(f.db, { ...f.options, taxonomy: on });
    expect(vectors(f.db, "generated")).toBe(0);
    const completed = await indexAll(f.db, { ...f.options, ...p, taxonomy: on, embeddings: true });
    expect(completed.embeddings).toBe(initial);
    expect(vectors(f.db, "generated")).toBe(initial);
    expect((await indexAll(f.db, { ...f.options, ...p, taxonomy: on, embeddings: true })).embeddings).toBe(0);
  });

  test("a force rebuild cannot restore opted-out contexts or carried/cache vectors", async () => {
    const f = await corpus(true, true);
    const p = recordingProviders();
    await indexAll(f.db, { ...f.options, ...p, embeddings: true });
    expect(vectors(f.db, "generated")).toBeGreaterThan(3);
    expect(existsSync(join(f.root, ".context-cache.jsonl"))).toBe(true);
    const cachedChunk = f.db.query("SELECT d.title, c.heading, c.content FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.type='generated' AND d.asset_type='markdown' LIMIT 1").get() as { title: string; heading: string; content: string };
    expect(loadContextCache(f.root).has(chunkContextKey(cachedChunk.title, cachedChunk.heading, cachedChunk.content))).toBe(true);
    const beforeCalls = p.texts.length + p.images.length + p.pdfs.length;
    const beforeContexts = p.contexts.length;
    for (let i = 0; i < 2; i++) {
      await indexAll(f.db, { ...f.options, ...p, taxonomy: taxonomy(false), embeddings: true, force: true });
      expect(vectors(f.db, "generated")).toBe(0);
      expect(vectors(f.db, "note")).toBeGreaterThan(1);
      expect(f.db.query("SELECT context FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.type='generated' AND d.asset_type='markdown' AND c.context IS NOT NULL").all()).toHaveLength(0);
    }
    expect(p.texts.length + p.images.length + p.pdfs.length).toBe(beforeCalls);
    expect(p.contexts).toHaveLength(beforeContexts);
    expect(p.descriptions).toHaveLength(2);
  });

  test("a plain index on a new connection reconciles opt-outs without migrating stored vectors", async () => {
    const f = await corpus(true, true);
    const p = recordingProviders();
    await indexAll(f.db, { ...f.options, ...p, embeddings: true });
    expect(p.descriptions).toHaveLength(2);
    expect(vectors(f.db, "generated")).toBeGreaterThan(3);
    const schema = (f.db.query("SELECT sql FROM sqlite_master WHERE name='vec_chunks'").get() as { sql: string }).sql;
    const next = openDatabase(f.dbPath);
    try { await indexAll(next, { ...f.options, taxonomy: taxonomy(false) }); }
    finally { next.close(); }
    expect(vectors(f.db, "generated")).toBe(0);
    expect(vectors(f.db, "note")).toBe(chunks(f.db, "note").length);
    expect((f.db.query("SELECT sql FROM sqlite_master WHERE name='vec_chunks'").get() as { sql: string }).sql).toBe(schema);
  });

  test("a document that changes to an opted-out type during an embedding call cannot regain a vector", async () => {
    const f = await corpus(false);
    const provider = fakeEmbeddingProvider();
    const embed = provider.embed;
    let calls = 0;
    provider.embed = async (texts) => {
      calls++;
      const path = join(f.root, "notes/eligible.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("type: note", "type: generated"));
      await indexAll(f.db, f.options);
      return embed(texts);
    };
    await indexAll(f.db, { ...f.options, embeddings: true, provider });
    expect(calls).toBeGreaterThan(0);
    expect(chunks(f.db, "generated").length).toBeGreaterThan(3);
    expect(vectors(f.db)).toBe(0);
  });

  for (const multimodal of [true, false]) {
    test(`asset descriptions stay searchable but neither fresh nor backfill vectors run (multimodal ${multimodal})`, async () => {
      const f = await corpus(false, true);
      const p = recordingProviders(multimodal);
      for (let i = 0; i < 2; i++) await indexAll(f.db, { ...f.options, ...p, embeddings: true });
      expect(p.descriptions).toHaveLength(2);
      expect(f.db.query("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'assetdescriptionmarker'").all()).toHaveLength(2);
      expect(p.images).toHaveLength(0);
      expect(p.pdfs).toHaveLength(0);
      expect(p.texts.filter((s) => s.includes("assetdescriptionmarker"))).toHaveLength(0);
      expect(vectors(f.db, "generated")).toBe(0);
      await indexAll(f.db, { ...f.options, ...p, taxonomy: taxonomy(true), embeddings: true });
      expect(vectors(f.db, "generated")).toBe(chunks(f.db, "generated").length);
      expect(p.descriptions).toHaveLength(2);
      if (multimodal) { expect(p.images).toHaveLength(1); expect(p.pdfs).toHaveLength(1); }
      else expect(p.texts.filter((s) => s.includes("assetdescriptionmarker"))).toHaveLength(2);
    });
  }

  test("coverage counts only eligible chunks and vectors while total counters still include stale ineligible vectors", async () => {
    const f = await corpus(true);
    await indexAll(f.db, { ...f.options, embeddings: true, provider: fakeEmbeddingProvider() });
    const eligible = chunks(f.db, "note");
    const excluded = chunks(f.db, "generated");
    expect(eligible.length).toBeGreaterThan(1);
    expect(excluded.length).toBeGreaterThan(1);
    const off = taxonomy(false);
    const complete = await stats(f, off);
    expect(complete.health.embeddingCoverage).toBe(1);
    expect(complete.embeddings).toBe(eligible.length + excluded.length);
    f.db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [eligible[0]]);
    const partial = await stats(f, off);
    expect(partial.health.embeddingCoverage).toBe((eligible.length - 1) / eligible.length);
    expect(partial.chunks).toBe(eligible.length + excluded.length);
    expect(partial.embeddings).toBe(eligible.length + excluded.length - 1);
    expect(vectors(f.db, "generated")).toBe(excluded.length);
  });

  test("zero eligible chunks and keyless indexing have no coverage verdict; real CLI JSON/text agree", async () => {
    const f = await corpus(false);
    await indexAll(f.db, { ...f.options, embeddings: true, provider: fakeEmbeddingProvider() });
    writeFileSync(join(f.root, "brain.config.json"), JSON.stringify(config(false)));
    const json = await runCli(f.root, ["stats", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).health.embeddingCoverage).toBe(1);
    const text = await runCli(f.root, ["stats", "--human"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/Embedding coverage: +100\.0% of eligible chunks, meets/);
    const off = taxonomy(false, false);
    await indexAll(f.db, { ...f.options, taxonomy: off });
    expect(chunks(f.db).length).toBeGreaterThan(3);
    expect((await stats(f, off)).health.embeddingCoverage).toBeNull();
    writeFileSync(join(f.root, "brain.config.json"), JSON.stringify(config(false, false)));
    const none = await runCli(f.root, ["stats", "--json"]);
    expect(none.code).toBe(0);
    expect(JSON.parse(none.stdout).health.embeddingCoverage).toBeNull();
    const noneText = await runCli(f.root, ["stats", "--human"]);
    expect(noneText.code).toBe(0);
    const line = noneText.stdout.split("\n").find((s) => s.includes("Embedding coverage:"));
    expect(line).toContain("n/a");
    expect(line).not.toContain("below");
    expect(line).not.toContain("meets");
    expect((await stats(f, taxonomy(true), false)).health.embeddingCoverage).toBeNull();
  });

  test("an unreadable vector store stays unknown under the current eligibility policy", async () => {
    const f = await corpus(true);
    await indexAll(f.db, { ...f.options, embeddings: true, provider: fakeEmbeddingProvider() });
    expect(vectors(f.db)).toBeGreaterThan(3);
    class NoExtension extends Database {
      override loadExtension(): void { throw new Error("extension refused by the fixture"); }
    }
    const reader = new NoExtension(f.dbPath, { readonly: true });
    try {
      const measured = await collectStats(reader, { root: f.root, dbPath: f.dbPath, taxonomy: taxonomy(false), config: null, embeddingsConfigured: true });
      expect(measured.embeddings).toBeNull();
      expect(measured.health.embeddingCoverage).toBeNull();
    } finally { reader.close(); }
  });
});
