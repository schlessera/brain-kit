/**
 * The reranker's recency half-lives come from the brain's own types (#409),
 * and every search entry point hands the brain's taxonomy to it.
 *
 * The brain: two documents with the same title and date, a `logbook` whose
 * type configures an effectively infinite half-life and a core `note` (60
 * days). The note wins on BM25; the logbook wins only when its half-life
 * reaches the reranker. Without it, both types decay to the floor over the
 * years since 2020 and the note stays first, so each assertion below fails on
 * the order if an entry point drops the taxonomy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { initContext } from "../src/lib/context";
import { assembleContext } from "../src/lib/context-assembler";
import { openDatabase } from "../src/lib/db";
import { hybridSearch } from "../src/lib/search-engine";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const LOGBOOK = "logbook/lantern.md";
const NOTE = "notes/lantern.md";

let root: string;

function write(rel: string, text: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeAll(async () => {
  root = makeTempBrain({ empty: true });
  write("brain.config.ts", `export default { taxonomy: { types: { logbook: { dir: "logbook", halfLifeDays: 100000 } } } };\n`);
  write(LOGBOOK, `---\ntype: logbook\ntitle: "Sailor lantern"\nupdated: 2020-01-01\nrelevance: secondary\n---\n\nChecked the lantern at the cave on Ogygia after the storm.\n`);
  write(NOTE, `---\ntype: note\ntitle: "Sailor lantern"\nupdated: 2020-01-01\nrelevance: secondary\n---\n\nThe lantern wick.\n`);
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);
});

afterAll(() => cleanup(root));

const paths = (results: { path: string }[]) => results.map((r) => r.path);

describe("hybridSearch", () => {
  test("the note leads on the full-text score alone", async () => {
    const ctx = await initContext({ root });
    const db = openDatabase(ctx.dbPath, { readonly: true });
    try {
      const { results } = await hybridSearch(db, { query: "lantern", mode: "fts", rerank: "none" }, { taxonomy: ctx.taxonomy });
      expect(paths(results)).toEqual([NOTE, LOGBOOK]);
    } finally {
      db.close();
    }
  });

  test("the reranker reads the half-life from deps.taxonomy", async () => {
    const ctx = await initContext({ root });
    const db = openDatabase(ctx.dbPath, { readonly: true });
    try {
      const { results } = await hybridSearch(db, { query: "lantern", mode: "fts" }, { taxonomy: ctx.taxonomy });
      expect(paths(results)).toEqual([LOGBOOK, NOTE]);
    } finally {
      db.close();
    }
  });

  test("assembleContext passes the brain's taxonomy to search", async () => {
    const ctx = await initContext({ root });
    const db = openDatabase(ctx.dbPath, { readonly: true });
    try {
      const text = await assembleContext(db, ctx, { query: "lantern", includeIdentity: false, includeCurrentFocus: false });
      expect(text.indexOf(`(${LOGBOOK})`)).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(`(${LOGBOOK})`)).toBeLessThan(text.indexOf(`(${NOTE})`));
    } finally {
      db.close();
    }
  });
});

test("brain search --json passes the brain's taxonomy to the reranker", async () => {
  const res = await runCli(root, ["search", "lantern", "--mode", "fts", "--json"]);
  expect(res.code).toBe(0);
  expect(paths(JSON.parse(res.stdout).results)).toEqual([LOGBOOK, NOTE]);
});

describe("MCP server", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "half-lives-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
  });

  afterAll(async () => {
    await client?.close();
  });

  test("brain_search passes the brain's taxonomy to the reranker", async () => {
    const res = await client.callTool({ name: "brain_search", arguments: { query: "lantern", mode: "fts" } });
    const sc = res.structuredContent as { results: { path: string }[] };
    expect(paths(sc.results)).toEqual([LOGBOOK, NOTE]);
  });
});
