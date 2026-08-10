/**
 * MCP contract tests. Spawns the real stdio server against a temp corpus and
 * asserts the tool surface (all 8 `brain_*` names, readOnly annotations) and
 * the structuredContent shapes for brain_search and brain_list.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { packageVersion } from "../src/package-version";

let root: string;
let client: Client;

const READ_TOOLS = ["brain_search", "brain_context", "brain_read", "brain_list", "brain_graph"];
const ALL_TOOLS = [...READ_TOOLS, "brain_add", "brain_update", "brain_archive"];

beforeAll(async () => {
  root = makeTempBrain();
  const idx = await runCli(root, ["index", "--json"]);
  expect(idx.code).toBe(0);

  const transport = new StdioClientTransport({
    command: "bun",
    args: [BRAIN_BIN, "mcp"],
    env: keylessEnv(root),
  });
  client = new Client({ name: "mcp-contract-test", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  cleanup(root);
});

test("lists all 8 brain_* tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  expect(names).toEqual([...ALL_TOOLS].sort());
});

test("reports the installed core package version as serverInfo.version", () => {
  expect(client.getServerVersion()?.version).toBe(packageVersion());
});

test("read tools carry the readOnly annotation", async () => {
  const { tools } = await client.listTools();
  for (const name of READ_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
  }
});

test("write tools are marked non-destructive / idempotent", async () => {
  const { tools } = await client.listTools();
  for (const name of ["brain_update", "brain_archive"]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool!.annotations?.destructiveHint).toBe(false);
    expect(tool!.annotations?.idempotentHint).toBe(true);
  }
});

describe("brain_search", () => {
  test("returns { results, warnings } structuredContent", async () => {
    const res = await client.callTool({
      name: "brain_search",
      arguments: { query: "astronomy", mode: "fts", limit: 5 },
    });
    const sc = res.structuredContent as { results: unknown[]; warnings: unknown[] };
    expect(Array.isArray(sc.results)).toBe(true);
    expect(Array.isArray(sc.warnings)).toBe(true);
    expect(sc.results.length).toBeGreaterThan(0);
    const first = sc.results[0] as Record<string, unknown>;
    expect(first).toHaveProperty("path");
    expect(first).toHaveProperty("title");
    expect(first).toHaveProperty("type");
  });
});

describe("brain_list", () => {
  test("returns { documents, warnings } structuredContent", async () => {
    const res = await client.callTool({
      name: "brain_list",
      arguments: { type: "health", limit: 10 },
    });
    const sc = res.structuredContent as { documents: Array<{ type: string }>; warnings: unknown[] };
    expect(Array.isArray(sc.documents)).toBe(true);
    expect(Array.isArray(sc.warnings)).toBe(true);
    expect(sc.documents.every((d) => d.type === "health")).toBe(true);
  });
});

test("starts with degraded context for invalid config and disables writes", async () => {
  const invalidRoot = makeTempBrain({ empty: true });
  writeFileSync(join(invalidRoot, "brain.config.json"), "{ invalid json");
  const transport = new StdioClientTransport({
    command: "bun",
    args: [BRAIN_BIN, "mcp"],
    env: keylessEnv(invalidRoot),
  });
  const invalidClient = new Client({
    name: "invalid-config-mcp-test",
    version: "1.0.0",
  });

  try {
    await invalidClient.connect(transport);
    const listed = await invalidClient.callTool({
      name: "brain_list",
      arguments: {},
    });
    const warnings = (listed.structuredContent as { warnings: string[] }).warnings;
    expect(warnings.join("\n")).toContain("brain.config is invalid");

    const added = await invalidClient.callTool({
      name: "brain_add",
      arguments: { content: "must not be written" },
    });
    expect(added.isError).toBe(true);
    expect(JSON.stringify(added.content)).toContain("write tools are disabled");
  } finally {
    await invalidClient.close();
    cleanup(invalidRoot);
  }
});
