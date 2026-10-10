import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { indexAll, initContext, openDatabase } from "@schlessera/brain/internal";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeIndexedBrain, resultText } from "./helpers";

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

async function graph(path: string, brainRoot = root): Promise<Graph> {
  const list = createBrainTools({
    brain: createBrainAccess(brainRoot),
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
  const data = parseFrontmatter(readFileSync(join(root, path), "utf-8")).data;
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

const note = (title: string, body: string, summary = "") =>
  `---\ntype: note\ntitle: ${title}\ncreated: 2026-01-01\nupdated: 2026-01-02\n` +
  (summary ? `summary: "${summary}"\n` : "") +
  `tags: [t]\nstatus: active\nrelevance: primary\n---\n\n${body}\n`;

describe("brain_graph wrapper, review round 1", () => {
  type Truncated = Graph & { truncated?: true; omitted_edges?: number };
  async function graphOf(docs: Record<string, string>, path: string): Promise<{ text: string; parsed: Truncated }> {
    const brain = await makeIndexedBrain(docs);
    try {
      const list = createBrainTools({
        brain: createBrainAccess(brain.root),
        turn: createTurnContext(),
        lock: toolLockFromKeyed(createKeyedLock()),
      });
      const tool = list.find((t) => t.name === "brain_graph") as ToolDefinition;
      const text = resultText(await tool.execute("g", { path, direction: "outgoing" } as never, undefined, undefined, CTX));
      return { text, parsed: JSON.parse(text) };
    } finally {
      brain.cleanup();
    }
  }

  /** Every returned edge has its endpoints among the nodes, and there are no other nodes. */
  function expectCovered(g: Truncated): void {
    const endpoints = new Set<string>();
    for (const e of g.edges) {
      endpoints.add(e.source);
      if (e.resolved) endpoints.add(e.target);
    }
    expect(g.nodes.map((n) => n.path)).toEqual([...endpoints].sort());
  }

  test("a wide hub is cut by whole edges to the budget, in order, with every endpoint's node", async () => {
    // 100 leaves with long summaries: the whole graph is well over 30,000 characters.
    const docs: Record<string, string> = {
      "notes/hub.md": note("Hub", Array.from({ length: 100 }, (_, i) => `[[leaf-${String(i).padStart(3, "0")}]]`).join("\n")),
    };
    for (let i = 0; i < 100; i++) docs[`notes/leaf-${String(i).padStart(3, "0")}.md`] = note(`Leaf ${i}`, "Leaf.", "s".repeat(200));
    const { text, parsed } = await graphOf(docs, "notes/hub.md");
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(parsed.truncated).toBe(true);
    expect(parsed.edges.length).toBeGreaterThan(0);
    expect(parsed.edges.length + parsed.omitted_edges!).toBe(100);
    // The walk's order: the first edges, not a sample.
    expect(parsed.edges.map((e) => e.target)).toEqual(
      Array.from({ length: parsed.edges.length }, (_, i) => `notes/leaf-${String(i).padStart(3, "0")}.md`)
    );
    expectCovered(parsed);
  });

  test("an oversized node stops the graph at the edge before it, never mid-string", async () => {
    const { text, parsed } = await graphOf(
      {
        "notes/hub.md": note("Hub", "[[aaa]]\n[[bbb]]\n[[ccc]]"),
        "notes/aaa.md": note("Aaa", "A."),
        "notes/bbb.md": note("B".repeat(40_000), "B."),
        "notes/ccc.md": note("Ccc", "C."),
      },
      "notes/hub.md"
    );
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(parsed.edges.map((e) => e.target)).toEqual(["notes/aaa.md"]);
    expect(parsed).toMatchObject({ truncated: true, omitted_edges: 2 });
    expectCovered(parsed);
  });

  test("a graph within the budget is whole, with no truncation fields", async () => {
    const { parsed } = await graphOf(
      { "notes/hub.md": note("Hub", "[[aaa]]"), "notes/aaa.md": note("Aaa", "A.") },
      "notes/hub.md"
    );
    expect(parsed.edges).toEqual([{ source: "notes/hub.md", target: "notes/aaa.md", resolved: true }]);
    expect(parsed.nodes.map((node) => node.path)).toEqual(["notes/aaa.md", "notes/hub.md"]);
    expect(Object.keys(parsed).sort()).toEqual(["edges", "nodes"]);
  });

  test("an unresolved link whose text is an indexed path is still not a node", async () => {
    // `[[a.md]]` at the root does not resolve (the resolver matches names,
    // not spelled-out paths), yet `a.md` is a document: only the resolution
    // guard keeps it out of the nodes.
    const brain = await makeIndexedBrain({ "a.md": note("A", "Alone."), "b.md": note("B", "Links [[a.md]].") });
    try {
      const { edges, nodes } = await graph("b.md", brain.root);
      expect(edges).toEqual([{ source: "b.md", target: "a.md", resolved: false }]);
      expect(nodes.map((n) => n.path)).toEqual(["b.md"]);
    } finally {
      brain.cleanup();
    }
  });
});

describe("brain_list wrapper", () => {
  async function listOf(docs: Record<string, string>) {
    const brain = await makeIndexedBrain(docs);
    try {
      const list = createBrainTools({
        brain: createBrainAccess(brain.root),
        turn: createTurnContext(),
        lock: toolLockFromKeyed(createKeyedLock()),
      });
      const tool = list.find((t) => t.name === "brain_list") as ToolDefinition;
      const text = resultText(await tool.execute("l", { limit: 100 } as never, undefined, undefined, CTX));
      return {
        text,
        parsed: JSON.parse(text) as { documents: Array<{ path: string }>; truncated?: true; omitted?: number },
      };
    } finally {
      brain.cleanup();
    }
  }

  test("a listing over the budget drops whole rows and says how many", async () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < 100; i++) docs[`notes/n-${i}.md`] = note(`Note ${i} ${"t".repeat(300)}`, "Body.");
    const { text, parsed } = await listOf(docs);
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(parsed.truncated).toBe(true);
    expect(parsed.documents.length).toBeGreaterThan(0);
    expect(parsed.documents.length + parsed.omitted!).toBe(100);
  });

  test("a single oversized row is dropped whole, not cut", async () => {
    const { text, parsed } = await listOf({ "notes/huge.md": note("T".repeat(40_000), "Body.") });
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(parsed).toEqual({ documents: [], truncated: true, omitted: 1 });
  });
});
