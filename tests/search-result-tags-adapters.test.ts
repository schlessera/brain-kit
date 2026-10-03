import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../packages/core/tests/cli-harness";
import { createBrainClient } from "../packages/ui-server/src/brain/client";
import { createBrainRoutes } from "../packages/ui-server/src/routes/brain";

let root: string;
let client: Client;
let app: Hono;
const paths = ["notes/nullable-untagged.md", "notes/nullable-tagged.md"];

function assertTags(rows: Array<Record<string, unknown>>) {
  const controls = rows.filter((row) => paths.includes(String(row.path)));
  expect(controls).toHaveLength(2);
  expect(Object.fromEntries(controls.map((row) => [row.path, row.tags]))).toEqual({
    [paths[0]!]: null,
    [paths[1]!]: "voyage, navigation",
  });
  return controls;
}

beforeAll(async () => {
  root = makeTempBrain();
  // Give the real server client a test-owned bin pointing at the source CLI.
  // Replacing only the fixture's symlink never modifies workspace node_modules.
  rmSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(resolve(import.meta.dir, "../node_modules/@schlessera"), join(root, "node_modules/@schlessera"));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(root, "node_modules/.bin/brain"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BRAIN_BIN)} "$@"\n`, { mode: 0o755 });
  for (const [i, path] of paths.entries()) {
    writeFileSync(join(root, path), `---\ntitle: Nullable control ${i}\ntype: note\nstatus: active\nrelevance: medium\nupdated: 2026-01-01\n${i ? "tags: [voyage, navigation]\n" : ""}---\n\nnullableprobe\n`);
  }
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code).toBe(0);
  client = new Client({ name: "nullable-tags-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [BRAIN_BIN, "mcp"], env: keylessEnv(root),
  }));
  app = new Hono().route("/api", createBrainRoutes({
    brain: createBrainClient({ brainPath: root }), brainPath: root,
    keyterms: { brainPath: root, cacheDir: root, limit: 10 },
  }));
});

afterAll(async () => {
  await client?.close();
  if (root) cleanup(root);
});

test("real CLI search preserves nullable tag strings", async () => {
  const search = await runCli(root, ["search", "--mode", "fts", "--rerank", "none", "--json", "nullableprobe"]);
  expect(search.code).toBe(0);
  assertTags(JSON.parse(search.stdout).results);
});

test("real CLI list preserves nullable tag strings and metadata", async () => {
  const list = await runCli(root, ["list", "--type", "note", "--limit", "100", "--json"]);
  expect(list.code).toBe(0);
  const controls = assertTags(JSON.parse(list.stdout));
  for (const row of controls) {
    expect(row.summary).toBeNull();
    expect(row.deadline).toBeNull();
    expect(row.generatedFrom).toBeNull();
    expect(row.updated).toBe("2026-01-01");
    expect(row.score).toBe(0);
    expect(row.snippet).toBe("");
    expect(row).not.toHaveProperty("created");
  }
});

test("real stdio MCP search preserves nullable tag strings", async () => {
  const search = await client.callTool({ name: "brain_search", arguments: { query: "nullableprobe", mode: "fts", rerank: "none" } });
  expect(search.isError).toBeFalsy();
  assertTags((search.structuredContent as { results: Array<Record<string, unknown>> }).results);
});

test("real stdio MCP list preserves nullable tag strings", async () => {
  const list = await client.callTool({ name: "brain_list", arguments: { type: "note", limit: 100 } });
  expect(list.isError).toBeFalsy();
  assertTags((list.structuredContent as { documents: Array<Record<string, unknown>> }).documents);
});

test("mounted HTTP search through real BrainClient preserves nullable tag strings", async () => {
  const search = await app.request("/api/brain/search?q=nullableprobe&mode=fts");
  expect(search.status).toBe(200);
  assertTags((await search.json()).results);
});

test("mounted HTTP list through real BrainClient preserves CLI fields", async () => {
  const list = await app.request("/api/brain/list?type=note&limit=100");
  expect(list.status).toBe(200);
  const controls = assertTags((await list.json()).results);
  for (const row of controls) {
    expect(row.summary).toBeNull();
    expect(row.score).toBe(0);
    expect(row.snippet).toBe("");
    expect(row).not.toHaveProperty("created");
  }
});
