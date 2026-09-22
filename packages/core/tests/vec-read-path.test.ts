/**
 * A read path must not migrate the vector schema.
 *
 * `initVecSupport` used to be both "make vectors readable on this connection"
 * and "bring the vector schema up to date", and the second half drops every
 * stored vector. `brain mcp` holds a writable handle (its write tools reindex),
 * so a search through a surface annotated `readOnlyHint: true` emptied
 * `vec_chunks` — recoverable only by a paid `brain index --embeddings --force`.
 *
 * These tests drive the real surfaces against a real staged index rather than
 * the split functions, so the file also runs against the tree before the fix:
 * there the MCP case reports 1 -> 0.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
// Same optional-extension policy as indexer.test.ts; one shared probe.
import { vecAvailable } from "./vec-fixture";

/** The width the staged index is built at — deliberately not the default. */
const STORED_DIM = 16;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

async function withVec<T>(dbPath: string, readonly: boolean, fn: (db: Database) => T): Promise<T> {
  const db = new Database(dbPath, readonly ? { readonly: true } : { readwrite: true, create: false });
  const { load } = await import("sqlite-vec");
  load(db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Rows in `vec_chunks`, or -1 when the table is not there at all. */
async function countVectors(dbPath: string): Promise<number> {
  return withVec(dbPath, true, (db) => {
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;
    } catch {
      return -1;
    }
  });
}

/** The width `vec_chunks` is declared at, read back off sqlite_master. */
async function tableWidth(dbPath: string): Promise<number | null> {
  return withVec(dbPath, true, (db) => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'")
      .get() as { sql: string } | null;
    const width = row?.sql.match(/\bembedding\s+float\[(\d+)\]/i)?.[1];
    return width ? Number(width) : null;
  });
}

function meta(dbPath: string, key: string): string | null {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const row = db.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * A brain whose index carries one stored vector and a pending vector-schema
 * migration — an index last written before the cosine migration shipped.
 *
 * `pending` picks which migrations are still owed: dropping
 * `vec_distance_metric` alone is the shape the issue reproduced against.
 */
async function stageIndex(pending: string[] = ["vec_distance_metric"]): Promise<string> {
  const root = makeTempBrain();
  roots.push(root);
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code).toBe(0);

  const dbPath = join(root, "brain.db");
  await withVec(dbPath, false, (db) => {
    const chunk = db.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: number } | null;
    if (!chunk) throw new Error("fixture corpus produced no chunks");

    // Rebuild the vector store at a width that is not the configured default,
    // so a path that recreates it from the configured provider is visible.
    db.run("DROP TABLE IF EXISTS vec_chunks");
    db.run(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${STORED_DIM}] distance_metric=cosine,
      is_archived INTEGER,
      doc_type TEXT
    )`);
    db.run("INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, 0, 'note')", [
      chunk.id,
      new Uint8Array(new Float32Array(STORED_DIM).fill(0.25).buffer),
    ]);
    db.run("INSERT OR REPLACE INTO index_metadata(key, value) VALUES ('embedding_dimensions', ?)", [
      String(STORED_DIM),
    ]);
    db.run("INSERT OR REPLACE INTO index_metadata(key, value) VALUES ('vec_distance_metric', 'cosine')");
    db.run("INSERT OR REPLACE INTO index_metadata(key, value) VALUES ('vec_schema', 'v2-metadata')");
    for (const key of pending) db.run("DELETE FROM index_metadata WHERE key = ?", [key]);

    // Copies and readers below open the file directly; leave nothing in the WAL.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  expect(await countVectors(dbPath)).toBe(1);
  return root;
}

/** One request against the real stdio MCP server, then shut it down. */
async function throughMcpServer(root: string, call: (client: Client) => Promise<unknown>): Promise<void> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [BRAIN_BIN, "mcp"],
    env: keylessEnv(root),
  });
  const client = new Client({ name: "vec-read-path-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    await call(client);
  } finally {
    await client.close();
  }
}

describe.skipIf(!vecAvailable)("read paths never migrate the vector schema", () => {
  test("a vector search through brain mcp leaves the stored vectors alone", async () => {
    const root = await stageIndex();
    const dbPath = join(root, "brain.db");

    await throughMcpServer(root, (client) =>
      client.callTool({ name: "brain_search", arguments: { query: "example", mode: "vector" } })
    );

    expect(await countVectors(dbPath)).toBe(1);
    expect(await tableWidth(dbPath)).toBe(STORED_DIM);
    // The handle is writable — its write tools reindex — so the proof is that
    // no migration was attempted at all, not merely that one failed.
    expect(meta(dbPath, "vec_distance_metric")).toBeNull();
  });

  test("brain search --mode vector leaves the stored vectors alone and names the real cause", async () => {
    const root = await stageIndex();
    const dbPath = join(root, "brain.db");

    const result = await runCli(root, ["search", "example", "--mode", "vector", "--json"]);
    expect(result.code).toBe(0);
    expect(await countVectors(dbPath)).toBe(1);
    expect(await tableWidth(dbPath)).toBe(STORED_DIM);
    // The extension loaded; nothing here is entitled to claim otherwise.
    expect(result.stderr).not.toContain("sqlite-vec not available");
  });

  test("brain context leaves the stored vectors alone", async () => {
    const root = await stageIndex();
    const dbPath = join(root, "brain.db");

    const result = await runCli(root, ["context", "example"]);
    expect(result.code).toBe(0);
    expect(await countVectors(dbPath)).toBe(1);
    expect(result.stderr).not.toContain("sqlite-vec not available");
  });

  test("an MCP write tool still reindexes a brain that has no vec_chunks table", async () => {
    // The server used to create the table at startup as a side effect of the
    // migration it must no longer run. Nothing else on the write path creates
    // it outside the embedding pass, so this is the regression that costs.
    const root = makeTempBrain();
    roots.push(root);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    await withVec(join(root, "brain.db"), false, (db) => {
      db.run("DROP TABLE IF EXISTS vec_chunks");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    });

    let response: { isError?: boolean; content?: Array<{ text?: string }> } = {};
    await throughMcpServer(root, async (client) => {
      response = (await client.callTool({
        name: "brain_update",
        arguments: { path: "notes/loose-idea.md", append_content: "A later thought." },
      })) as typeof response;
    });

    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content?.[0]?.text ?? "{}")).toMatchObject({
      path: "notes/loose-idea.md",
      changes: ["content"],
    });
    expect(await countVectors(join(root, "brain.db"))).toBe(-1); // still absent, still fine
  });

  test("a brain with no vectors at all reports that, not a missing extension", async () => {
    const root = makeTempBrain();
    roots.push(root);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    await withVec(join(root, "brain.db"), false, (db) => {
      db.run("DROP TABLE IF EXISTS vec_chunks");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    });

    const result = await runCli(root, ["search", "example", "--mode", "vector", "--json"]);
    expect(result.code).toBe(0);
    // Nothing loaded the extension and failed to write: the extension is fine,
    // the brain simply has no vectors. Neither channel may say otherwise.
    expect(result.stderr).not.toContain("sqlite-vec not available");
    const { warnings } = JSON.parse(result.stdout) as { warnings: string[] };
    expect(warnings.join(" ")).not.toContain("sqlite-vec extension not loaded");
    expect(warnings.join(" ")).toContain("vector search unavailable");
  });
});

describe.skipIf(!vecAvailable)("write paths still migrate the vector schema", () => {
  test("brain index brings a pre-cosine index up to cosine and v2-metadata", async () => {
    const root = await stageIndex(["vec_distance_metric", "vec_schema"]);
    const dbPath = join(root, "brain.db");

    expect((await runCli(root, ["index", "--json"])).code).toBe(0);

    expect(meta(dbPath, "vec_distance_metric")).toBe("cosine");
    expect(meta(dbPath, "vec_schema")).toBe("v2-metadata");
  });

  test("a corrupt embedding_dimensions cannot destroy the store it cannot describe", async () => {
    // Only the v2 copy is owed here, so the vectors are meant to survive the
    // migration. `index_metadata` claims a width no vec0 column can be
    // declared at (sqlite-vec caps at 8192), which used to drop the table and
    // then fail the CREATE, taking the vectors with it.
    const root = await stageIndex(["vec_schema"]);
    const dbPath = join(root, "brain.db");
    await withVec(dbPath, false, (db) => {
      db.run("INSERT OR REPLACE INTO index_metadata(key, value) VALUES ('embedding_dimensions', '99999')");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    });

    expect((await runCli(root, ["index", "--json"])).code).toBe(0);

    expect(await countVectors(dbPath)).toBe(1);
    expect(await tableWidth(dbPath)).toBe(STORED_DIM);
    expect(meta(dbPath, "vec_schema")).toBe("v2-metadata");
  });

  test("the migration rebuilds at the stored width, not the configured one", async () => {
    const root = await stageIndex(["vec_distance_metric", "vec_schema"]);
    const dbPath = join(root, "brain.db");

    expect((await runCli(root, ["index", "--json"])).code).toBe(0);

    // The configured provider defaults to 1536; the index was built at 16.
    expect(await tableWidth(dbPath)).toBe(STORED_DIM);
  });
});
