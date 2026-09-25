/**
 * MCP contract tests. Spawns the real stdio server against a temp corpus and
 * asserts the tool surface (all 8 `brain_*` names, readOnly annotations, the
 * input schemas pinned in mcp-input-schemas.json) and the result shapes of the
 * five read tools.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { packageVersion } from "../src/package-version";

let root: string;
let client: Client;

const SCHEMA_SNAPSHOT = join(import.meta.dir, "mcp-input-schemas.json");

/**
 * An input schema as the contract pins it: names, types, enums, defaults and
 * `required`. Descriptions are prose, and some interpolate the brain's own
 * taxonomy, so they are dropped.
 */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, v]) => [key, withoutDescriptions(v)])
  );
}

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

// A schema change must be made on purpose: rerun with UPDATE_MCP_SCHEMAS=1 to
// rewrite the snapshot, and update docs/integration-contract.md with it.
test("input schemas match the checked-in snapshot", async () => {
  const { tools } = await client.listTools();
  const schemas = Object.fromEntries(
    [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => [t.name, withoutDescriptions(t.inputSchema)])
  );
  if (process.env.UPDATE_MCP_SCHEMAS === "1") {
    writeFileSync(SCHEMA_SNAPSHOT, `${JSON.stringify(schemas, null, 2)}\n`);
  }
  expect(Object.keys(schemas)).toHaveLength(ALL_TOOLS.length);
  expect(schemas).toEqual(JSON.parse(readFileSync(SCHEMA_SNAPSHOT, "utf-8")));
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

describe("brain_context", () => {
  test("returns { context, warnings } structuredContent", async () => {
    const res = await client.callTool({
      name: "brain_context",
      arguments: { query: "astronomy", max_tokens: 1000 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { context: string; warnings: unknown[] };
    expect(typeof sc.context).toBe("string");
    expect(sc.context).toContain("##");
    expect(Array.isArray(sc.warnings)).toBe(true);
  });
});

describe("brain_read", () => {
  // No structuredContent: the document is the first text block, verbatim.
  test("returns the file text as content, with no structuredContent", async () => {
    const res = await client.callTool({
      name: "brain_read",
      arguments: { path: "me/identity.md" },
    });
    expect(res.structuredContent).toBeUndefined();
    const [first] = res.content as Array<{ type: string; text: string }>;
    expect(first.type).toBe("text");
    expect(first.text).toBe(readFileSync(join(root, "me/identity.md"), "utf-8"));
  });
});

describe("brain_graph", () => {
  test("returns { edges, warnings } structuredContent", async () => {
    const res = await client.callTool({
      name: "brain_graph",
      arguments: { path: "me/identity.md" },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      edges: Array<{ source: unknown; target: unknown; resolved: unknown }>;
      warnings: unknown[];
    };
    expect(Array.isArray(sc.warnings)).toBe(true);
    expect(sc.edges.length).toBeGreaterThan(0);
    for (const edge of sc.edges) {
      expect(typeof edge.source).toBe("string");
      expect(typeof edge.target).toBe("string");
      expect(typeof edge.resolved).toBe("boolean");
    }
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
