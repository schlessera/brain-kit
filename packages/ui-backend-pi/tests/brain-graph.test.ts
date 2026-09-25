import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import matter from "gray-matter";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { indexAll, initContext, openDatabase } from "@schlessera/brain";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";

const CTX = {} as never;
const CORE = resolve(import.meta.dir, "../../core");

// The core fixture corpus, the brain the MCP tool's tests walk.
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-backend-graph-"));
  cpSync(join(CORE, "fixtures/corpus"), root, { recursive: true });
  // The fixture's brain.config.ts imports @schlessera/brain.
  symlinkSync(resolve(CORE, "../../node_modules"), join(root, "node_modules"));
  const ctx = await initContext({ root });
  const db = openDatabase(ctx.dbPath);
  try {
    await indexAll(db, { root, taxonomy: ctx.taxonomy, force: true, quiet: true });
  } finally {
    db.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Graph = {
  edges: Array<{ source: string; target: string; resolved: boolean }>;
  nodes: Array<{ path: string; title: string; type: string; summary: string | null; updated: string | null }>;
};

async function graph(path: string): Promise<Graph> {
  const list = createBrainTools({
    brain: createBrainAccess(root),
    turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  const tool = list.find((t) => t.name === "brain_graph") as ToolDefinition;
  const parsed = JSON.parse(resultText(await tool.execute("g", { path } as never, undefined, undefined, CTX)));
  expect(parsed.nodes).toBeArray();
  return parsed;
}

/** What a node should say: the document's own frontmatter. */
function expectedNode(path: string) {
  const data = matter(readFileSync(join(root, path), "utf-8"), {}).data;
  const date = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  return { path, title: data.title, type: data.type, summary: data.summary ?? null, updated: date(data.updated) };
}

describe("brain_graph wrapper", () => {
  test("edges from me/identity.md are unchanged", async () => {
    // The same edges the MCP tool's contract test pins.
    expect((await graph("me/identity.md")).edges).toEqual([
      { source: "me/identity.md", target: "context/current-focus.md", resolved: true },
      { source: "me/identity.md", target: "me/basics/short-bio.md", resolved: true },
      { source: "_index.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/FACTS.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/long-bio.md", target: "me/identity.md", resolved: true },
      { source: "me/basics/short-bio.md", target: "me/identity.md", resolved: true },
    ]);
  });

  for (const start of ["me/identity.md", "context/current-focus.md"]) {
    test(`nodes from ${start} are every resolved endpoint, in path order, with its frontmatter`, async () => {
      const { edges, nodes } = await graph(start);
      const endpoints = new Set<string>();
      for (const e of edges) {
        endpoints.add(e.source);
        if (e.resolved) endpoints.add(e.target);
      }
      expect(endpoints.size).toBeGreaterThan(1);
      const expected = [...endpoints].sort().map(expectedNode);
      expect(expected.every((n) => n.title && n.type)).toBe(true);
      expect(nodes).toEqual(expected);
    });
  }

  test("an unresolved target is an edge and not a node", async () => {
    const { edges, nodes } = await graph("context/current-focus.md");
    expect(edges).toContainEqual({ source: "context/current-focus.md", target: "does-not-exist", resolved: false });
    expect(nodes.map((n) => n.path)).not.toContain("does-not-exist");
  });
});
