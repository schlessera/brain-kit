import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SCHEMA_VERSION } from "@schlessera/brain";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { LinkWalk, ListedDocument } from "@schlessera/brain/queries";
import { BRAIN_BIN, keylessEnv, runCli } from "../../core/tests/cli-harness";
import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";

const CENTER = "notes/odysseus.md";
const ISLAND = "notes/ithaca.md";
const roots: string[] = [];
let root: string;
let client: Client;

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-index-query-"));
  roots.push(dir);
  return dir;
}

function note(title: string, body: string, fields = "status: active\nrelevance: primary\ntags: [Ithaca, voyage]"): string {
  return `---\ntitle: ${title}\ntype: note\ncreated: 2026-01-01\nupdated: 2026-01-02\nsummary: Return to Ithaca\n${fields}\n---\n\n${body}\n`;
}

function edit(dir: string, run: (db: Database) => void): void {
  const db = new Database(join(dir, "brain.db"));
  try {
    run(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close(true);
  }
}

function clone(): string {
  const dir = temporary();
  cpSync(join(root, "brain.db"), join(dir, "brain.db"));
  return dir;
}

function tools(dir: string) {
  const registered = createBrainTools({
    brain: createBrainAccess(dir), turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  return async (name: "brain_list" | "brain_graph", args: Record<string, unknown> = {}) => {
    const tool = registered.find(t => t.name === name)!;
    expect(tool).toBeDefined();
    return tool.execute("query", args as never, undefined, undefined, {} as never);
  };
}

async function graph(call: ReturnType<typeof tools>, args: Record<string, unknown> = {}): Promise<LinkWalk> {
  const result = await call("brain_graph", { path: CENTER, ...args });
  const value = JSON.parse(resultText(result)) as LinkWalk;
  expect(result.details).toEqual({ count: value.edges.length });
  expect(Object.keys(value).sort()).toEqual(["edges", "nodes"]);
  return value;
}

async function list(call: ReturnType<typeof tools>, args: Record<string, unknown> = {}): Promise<ListedDocument[]> {
  const result = await call("brain_list", args);
  const value = JSON.parse(resultText(result)) as { documents: ListedDocument[] };
  expect(result.details).toEqual({ count: value.documents.length });
  expect(Object.keys(value)).toEqual(["documents"]);
  return value.documents;
}

beforeAll(async () => {
  root = temporary();
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  writeFileSync(join(root, CENTER), note("Odysseus", "[[ithaca]] [[Unknown Harbour]] [[odysseus]] [[Absent Island]]"));
  writeFileSync(join(root, ISLAND), note("Ithaca", "[[odysseus]] [[aeaea]]"));
  for (const [island, next] of [["aeaea", "ogygia"], ["ogygia", "scheria"], ["scheria", "pylos"], ["pylos", "ithaca"]]) {
    writeFileSync(join(root, `notes/${island}.md`), note(island, `[[${next}]]`));
  }
  writeFileSync(join(root, "notes/archive.md"), note("Past voyage", "Past voyage.", "status: archived\nrelevance: historical\ntags: [past]"));
  writeFileSync(join(root, "notes/draft.md"), note("Next voyage", "Next voyage.", "status: draft\nrelevance: secondary\ntags: [planned]"));
  for (let i = 0; i < 105; i++) {
    writeFileSync(join(root, `notes/voyage-${String(i).padStart(3, "0")}.md`), note(`Ithaca voyage ${i}`, "Odysseus sails home.", "status: active"));
  }
  const indexed = await runCli(root, ["index", "--force", "--json"]);
  expect(indexed.code, indexed.stderr).toBe(0);
  expect(JSON.parse(indexed.stdout).total).toBeGreaterThan(100);
  edit(root, db => {
    // Challenge a real CLI index with dangling IDs and distinct aliases to
    // the same endpoint, rather than inventing a copy of its schema.
    db.run("UPDATE links SET target_id = 999999 WHERE target = 'Absent Island'");
    const source = db.query<{ id: number }, [string]>("SELECT id FROM documents WHERE path = ?").get(CENTER)!;
    const target = db.query<{ id: number }, [string]>("SELECT id FROM documents WHERE path = ?").get(ISLAND)!;
    db.run("INSERT INTO links (source_id, target, target_id) VALUES (?, 'Ithaca alias', ?)", [source.id, target.id]);
    db.run("UPDATE documents SET status = NULL WHERE path = 'notes/voyage-000.md'");
    db.run("UPDATE documents SET type = 'project', relevance = NULL WHERE path = 'notes/voyage-001.md'");
    db.run("DELETE FROM document_tags WHERE document_id = (SELECT id FROM documents WHERE path = 'notes/voyage-001.md')");
    db.run("UPDATE documents SET type = 'project', updated = '2026-01-03' WHERE path = ?", [ISLAND]);
  });
  client = new Client({ name: "pi-query-parity", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
});

afterAll(async () => {
  await client?.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("registered pi query tools match real core MCP on a populated CLI index", () => {
  test("graph mapping keeps metadata, dangling text, cycles, duplicates, directions and pi's depth cap", async () => {
    const call = tools(root);
    for (const direction of ["outgoing", "incoming", "both"]) {
      for (const depth of [-1, 1, 2, 3, 4, 9]) {
        const actual = await graph(call, { depth, direction });
        const mcp = await client.callTool({ name: "brain_graph", arguments: { path: CENTER, depth: Math.min(4, Math.max(1, depth)), direction } });
        expect(mcp.isError).toBeFalsy();
        expect(actual.edges.length).toBeGreaterThan(0);
        expect(actual.nodes.length).toBeGreaterThan(0);
        const expected = mcp.structuredContent as LinkWalk;
        expect(actual).toEqual({ edges: expected.edges, nodes: expected.nodes });
      }
    }
    const actual = await graph(call);
    expect(actual.edges).toContainEqual({ source: CENTER, target: "Absent Island", resolved: false });
    expect(actual.edges).toContainEqual({ source: CENTER, target: "Unknown Harbour", resolved: false });
    expect(actual.edges.filter(e => e.source === CENTER && e.target === ISLAND)).toHaveLength(1);
    expect(actual.edges).toContainEqual({ source: CENTER, target: CENTER, resolved: true });
    expect(actual.nodes.find(n => n.path === ISLAND)).toEqual({ path: ISLAND, title: "Ithaca", type: "project", summary: "Return to Ithaca", updated: "2026-01-03" });
    expect(actual.nodes.map(n => n.path)).toEqual([...actual.nodes.map(n => n.path)].sort());
    expect(actual.nodes.some(n => n.path === "Absent Island" || n.path === "Unknown Harbour")).toBe(false);
    expect(await graph(call, { path: "notes/absent.md" })).toEqual({ edges: [], nodes: [] });
  });

  test("listing mapping keeps nonempty filters, archive/null semantics, order and default/min/max limits", async () => {
    const call = tools(root);
    const filters = [{}, { type: "project" }, { tag: "Ithaca" }, { status: "draft" }, { status: "archived" }, { relevance: "secondary" }, { type: "note", tag: "Ithaca", status: "active", relevance: "primary" }, { limit: 0 }, { limit: 1000 }];
    for (const args of filters) {
      const actual = await list(call, args);
      const mcp = await client.callTool({ name: "brain_list", arguments: args });
      expect(mcp.isError).toBeFalsy();
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual((mcp.structuredContent as { documents: ListedDocument[] }).documents);
    }
    const defaults = await list(call);
    expect(defaults).toHaveLength(20);
    expect(defaults[0]).toEqual({ path: ISLAND, title: "Ithaca", type: "project", relevance: "primary", status: "active", tags: "Ithaca, voyage" });
    const all = await list(call, { limit: 1000 });
    expect(all).toHaveLength(100);
    expect(all.some(d => d.path === "notes/archive.md" || d.path === "notes/voyage-000.md")).toBe(false);
    expect((await list(call, { type: "project" })).some(d => d.relevance === null && d.tags === null)).toBe(true);
    expect(await list(call, { tag: "absent" })).toEqual([]);
  });
});

describe("registered pi query tools refuse incompatible or unusable indexes safely", () => {
  test("unknown newer versions fail through both registered tools", async () => {
    const dir = clone();
    edit(dir, db => db.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 1)]));
    const call = tools(dir);
    await expect(call("brain_list")).rejects.toThrow("Brain index is incompatible");
    await expect(call("brain_graph", { path: CENTER })).rejects.toThrow("Brain index is incompatible");
  });

  test("old and malformed versions and missing required columns fail without native diagnostics", async () => {
    for (const version of ["2", "15junk"]) {
      const dir = clone();
      edit(dir, db => db.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [version]));
      await expect(tools(dir)("brain_list")).rejects.toThrow("Brain index is incompatible");
    }
    const dir = clone();
    edit(dir, db => db.exec("ALTER TABLE documents DROP COLUMN title"));
    await expect(tools(dir)("brain_list")).rejects.toThrow("Brain index is corrupt — rebuild it with `brain index --force`.");
  });

  test("missing, corrupt and unavailable files keep actionable sanitized tool errors", async () => {
    const dir = temporary();
    const call = tools(dir);
    await expect(call("brain_list")).rejects.toThrow("Brain database not found — run `brain index` first.");
    writeFileSync(join(dir, "brain.db"), "Odysseus: unusable index");
    await expect(call("brain_graph", { path: CENTER })).rejects.toThrow("Brain index is corrupt");
    rmSync(join(dir, "brain.db"));
    mkdirSync(join(dir, "brain.db"));
    await expect(call("brain_list")).rejects.toThrow("Brain index is unavailable.");
  });

  test("a real exclusive lock produces a retryable message within the bounded wait", async () => {
    const dir = clone();
    const writer = new Database(join(dir, "brain.db"));
    writer.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
    try {
      const started = performance.now();
      await expect(tools(dir)("brain_list")).rejects.toThrow("Brain index is busy — try again.");
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      writer.exec("ROLLBACK");
      writer.close(true);
    }
  });

  test("invalid query inputs surface only the sanitized tool error", async () => {
    const call = tools(root);
    for (const [name, args] of [
      ["brain_graph", { path: "../odysseus.md" }],
      ["brain_graph", { path: CENTER, depth: NaN }],
      ["brain_list", { limit: 1.5 }],
      ["brain_list", { tag: "Ithaca\u0000" }],
    ] as const) {
      await expect(call(name, args)).rejects.toMatchObject({ message: "Invalid brain index query." });
    }
  });
});

const nativeQuery = Database.prototype.query;
async function observe<T>(run: () => Promise<T>, hook: (db: Database, sql: string) => void): Promise<T> {
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    hook(this, sql);
    return nativeQuery.call(this, sql);
  } as typeof nativeQuery);
  try { return await run(); } finally { spy.mockRestore(); }
}

describe("registered pi tools keep the core query snapshot and connection lifetime", () => {
  test("WAL deletion between edges and nodes keeps one graph snapshot and refreshes the next call", async () => {
    const dir = clone();
    const call = tools(dir);
    const before = await graph(call);
    expect(before.nodes.some(n => n.path === ISLAND)).toBe(true);
    const writer = new Database(join(dir, "brain.db"));
    writer.exec("PRAGMA journal_mode=WAL");
    let committed = false;
    try {
      const actual = await observe(() => graph(call), (_db, sql) => {
        if (!committed && sql.includes("WHERE path IN (SELECT value FROM json_each(?))")) {
          committed = true;
          writer.run("DELETE FROM documents WHERE path = ?", [ISLAND]);
        }
      });
      expect(committed).toBe(true);
      expect(actual, "edges and metadata must come from the pre-deletion snapshot").toEqual(before);
      const next = await graph(call);
      expect(next.nodes.some(n => n.path === ISLAND)).toBe(false);
      expect(next.edges).toContainEqual({ source: CENTER, target: "ithaca", resolved: false });
    } finally { writer.close(true); }
  });

  test("WAL compatibility and listing stay together, with the next call rejecting the new version", async () => {
    const dir = clone();
    const call = tools(dir);
    const before = await list(call);
    expect(before.length).toBeGreaterThan(0);
    const writer = new Database(join(dir, "brain.db"));
    writer.exec("PRAGMA journal_mode=WAL");
    let committed = false;
    try {
      const actual = await observe(() => list(call), (_db, sql) => {
        if (!committed && sql.startsWith("SELECT d.path, d.title")) {
          committed = true;
          writer.transaction(() => {
            writer.run("UPDATE documents SET title = 'Changed Ithaca'");
            writer.run("UPDATE index_metadata SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 1)]);
          })();
        }
      });
      expect(committed).toBe(true);
      expect(actual, "compatibility and rows must come from the same pre-write snapshot").toEqual(before);
      await expect(call("brain_list")).rejects.toThrow("Brain index is incompatible");
    } finally { writer.close(true); }
  });

  test("both tools reopen a valid checkpointed replacement and keep old results detached", async () => {
    const dir = clone();
    const replacement = clone();
    edit(replacement, db => db.exec("UPDATE documents SET title = 'Replaced Ithaca'"));
    const call = tools(dir);
    const oldList = await list(call);
    const oldGraph = await graph(call);
    expect(oldList.some(d => d.title !== "Replaced Ithaca")).toBe(true);
    expect(oldGraph.nodes.some(d => d.title !== "Replaced Ithaca")).toBe(true);
    renameSync(join(replacement, "brain.db"), join(dir, "brain.db"));
    const nextList = await list(call);
    const nextGraph = await graph(call);
    expect(nextList.length).toBeGreaterThan(0);
    expect(nextGraph.nodes.length).toBeGreaterThan(0);
    expect(nextList.every(d => d.title === "Replaced Ithaca")).toBe(true);
    expect(nextGraph.nodes.every(d => d.title === "Replaced Ithaca")).toBe(true);
    expect(oldList.some(d => d.title !== "Replaced Ithaca")).toBe(true);
    expect(oldGraph.nodes.some(d => d.title !== "Replaced Ithaca")).toBe(true);
  });

  test("list and graph initialize no executable config and close each native read connection", async () => {
    const dir = clone();
    writeFileSync(join(dir, "brain.config.ts"), "throw new Error('Odysseus config must not run');");
    const call = tools(dir);
    const connections = new Set<Database>();
    await observe(async () => {
      expect((await list(call)).length).toBeGreaterThan(0);
      expect((await graph(call)).edges.length).toBeGreaterThan(0);
    }, db => { connections.add(db); expect(db.inTransaction).toBe(true); });
    expect(connections.size).toBe(2);
    for (const connection of connections) expect(() => connection.query("SELECT 1")).toThrow("closed");
  });
});
