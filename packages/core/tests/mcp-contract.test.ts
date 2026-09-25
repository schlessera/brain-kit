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
 * taxonomy, so the `description` annotation is dropped from every schema
 * node. A `properties` map is not a schema node: its keys are input names,
 * and an input called `description` must stay.
 */
function withoutDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "description")
      .map(([key, v]) => [
        key,
        key === "properties" && v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, withoutDescriptions(s)]))
          : withoutDescriptions(v),
      ])
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

// A schema change must be made on purpose: rerun locally with
// UPDATE_MCP_SCHEMAS=1 to rewrite the snapshot, and update
// docs/integration-contract.md with it. Update mode is refused under CI, where
// it would rewrite the expectation it is about to compare against.
test("input schemas match the checked-in snapshot", async () => {
  const update = process.env.UPDATE_MCP_SCHEMAS === "1";
  if (update && process.env.CI) {
    throw new Error("UPDATE_MCP_SCHEMAS is refused under CI: regenerate the snapshot locally and commit it");
  }
  const { tools } = await client.listTools();
  const schemas = Object.fromEntries(
    [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => [t.name, withoutDescriptions(t.inputSchema)])
  );
  if (update) {
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

  // An agent judges whether a hit is current from these fields, so they are
  // asserted by value on a document that sets every one of them.
  test("carries updated, status, summary and deadline on each result", async () => {
    const res = await client.callTool({
      name: "brain_search",
      arguments: { query: "bookshelf", mode: "fts", limit: 10 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { results: Array<Record<string, unknown>> };
    expect(sc.results.length).toBeGreaterThan(0);
    for (const r of sc.results) {
      expect(r.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const status = sc.results.find((r) => r.path === "projects/active/bookshelf/status.md");
    expect(status).toBeDefined();
    expect(status!.summary).toBe("Latest session log and next action for the bookshelf build");
    expect(status!.status).toBe("active");
    expect(status!.deadline).toBe("2026-08-15");
  });

});

// The MCP spec asks a tool with structured content to repeat it as JSON text.
// That copy is compact: two-space indents cost tokens on every call.
describe("text copy of structured results", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["brain_search", { query: "bookshelf", mode: "fts", limit: 5 }],
    ["brain_list", { type: "project", limit: 5 }],
    ["brain_graph", { path: "me/identity.md" }],
  ];
  for (const [name, args] of calls) {
    test(`${name} text is compact JSON equal to structuredContent`, async () => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBeFalsy();
      // A non-empty payload makes the newline check cover more than the
      // envelope's own punctuation: results and documents carry prose.
      const sc = res.structuredContent as Record<string, unknown[]>;
      expect(Object.values(sc).some((v) => Array.isArray(v) && v.length > 0)).toBe(true);
      const [first] = res.content as Array<{ type: string; text: string }>;
      expect(first.type).toBe("text");
      expect(first.text).not.toContain("\n");
      expect(JSON.parse(first.text)).toEqual(sc);
    });
  }
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

  test("section returns that section and no other", async () => {
    const res = await client.callTool({
      name: "brain_read",
      arguments: { path: "me/identity.md", section: "How to Work With Alex" },
    });
    expect(res.isError).toBeFalsy();
    const [first] = res.content as Array<{ type: string; text: string }>;
    expect(first.text.startsWith("## How to Work With Alex\n")).toBe(true);
    expect(first.text).toContain("Prefer concrete, checklist-shaped guidance");
    expect(first.text).not.toContain("## Current Identity");
  });

  test("max_tokens over the file's size returns the outline, not the body", async () => {
    const res = await client.callTool({
      name: "brain_read",
      arguments: { path: "me/identity.md", max_tokens: 50 },
    });
    expect(res.isError).toBeFalsy();
    const [first] = res.content as Array<{ type: string; text: string }>;
    const file = readFileSync(join(root, "me/identity.md"), "utf-8");
    const headings = file.split("\n").filter((l) => l.startsWith("## "));
    expect(headings.length).toBeGreaterThan(1);
    expect(headings).toEqual(["## Current Identity", "## How to Work With Alex"]);
    expect(first.text).toContain("- ## Current Identity (~206 tokens)\n- ## How to Work With Alex (~63 tokens)\n");
    expect(first.text).toContain('section: "<heading>"');
    expect(first.text).not.toContain("park ranger** at a mid-sized");
    expect(first.text).not.toContain("Prefer concrete");
  });

  test("an unknown section is an error naming the available headings", async () => {
    const res = await client.callTool({
      name: "brain_read",
      arguments: { path: "me/identity.md", section: "No Such Heading" },
    });
    expect(res.isError).toBe(true);
    const [first] = res.content as Array<{ type: string; text: string }>;
    expect(first.text).toContain('available headings: "Current Identity", "How to Work With Alex"');
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

  // Pinned from the tree before nodes were added, so the edge query's join
  // is held to the per-edge lookup it replaced.
  test("edges from me/identity.md are unchanged", async () => {
    const res = await client.callTool({ name: "brain_graph", arguments: { path: "me/identity.md" } });
    expect((res.structuredContent as { edges: unknown[] }).edges).toEqual([
      { source: "me/identity.md", target: "context/current-focus.md", resolved: true },
      { source: "me/identity.md", target: "me/basics/short-bio.md", resolved: true },
      { source: "_index.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/FACTS.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/long-bio.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/short-bio.md", target: "me/identity.md", resolved: true },
    ]);
  });

  type GraphResult = {
    edges: Array<{ source: string; target: string; resolved: boolean }>;
    nodes: Array<{ path: string; title: string; type: string; summary: unknown; updated: unknown }>;
  };
  const graph = async (path: string) => {
    const res = await client.callTool({ name: "brain_graph", arguments: { path } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Partial<GraphResult>).nodes).toBeArray();
    return res.structuredContent as GraphResult;
  };

  for (const start of ["me/identity.md", "context/current-focus.md"]) {
    test(`nodes from ${start} describe every resolved endpoint`, async () => {
      const sc = await graph(start);
      const endpoints = new Set<string>();
      for (const e of sc.edges) {
        endpoints.add(e.source);
        if (e.resolved) endpoints.add(e.target);
      }
      expect(endpoints.size).toBeGreaterThan(1);
      expect(sc.nodes.map((n) => n.path).sort()).toEqual([...endpoints].sort());
      for (const n of sc.nodes) {
        expect(n.title).toMatch(/\S/);
        expect(n.type).toMatch(/\S/);
        expect(n.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(typeof sc.nodes.find((n) => n.path === start)?.summary).toBe("string");
    });
  }

  test("an unresolved target is an edge and not a node", async () => {
    const sc = await graph("context/current-focus.md");
    const edge = sc.edges.find((e) => e.target === "does-not-exist");
    expect(edge).toEqual({ source: "context/current-focus.md", target: "does-not-exist", resolved: false });
    expect(sc.nodes.map((n) => n.path)).not.toContain("does-not-exist");
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
