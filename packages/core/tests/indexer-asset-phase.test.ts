/**
 * The asset phase reads and hashes changed assets before its write
 * transaction, and the description step reads each file when its batch starts
 * (#4784): the write lock is never held across file reads, at most one batch
 * of files is in memory, and a file rewritten after it was hashed is not
 * described under the old hash.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createHash } from "crypto";

import { indexAll } from "../src/lib/indexer";
import { openDatabase } from "../src/lib/db";
import type { Enrichment } from "../src/lib/enrichment";
import type { EmbeddingProvider } from "../src/lib/seams";
import { buildTaxonomy } from "../src/lib/taxonomy";

/** The description step's batch size (`DESCRIBE_CONCURRENCY` in indexer/assets.ts). */
const DESCRIBE_CONCURRENCY = 10;

const taxonomy = buildTaxonomy({ user: null });
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** Asset `i`'s bytes: distinct per asset, and its last byte names it. */
const assetBytes = (i: number, generation = 0) => Buffer.concat([FAKE_PNG, Buffer.from([generation, i])]);
const assetPath = (i: number) => `assets/asset-${String(i).padStart(2, "0")}.png`;

function corpus(count: number): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-asset-phase-"));
  fixtures.push(root);
  for (let i = 0; i < count; i++) {
    const file = join(root, assetPath(i));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, assetBytes(i));
  }
  return root;
}

const provider: EmbeddingProvider = {
  id: "fake:v1",
  dimensions: 4,
  async embed(texts) {
    return texts.map(() => new Float32Array(4).fill(0.5));
  },
  async embedQuery() {
    return new Float32Array(4).fill(0.5);
  },
};

function enrichment(describe: (buffer: Buffer) => Promise<string>): Enrichment {
  return {
    describeAsset: (buffer) => describe(buffer),
    async generateChunkContext() {
      return "";
    },
  };
}

const dbPath = (root: string) => join(root, ".brain-index", "brain.db");

async function embeddingsRun(root: string, describe: (buffer: Buffer) => Promise<string>, db = openDatabase(dbPath(root))) {
  try {
    return await indexAll(db, { root, taxonomy, quiet: true, embeddings: true, provider, enrichment: enrichment(describe) });
  } finally {
    db.close();
  }
}

/** Wrap every `Bun.file(<asset>).arrayBuffer()` read, calling `onRead` as each one starts. */
function onDescribeRead(root: string, onRead: () => void): void {
  const file = Bun.file;
  const spy = spyOn(Bun, "file").mockImplementation(((path: string, ...rest: unknown[]) => {
    const handle = (file as (...a: unknown[]) => ReturnType<typeof Bun.file>)(path, ...rest);
    if (typeof path !== "string" || !path.startsWith(join(root, "assets"))) return handle;
    const arrayBuffer = handle.arrayBuffer.bind(handle);
    return Object.assign(Object.create(handle), {
      arrayBuffer: () => {
        onRead();
        return arrayBuffer();
      },
    });
  }) as typeof Bun.file);
  restores.push(() => spy.mockRestore());
}

/** The asset an enrichment call was handed, by the index its bytes carry. */
const assetIndex = (buffer: Buffer) => buffer[buffer.length - 1];

describe("the asset phase", () => {
  test("reads changed assets outside the write transaction, while another connection can write", async () => {
    const root = corpus(3);
    const db = openDatabase(dbPath(root));
    const inTransaction: boolean[] = [];
    let busy: string | null = "not probed";
    const readFile = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof path === "string" && path.startsWith(join(root, "assets"))) {
        inTransaction.push(db.inTransaction);
        if (busy === "not probed") {
          const other = new Database(dbPath(root));
          try {
            other.run("PRAGMA busy_timeout = 0");
            other.run("BEGIN IMMEDIATE");
            other.run("ROLLBACK");
            busy = null;
          } catch (e) {
            busy = (e as Error).message;
          } finally {
            other.close();
          }
        }
      }
      return (readFile as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    restores.push(() => spy.mockRestore());
    onDescribeRead(root, () => inTransaction.push(db.inTransaction));

    await embeddingsRun(root, async (buffer) => `Asset ${assetIndex(buffer)}`, db);
    // Hashed once in the row phase and read once to be described, per asset.
    expect(inTransaction).toEqual(Array(6).fill(false));
    expect(busy).toBeNull();
  });

  test("holds at most one batch of files between reading and describing them", async () => {
    const root = corpus(3 * DESCRIBE_CONCURRENCY);
    let read = 0;
    let described = 0;
    let most = 0;
    onDescribeRead(root, () => {
      read++;
      most = Math.max(most, read - described);
    });
    const stats = await embeddingsRun(root, async (buffer) => {
      await Bun.sleep(1);
      described++;
      return `Asset ${assetIndex(buffer)}`;
    });
    expect(stats.assets).toBe(3 * DESCRIBE_CONCURRENCY);
    expect(described).toBe(3 * DESCRIBE_CONCURRENCY);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(DESCRIBE_CONCURRENCY);
  });

  test("an asset rewritten before its description keeps its placeholder and is described on the next run", async () => {
    const count = DESCRIBE_CONCURRENCY + 1;
    const root = corpus(count);
    const firstBatch = new Set<number>();
    let rewritten: number | null = null;
    let release!: () => void;
    const batchArrived = new Promise<void>((resolve) => (release = resolve));
    await embeddingsRun(root, async (buffer) => {
      const i = assetIndex(buffer);
      if (rewritten === null) {
        firstBatch.add(i);
        if (firstBatch.size === DESCRIBE_CONCURRENCY) {
          // The whole first batch is in: the one asset left is in a later batch.
          rewritten = [...Array(count).keys()].find((n) => !firstBatch.has(n))!;
          writeFileSync(join(root, assetPath(rewritten)), assetBytes(rewritten, 1));
          release();
        }
        await batchArrived;
      }
      return `Asset ${i} generation ${buffer[buffer.length - 2]}`;
    });
    expect(rewritten).not.toBeNull();
    const path = assetPath(rewritten!);

    const row = () => {
      const db = new Database(dbPath(root), { readonly: true });
      try {
        return db.query("SELECT content, content_hash FROM documents WHERE path = ?").get(path) as { content: string; content_hash: string };
      } finally {
        db.close();
      }
    };
    // The row keeps the placeholder under the hash the row phase recorded.
    const staleHash = createHash("sha256").update(assetBytes(rewritten!)).digest("hex");
    expect(row()).toEqual({ content: `[Image: ${path}]`, content_hash: staleHash });
    const cacheFile = join(root, ".brain-cache", "assets.jsonl");
    const cacheLines = existsSync(cacheFile) ? readFileSync(cacheFile, "utf8").split("\n").filter(Boolean) : [];
    expect(cacheLines.filter((line) => line.includes(staleHash))).toEqual([]);

    await embeddingsRun(root, async (buffer) => `Asset ${assetIndex(buffer)} generation ${buffer[buffer.length - 2]}`);
    expect(row()).toEqual({
      content: `Asset ${rewritten} generation 1`,
      content_hash: createHash("sha256").update(assetBytes(rewritten!, 1)).digest("hex"),
    });
  });
});
