/**
 * Multi-root link traversal spike (#3646): independent parallel `walkLinks` /
 * `brain_graph` calls against the private `walkLinksMulti` prototype, over a
 * real CLI index of the Odysseus project fixture. Keyless and offline: the
 * core MCP server runs over stdio, the Pi tools in process.
 *
 * Run: `bun run test ./experiments/multi-root-graph.test.ts`. Measurements are
 * printed as `MULTI_ROOT_*` lines; only deterministic quantities are asserted.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { walkLinks, type LinkEdge } from "../packages/core/src/lib/link-walk";
import { MAX_GRAPH_DEPTH } from "../packages/core/src/mcp-server";
import { BRAIN_BIN, keylessEnv, runCli } from "../packages/core/tests/cli-harness";
import { createBrainAccess } from "../packages/ui-backend-pi/src/brain-access";
import { MAX_OUTPUT_BYTES } from "../packages/ui-backend-pi/src/tool-kit";
import { createBrainTools, toolLockFromKeyed } from "../packages/ui-backend-pi/src/tools";
import { createTurnContext } from "../packages/ui-backend-pi/src/turn-context";
import {
  PINNED_DATE, SCENARIOS, countingDb, coverage, duplication, fixtureDocuments, medianMs, walkLinksMulti, writeFixture,
  type Direction, type MultiRootBounds, type MultiRootResult, type WalkLike, type Work,
} from "./multi-root-graph";

const PI_DEPTH_CAP = 4; // readLinkWalk's clamp, packages/core/src/queries/index.ts
const UNBOUNDED: MultiRootBounds = { maxRoots: 64, maxEdges: Infinity, maxNodes: Infinity, maxChars: Infinity, maxStatements: Infinity };
/** The candidate bounds: one Pi tool result's budget for the whole call. */
const CANDIDATE: MultiRootBounds = { maxRoots: 8, maxEdges: 500, maxNodes: 500, maxChars: MAX_OUTPUT_BYTES, maxStatements: 2_000 };
const ALL_ROOTS = Object.keys(fixtureDocuments()).filter((p) => !/\/(ship|roster)-/.test(p));

const dirs: string[] = [];
let root: string;
let db: Database;
let client: Client;

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "multi-root-graph-"));
  dirs.push(dir);
  return dir;
}

/** A private copy of the index, so a destructive writer leaves the shared one alone. */
function clone(): string {
  const dir = temporary();
  mkdirSync(join(dir, ".brain-index"));
  cpSync(join(root, ".brain-index", "brain.db"), join(dir, ".brain-index", "brain.db"));
  return dir;
}

function piTools(dir: string) {
  const registered = createBrainTools({ brain: createBrainAccess(dir), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
  const tool = registered.find((t) => t.name === "brain_graph")!;
  return async (args: { path: string; depth?: number; direction?: Direction }) => {
    const result = await tool.execute("graph", args as never, undefined, undefined, {} as never);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    return { text, value: JSON.parse(text) as WalkLike & { truncated?: true; omitted_edges?: number } };
  };
}

async function mcpGraph(args: { path: string; depth: number; direction: Direction }) {
  const result = await client.callTool({ name: "brain_graph", arguments: args });
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, wire: JSON.stringify(result).length, value: result.structuredContent as unknown as WalkLike };
}

const key = (e: { source: string; target: string }) => `${e.source}->${e.target}`;
const sortedEdges = (edges: LinkEdge[]) => [...edges].map((e) => ({ source: e.source, target: e.target, resolved: e.resolved })).sort((a, b) => key(a).localeCompare(key(b)));
const withoutProvenance = (r: MultiRootResult, index: number) => sortedEdges(r.edges.filter((e) => e.roots.includes(index)));

beforeAll(async () => {
  root = temporary();
  writeFixture(root);
  const indexed = await runCli(root, ["index", "--force", "--json"]);
  expect(indexed.code, indexed.stderr).toBe(0);
  db = new Database(join(root, ".brain-index", "brain.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  client = new Client({ name: "multi-root-graph", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BRAIN_BIN, "mcp"], env: keylessEnv(root) }));
  const { sqlite } = db.query<{ sqlite: string }, []>("SELECT sqlite_version() AS sqlite").get()!;
  const fixtureHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(fixtureDocuments())).digest("hex");
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim();
  console.log(`MULTI_ROOT_IDENTITY ${JSON.stringify({ head, bun: Bun.version, sqlite, fixture_sha256: fixtureHash, documents: Object.keys(fixtureDocuments()).length, pinned_date: PINNED_DATE })}`);
});

afterAll(async () => {
  await client?.close();
  db?.close(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("fixture", () => {
  test("indexes the designed graph: shared neighbours, cycles, a disconnected root, an isolated note and unresolved links", () => {
    const raft = walkLinks(db, { path: "notes/raft.md", depth: 1, direction: "outgoing" }).edges;
    const passage = walkLinks(db, { path: "notes/passage.md", depth: 1, direction: "outgoing" }).edges;
    expect(raft).toContainEqual({ source: "notes/raft.md", target: "notes/sail.md", resolved: true });
    expect(passage).toContainEqual({ source: "notes/passage.md", target: "notes/sail.md", resolved: true });
    expect(raft).toContainEqual({ source: "notes/raft.md", target: "Bronze Axe", resolved: false });
    expect(raft).toContainEqual({ source: "notes/raft.md", target: "notes/raft.md", resolved: true });
    expect(walkLinks(db, { path: "notes/suitors.md", depth: 1, direction: "outgoing" }).edges).toEqual([{ source: "notes/suitors.md", target: "notes/loom.md", resolved: true }]);
    const loomWorld = walkLinks(db, { path: "notes/loom.md", depth: 4, direction: "both" });
    expect(loomWorld.nodes.map((n) => n.path)).toEqual(["notes/loom.md", "notes/shroud.md", "notes/suitors.md"]);
    expect(walkLinks(db, { path: "notes/driftwood.md", depth: 4, direction: "both" })).toEqual({ edges: [], nodes: [] });
    expect(walkLinks(db, { path: "notes/crew-ledger.md", depth: 2, direction: "both" }).edges.length).toBeGreaterThan(300);
    const dates = db.query<{ d: string }, []>("SELECT DISTINCT updated AS d FROM documents").all();
    expect(dates).toEqual([{ d: PINNED_DATE }]);
  });
});

describe("reachability: the prototype preserves each root's own walk", () => {
  test("unbounded, every root's attributed edges equal its walkLinks edges, for every direction and depth", () => {
    for (const direction of ["outgoing", "incoming", "both"] as const) {
      for (const depth of [1, 2, 3, 4, MAX_GRAPH_DEPTH]) {
        const result = walkLinksMulti(db, { roots: ALL_ROOTS, depth, direction, bounds: UNBOUNDED });
        expect(result.complete).toBe(true);
        const nodes = new Set<string>();
        ALL_ROOTS.forEach((path, i) => {
          const single = walkLinks(db, { path, depth, direction });
          expect(withoutProvenance(result, i)).toEqual(sortedEdges(single.edges));
          expect(result.roots[i]!.reached_edges).toBe(single.edges.length);
          for (const n of single.nodes) nodes.add(n.path);
        });
        expect(result.nodes.map((n) => n.path)).toEqual([...nodes].sort());
      }
    }
  });

  test("deduplication keeps every root association and unresolved link", () => {
    const result = walkLinksMulti(db, { roots: ["notes/raft.md", "notes/passage.md"], depth: 2, direction: "both", bounds: UNBOUNDED });
    const edge = (k: string) => result.edges.find((e) => key(e) === k);
    expect(edge("notes/sail.md->notes/canvas.md")).toEqual({ source: "notes/sail.md", target: "notes/canvas.md", resolved: true, roots: [0, 1] });
    // passage reaches raft at its second hop, so it expands raft only at depth 3.
    expect(edge("notes/raft.md->Bronze Axe")).toEqual({ source: "notes/raft.md", target: "Bronze Axe", resolved: false, roots: [0] });
    const deeper = walkLinksMulti(db, { roots: ["notes/raft.md", "notes/passage.md"], depth: 3, direction: "both", bounds: UNBOUNDED });
    expect(deeper.edges.find((e) => key(e) === "notes/raft.md->Bronze Axe")!.roots).toEqual([0, 1]);
    expect(edge("notes/passage.md->Poseidon Forecast")).toEqual({ source: "notes/passage.md", target: "Poseidon Forecast", resolved: false, roots: [1] });
    expect(edge("notes/timber.md->notes/calypso.md")!.roots).toEqual([0]);
    expect(new Set(result.edges.map(key)).size).toBe(result.edges.length);
    // Every returned edge keeps the metadata of its document endpoints.
    const paths = new Set(result.nodes.map((n) => n.path));
    for (const e of result.edges) {
      expect(paths.has(e.source)).toBe(true);
      if (e.resolved) expect(paths.has(e.target)).toBe(true);
      else expect(paths.has(e.target)).toBe(false);
    }
  });

  test("duplicate roots point at their first occurrence, and a missing root is not an isolated one", async () => {
    const roots = ["notes/raft.md", "notes/raft.md", "notes/absent.md", "notes/driftwood.md", "notes/loom.md"];
    const result = walkLinksMulti(db, { roots, depth: 1, direction: "both", bounds: UNBOUNDED });
    expect(result.roots.map((r) => [r.status, r.duplicate_of, r.reached_edges])).toEqual([
      ["found", undefined, walkLinks(db, { path: "notes/raft.md", depth: 1, direction: "both" }).edges.length],
      ["duplicate", 0, 0], ["missing", undefined, 0], ["found", undefined, 0],
      ["found", undefined, walkLinks(db, { path: "notes/loom.md", depth: 1, direction: "both" }).edges.length],
    ]);
    expect(result.edges.filter((e) => e.roots.some((i) => i === 1 || i === 2))).toEqual([]);
    // The shipped single-root tools cannot tell the last two cases apart.
    const pi = piTools(root);
    for (const path of ["notes/absent.md", "notes/driftwood.md"]) {
      expect((await mcpGraph({ path, depth: 1, direction: "both" })).value).toEqual({ edges: [], nodes: [], warnings: [] } as never);
      expect((await pi({ path })).value).toEqual({ edges: [], nodes: [] });
    }
  });

  test("root count is refused beyond the bound, never silently dropped", () => {
    expect(() => walkLinksMulti(db, { roots: [], depth: 1, direction: "both", bounds: CANDIDATE })).toThrow("at least one root");
    const nine = Array.from({ length: 9 }, (_, i) => `notes/ship-${String(i + 1).padStart(2, "0")}.md`);
    expect(() => walkLinksMulti(db, { roots: nine, depth: 1, direction: "both", bounds: CANDIDATE })).toThrow("at most 8 roots");
  });
});

describe("the shipped graph paths, called independently in parallel", () => {
  test("core MCP and Pi brain_graph return walkLinks for each root, with their own depth clamps", async () => {
    const pi = piTools(root);
    for (const direction of ["outgoing", "incoming", "both"] as const) {
      for (const depth of [0, 1, 3, 9]) {
        const roots = ["notes/raft.md", "notes/passage.md", "notes/loom.md"];
        const [mcp, local] = await Promise.all([
          Promise.all(roots.map((path) => mcpGraph({ path, depth, direction }))),
          Promise.all(roots.map((path) => pi({ path, depth, direction }))),
        ]);
        roots.forEach((path, i) => {
          const mcpExpected = walkLinks(db, { path, depth: Math.min(Math.max(1, depth), MAX_GRAPH_DEPTH), direction });
          expect({ edges: mcp[i]!.value.edges, nodes: mcp[i]!.value.nodes }).toEqual(mcpExpected);
          const piExpected = walkLinks(db, { path, depth: Math.min(Math.max(1, depth), PI_DEPTH_CAP), direction });
          if (local[i]!.value.truncated) expect(local[i]!.value.edges).toEqual(piExpected.edges.slice(0, local[i]!.value.edges.length));
          else expect(local[i]!.value).toEqual(piExpected);
        });
      }
    }
  });
});

describe("global bounds: one large neighbourhood cannot erase another root", () => {
  const hub = SCENARIOS.find((s) => s.id === "hub-2")!;

  test("the naive root-order cut erases later roots; the fair cut keeps them complete and says the hub is partial", () => {
    const naive = walkLinksMulti(db, { ...hub, bounds: CANDIDATE, strategy: "sequential" });
    const fair = walkLinksMulti(db, { ...hub, bounds: CANDIDATE });
    for (const r of [naive, fair]) expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(naive.roots.find((r) => r.path === "notes/loom.md")).toMatchObject({ complete: false, returned_edges: 0 });
    expect(fair.complete).toBe(false);
    expect(fair.roots.map((r) => [r.path, r.complete])).toEqual([
      ["notes/crew-ledger.md", false], ["notes/raft.md", true], ["notes/passage.md", true], ["notes/loom.md", true],
    ]);
    const ledger = fair.roots[0]!;
    expect(ledger.returned_edges).toBeGreaterThan(0);
    expect(ledger.returned_edges + ledger.omitted_edges).toBe(ledger.reached_edges);
    expect(coverage(hub.evidence, [fair])).toBeGreaterThan(coverage(hub.evidence, [naive]));
  });

  test("the serialized result never exceeds the character bound, at any budget", () => {
    for (let maxChars = 1_500; maxChars <= MAX_OUTPUT_BYTES; maxChars += 97) {
      const result = walkLinksMulti(db, { ...hub, bounds: { ...CANDIDATE, maxChars } });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
    }
  });

  test("edge, node and work bounds each make the result partial instead of short", () => {
    const edges = walkLinksMulti(db, { ...hub, bounds: { ...UNBOUNDED, maxEdges: 40 } });
    expect(edges.edges).toHaveLength(40);
    expect(edges.complete).toBe(false);
    const nodes = walkLinksMulti(db, { ...hub, bounds: { ...UNBOUNDED, maxNodes: 30 } });
    expect(nodes.nodes.length).toBeLessThanOrEqual(30);
    expect(nodes.complete).toBe(false);
    const work: Work = { statements: 0, rows: 0 };
    const starved = walkLinksMulti(countingDb(db, work), { ...hub, bounds: { ...UNBOUNDED, maxStatements: 12 } });
    expect(work.statements).toBeLessThanOrEqual(12);
    expect(starved.complete).toBe(false);
    expect(starved.roots.some((r) => r.work_exhausted)).toBe(true);
    for (const r of starved.roots) if (r.work_exhausted) expect(r.complete).toBe(false);
  });
});

describe("concurrent index updates", () => {
  const writerOn = (dir: string) => new Database(join(dir, ".brain-index", "brain.db"));
  const dropSail = (writer: Database) => writer.run("DELETE FROM documents WHERE path = 'notes/sail.md'");

  test("the existing walkLinks seam still holds on this fixture", () => {
    const dir = clone();
    const reader = new Database(join(dir, ".brain-index", "brain.db"));
    const writer = writerOn(dir);
    try {
      const { edges, nodes } = walkLinks(reader, { path: "notes/raft.md", depth: 1, direction: "outgoing" }, () => dropSail(writer));
      expect(edges).toContainEqual({ source: "notes/raft.md", target: "notes/sail.md", resolved: true });
      expect(nodes.map((n) => n.path)).toContain("notes/sail.md");
    } finally { reader.close(true); writer.close(true); }
  });

  test("independent Pi calls each pin their own snapshot, so a write between them splits the union", async () => {
    const dir = clone();
    const pi = piTools(dir);
    const writer = writerOn(dir);
    try {
      const raft = (await pi({ path: "notes/raft.md" })).value;
      dropSail(writer);
      const passage = (await pi({ path: "notes/passage.md" })).value;
      expect(raft.edges).toContainEqual({ source: "notes/raft.md", target: "notes/sail.md", resolved: true });
      expect(raft.nodes.map((n) => n.path)).toContain("notes/sail.md");
      expect(passage.edges.some((e) => e.source === "notes/passage.md" && e.target === "notes/sail.md")).toBe(false);
    } finally { writer.close(true); }
  });

  test("the prototype reads every root and the node lookup from one snapshot", () => {
    const dir = clone();
    const reader = new Database(join(dir, ".brain-index", "brain.db"));
    const writer = writerOn(dir);
    try {
      const result = walkLinksMulti(reader, { roots: ["notes/raft.md", "notes/passage.md"], depth: 1, direction: "outgoing", bounds: UNBOUNDED }, {
        betweenRoots: (i) => { if (i === 0) dropSail(writer); },
        afterEdges: () => writer.run("DELETE FROM documents WHERE path = 'notes/star-bearings.md'"),
      });
      expect(writer.prepare("SELECT COUNT(*) AS n FROM documents WHERE path IN ('notes/sail.md', 'notes/star-bearings.md')").get()).toEqual({ n: 0 });
      expect(result.edges.find((e) => key(e) === "notes/passage.md->notes/sail.md")).toMatchObject({ resolved: true, roots: [1] });
      expect(result.nodes.map((n) => n.path)).toEqual(expect.arrayContaining(["notes/sail.md", "notes/star-bearings.md"]));
    } finally { reader.close(true); writer.close(true); }
  });
});

describe("measurement", () => {
  test("independent parallel calls against the prototype, per scenario", async () => {
    const pi = piTools(root);
    for (const s of SCENARIOS) {
      const independentWork: Work = { statements: 0, rows: 0 };
      const singles = s.roots.map((path) => walkLinks(countingDb(db, independentWork), { path, depth: s.depth, direction: s.direction }));
      const multiWork: Work = { statements: 0, rows: 0 };
      const unbounded = walkLinksMulti(countingDb(db, multiWork), { ...s, bounds: UNBOUNDED });
      const fair = walkLinksMulti(db, { ...s, bounds: CANDIDATE });
      const naive = walkLinksMulti(db, { ...s, bounds: CANDIDATE, strategy: "sequential" });
      const mcp = await Promise.all(s.roots.map((path) => mcpGraph({ path, depth: s.depth, direction: s.direction })));
      const local = await Promise.all(s.roots.map((path) => pi({ path, depth: s.depth, direction: s.direction })));

      // The prototype's shared expansions never cost more than the independent walks.
      expect(multiWork.statements).toBeLessThanOrEqual(independentWork.statements + s.roots.length);
      const dup = duplication(singles);
      const measurement = {
        scenario: s.id,
        roots: s.roots.length,
        depth: s.depth,
        direction: s.direction,
        work: { independent_walklinks: independentWork, prototype_unbounded: multiWork },
        elapsed_ms_median_of_5: {
          mcp_parallel_calls: await medianMs(5, () => Promise.all(s.roots.map((path) => mcpGraph({ path, depth: s.depth, direction: s.direction })))),
          pi_parallel_calls: await medianMs(5, () => Promise.all(s.roots.map((path) => pi({ path, depth: s.depth, direction: s.direction })))),
          walklinks_in_process: await medianMs(5, () => s.roots.map((path) => walkLinks(db, { path, depth: s.depth, direction: s.direction }))),
          prototype_in_process: await medianMs(5, () => walkLinksMulti(db, { ...s, bounds: CANDIDATE })),
        },
        bytes: {
          mcp_text_sum: mcp.reduce((n, r) => n + r.text.length, 0),
          mcp_wire_sum: mcp.reduce((n, r) => n + r.wire, 0),
          pi_text_sum: local.reduce((n, r) => n + r.text.length, 0),
          pi_truncated_calls: local.filter((r) => r.value.truncated).length,
          prototype_unbounded: JSON.stringify(unbounded).length,
          prototype_candidate: JSON.stringify(fair).length,
        },
        duplicates: { edges: dup.duplicateEdges, nodes: dup.duplicateNodes, independent_bytes: dup.sumBytes, union_bytes_without_provenance: dup.unionBytes },
        evidence_coverage: {
          mcp_union: coverage(s.evidence, mcp.map((r) => r.value)),
          pi_union: coverage(s.evidence, local.map((r) => r.value)),
          prototype_unbounded: coverage(s.evidence, [unbounded]),
          prototype_candidate_fair: coverage(s.evidence, [fair]),
          prototype_candidate_sequential: coverage(s.evidence, [naive]),
        },
        prototype_candidate_complete: fair.complete,
        tokens: "unavailable", cost: "unavailable", real_model_usability: "unavailable",
      };
      expect(measurement.evidence_coverage.mcp_union).toBe(1);
      expect(measurement.evidence_coverage.prototype_unbounded).toBe(1);
      console.log(`MULTI_ROOT_MEASUREMENT ${JSON.stringify(measurement)}`);
    }
  });
});
