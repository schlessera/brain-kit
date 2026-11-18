/**
 * Harness for the multi-root link-traversal spike (#3646). Not a test file
 * itself. Nothing here is exported from a package or registered as a tool:
 * `walkLinksMulti` is a private prototype that exists only to be measured
 * against independent `walkLinks` / `brain_graph` calls.
 *
 * The fixture is an Odysseus project graph, every document dated at the
 * pinned `2026-07-12`, written to a temporary brain and indexed by the real
 * CLI so link resolution is the shipped indexer's.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LinkEdge, LinkNode } from "../packages/core/src/lib/link-walk";

export const PINNED_DATE = "2026-07-12";
export type Direction = "outgoing" | "incoming" | "both";

// --- Fixture ---------------------------------------------------------------

const SHIPS = 12;
const ROSTER_PAGES = 12;
const pad = (n: number) => String(n).padStart(2, "0");

function note(title: string, summary: string, links: string[]): string {
  const body = links.length ? links.map((l) => `[[${l}]]`).join(" ") : "No links.";
  return (
    `---\ntitle: "${title}"\ntype: note\ncreated: ${PINNED_DATE}\nupdated: ${PINNED_DATE}\n` +
    `summary: "${summary}"\nstatus: active\nrelevance: primary\ntags: [voyage]\n---\n\n${body}\n`
  );
}

/**
 * Every fixture document, path to markdown. Shape, by design:
 * - `raft` and `passage` share the neighbour `sail` (and `calypso` at two hops);
 * - `raft` <-> `sail`, `passage` <-> `star-bearings` and `loom` <-> `suitors`
 *   are cycles, and `raft` links to itself;
 * - `loom` is disconnected from every other root, and `driftwood` has no
 *   links at all;
 * - `crew-ledger` is one large neighbourhood (12 ships, 144 roster pages)
 *   that `raft` also reaches;
 * - `Bronze Axe`, `Poseidon Forecast`, `Laertes Shroud Pattern` and
 *   `Thrinacia` are unresolved links.
 */
export function fixtureDocuments(): Record<string, string> {
  const docs: Record<string, string> = {
    "notes/raft.md": note("Raft build", "Build the raft on Ogygia before the July 29 departure",
      ["timber", "sail", "calypso", "crew-ledger", "Bronze Axe", "raft"]),
    "notes/passage.md": note("Seventeen-day passage", "Sail from Ogygia to Scheria by the stars",
      ["sail", "star-bearings", "scheria", "Poseidon Forecast"]),
    "notes/timber.md": note("Twenty trees", "Felled timber for the deck frame", ["calypso"]),
    "notes/sail.md": note("Sail", "Woven sail sized for the raft mast", ["raft", "canvas"]),
    "notes/canvas.md": note("Canvas", "Cloth Calypso supplies for the sail", []),
    "notes/calypso.md": note("Calypso", "Keeper of Ogygia and of the tools", ["ogygia"]),
    "notes/ogygia.md": note("Ogygia", "Island of seven years", []),
    "notes/star-bearings.md": note("Star bearings", "Keep the Bear on the left hand", ["passage"]),
    "notes/scheria.md": note("Scheria", "Landfall among the Phaeacians", ["ithaca"]),
    "notes/ithaca.md": note("Ithaca", "Home, held by Penelope", ["telemachus"]),
    "notes/telemachus.md": note("Telemachus", "Seeking news in Sparta", []),
    "notes/loom.md": note("Penelope's loom", "The shroud woven by day and unpicked by night",
      ["shroud", "suitors", "Laertes Shroud Pattern"]),
    "notes/shroud.md": note("Shroud", "Burial cloth for Laertes", []),
    "notes/suitors.md": note("Suitors", "Waiting for the shroud to be finished", ["loom"]),
    "notes/driftwood.md": note("Driftwood", "A plank washed up on the beach, linked to nothing", []),
    "notes/crew-ledger.md": note("Crew ledger", "600 men in 12 ships from Troy; no survivors after Thrinacia",
      [...Array.from({ length: SHIPS }, (_, s) => `ship-${pad(s + 1)}`), "Thrinacia"]),
  };
  for (let s = 1; s <= SHIPS; s++) {
    const pages = Array.from({ length: ROSTER_PAGES }, (_, p) => `roster-${pad(s)}-${pad(p + 1)}`);
    docs[`notes/ship-${pad(s)}.md`] = note(`Ship ${s}`, `Ship ${s} of the twelve that left Troy, with its fifty oarsmen`,
      ["crew-ledger", ...pages]);
    for (let p = 1; p <= ROSTER_PAGES; p++) {
      docs[`notes/roster-${pad(s)}-${pad(p)}.md`] = note(`Ship ${s} roster page ${p}`,
        `Oarsmen listed on page ${p} of the ship ${s} roster, all lost after Thrinacia`, [`ship-${pad(s)}`]);
    }
  }
  return docs;
}

export function writeFixture(root: string): void {
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  for (const [rel, content] of Object.entries(fixtureDocuments())) writeFileSync(join(root, rel), content);
}

/** The comparison scenarios: roots, depth, direction, and the evidence a task over them needs. */
export interface Scenario {
  id: string;
  roots: string[];
  depth: number;
  direction: Direction;
  /** Edge keys (`source->target`) a task over these roots needs to see. */
  evidence: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "overlap-1",
    roots: ["notes/raft.md", "notes/passage.md"],
    depth: 1,
    direction: "both",
    evidence: ["notes/raft.md->notes/sail.md", "notes/passage.md->notes/sail.md", "notes/raft.md->Bronze Axe",
      "notes/passage.md->Poseidon Forecast", "notes/star-bearings.md->notes/passage.md"],
  },
  {
    id: "disjoint-2",
    roots: ["notes/passage.md", "notes/loom.md"],
    depth: 2,
    direction: "both",
    evidence: ["notes/passage.md->notes/scheria.md", "notes/scheria.md->notes/ithaca.md",
      "notes/loom.md->Laertes Shroud Pattern", "notes/suitors.md->notes/loom.md"],
  },
  {
    id: "hub-2",
    roots: ["notes/crew-ledger.md", "notes/raft.md", "notes/passage.md", "notes/loom.md"],
    depth: 2,
    direction: "both",
    evidence: ["notes/raft.md->notes/sail.md", "notes/raft.md->Bronze Axe", "notes/timber.md->notes/calypso.md",
      "notes/passage.md->Poseidon Forecast", "notes/scheria.md->notes/ithaca.md", "notes/loom.md->notes/suitors.md",
      "notes/loom.md->Laertes Shroud Pattern", "notes/crew-ledger.md->Thrinacia", "notes/ship-12.md->notes/roster-12-12.md"],
  },
  {
    id: "outgoing-3",
    roots: ["notes/raft.md", "notes/passage.md"],
    depth: 3,
    direction: "outgoing",
    evidence: ["notes/sail.md->notes/canvas.md", "notes/calypso.md->notes/ogygia.md",
      "notes/ithaca.md->notes/telemachus.md", "notes/ship-01.md->notes/roster-01-01.md"],
  },
  {
    id: "incoming-2",
    roots: ["notes/sail.md", "notes/calypso.md"],
    depth: 2,
    direction: "incoming",
    evidence: ["notes/raft.md->notes/sail.md", "notes/passage.md->notes/sail.md", "notes/timber.md->notes/calypso.md",
      "notes/star-bearings.md->notes/passage.md"],
  },
];

// --- Instrumentation -------------------------------------------------------

export interface Work {
  /** SQL statements executed (`all`/`get`). */
  statements: number;
  /** Rows those statements returned. */
  rows: number;
}

/**
 * A view of `db` that counts executed statements and returned rows, so the
 * shipped `walkLinks` can be measured without changing it. Everything other
 * than `prepare`/`query` passes through, bound to the real connection.
 */
export function countingDb(db: Database, work: Work): Database {
  const wrap = <S extends object>(statement: S): S =>
    new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "all" || prop === "get") {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            work.statements++;
            work.rows += Array.isArray(result) ? result.length : result == null ? 0 : 1;
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare" || prop === "query") {
        return (...args: unknown[]) => wrap((value as (...a: unknown[]) => object).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// --- Prototype -------------------------------------------------------------

export interface MultiRootBounds {
  /** More roots than this is refused, never silently dropped. */
  maxRoots: number;
  maxEdges: number;
  maxNodes: number;
  /** Serialized JSON length of the whole result. */
  maxChars: number;
  /** SQL statements the traversal may execute; the node lookup is reserved. */
  maxStatements: number;
}

export interface RootSummary {
  path: string;
  status: "found" | "missing" | "duplicate";
  /** For a duplicate, the index of the root it repeats. */
  duplicate_of?: number;
  /** True when every edge this root reaches is in `edges`. */
  complete: boolean;
  reached_edges: number;
  returned_edges: number;
  omitted_edges: number;
  /** The work bound stopped this root's walk early; `reached_edges` is a lower bound. */
  work_exhausted?: true;
}

export interface MultiRootEdge extends LinkEdge {
  /** Indices into `roots` of every root whose walk reaches this edge. */
  roots: number[];
}

export interface MultiRootResult {
  /** True only when every found root is complete. */
  complete: boolean;
  roots: RootSummary[];
  edges: MultiRootEdge[];
  nodes: LinkNode[];
}

export interface MultiRootOptions {
  roots: string[];
  /** Hops, already clamped by the caller as for `walkLinks`. */
  depth: number;
  direction: Direction;
  bounds: MultiRootBounds;
  /** `fair` takes edges round-robin across roots; `sequential` is the naive root-order cut. */
  strategy?: "fair" | "sequential";
}

/** Width of the largest count, so reserved summary space is never short. */
const COUNT_PLACEHOLDER = Number.MAX_SAFE_INTEGER;
const OUTGOING = `SELECT d.path AS source, COALESCE(t.path, l.target) AS target, t.id IS NOT NULL AS resolved
  FROM links l JOIN documents d ON d.id = l.source_id LEFT JOIN documents t ON t.id = l.target_id WHERE d.path = ?`;
const INCOMING = `SELECT d2.path AS source, d.path AS target FROM links l
  JOIN documents d ON d.id = l.target_id JOIN documents d2 ON d2.id = l.source_id WHERE d.path = ?`;
const edgeKey = (e: { source: string; target: string }) => `${e.source}->${e.target}`;

/**
 * Walk several roots inside ONE read transaction. Each root keeps exactly the
 * reachability of its own `walkLinks` call (same hop loop, same per-root
 * dedup); expansions are memoised across roots, edges are unioned with the
 * roots that reach them, and the result is cut under global bounds.
 *
 * Hooks are test seams: `betweenRoots` runs after each root's walk and
 * `afterEdges` between the traversal and the node lookup, where a concurrent
 * writer would do harm.
 */
export function walkLinksMulti(
  db: Database,
  opts: MultiRootOptions,
  hooks: { betweenRoots?: (index: number) => void; afterEdges?: () => void } = {}
): MultiRootResult {
  const { bounds } = opts;
  if (opts.roots.length === 0) throw new Error("at least one root is required");
  if (opts.roots.length > bounds.maxRoots) throw new Error(`at most ${bounds.maxRoots} roots per call`);

  return db.transaction(() => {
    let statements = 0;
    const budget = bounds.maxStatements - 1; // the node lookup
    const memo = new Map<string, LinkEdge[]>();
    const exists = db.prepare("SELECT 1 FROM documents WHERE path = ?");
    const summaries: RootSummary[] = [];
    const rootEdges: LinkEdge[][] = [];

    /** One expansion of one path, shared by every root that reaches it; null when out of work. */
    const expand = (path: string): LinkEdge[] | null => {
      const cached = memo.get(path);
      if (cached) return cached;
      const wantOut = opts.direction !== "incoming";
      const wantIn = opts.direction !== "outgoing";
      if (statements + Number(wantOut) + Number(wantIn) > budget) return null;
      const found: LinkEdge[] = [];
      if (wantOut) {
        statements++;
        for (const r of db.prepare(OUTGOING).all(path) as Array<{ source: string; target: string; resolved: number }>) {
          found.push({ source: r.source, target: r.target, resolved: r.resolved === 1 });
        }
      }
      if (wantIn) {
        statements++;
        for (const r of db.prepare(INCOMING).all(path) as Array<{ source: string; target: string }>) {
          found.push({ source: r.source, target: r.target, resolved: true });
        }
      }
      memo.set(path, found);
      return found;
    };

    opts.roots.forEach((path, index) => {
      const first = opts.roots.indexOf(path);
      if (first !== index) {
        summaries.push({ path, status: "duplicate", duplicate_of: first, complete: true, reached_edges: 0, returned_edges: 0, omitted_edges: 0 });
        rootEdges.push([]);
        return;
      }
      if (statements + 1 > budget) {
        summaries.push({ path, status: "found", complete: false, reached_edges: 0, returned_edges: 0, omitted_edges: 0, work_exhausted: true });
        rootEdges.push([]);
        return;
      }
      statements++;
      if (!exists.get(path)) {
        summaries.push({ path, status: "missing", complete: true, reached_edges: 0, returned_edges: 0, omitted_edges: 0 });
        rootEdges.push([]);
        return;
      }
      // The walkLinks hop loop, verbatim in shape, over shared expansions.
      const edges: LinkEdge[] = [];
      const visited = new Set<string>();
      let frontier = new Set<string>([path]);
      let exhausted = false;
      walk: for (let hop = 0; hop < opts.depth; hop++) {
        const next = new Set<string>();
        for (const current of frontier) {
          if (visited.has(current)) continue;
          visited.add(current);
          const found = expand(current);
          if (!found) { exhausted = true; break walk; }
          for (const e of found) {
            edges.push(e);
            if (e.resolved) next.add(e.source === current ? e.target : e.source);
          }
        }
        frontier = next;
      }
      const seen = new Set<string>();
      const unique = edges.filter((e) => !seen.has(edgeKey(e)) && seen.add(edgeKey(e)));
      rootEdges.push(unique);
      summaries.push({ path, status: "found", complete: false, reached_edges: unique.length, returned_edges: 0, omitted_edges: 0, ...(exhausted ? { work_exhausted: true as const } : {}) });
      hooks.betweenRoots?.(index);
    });

    // Union, keeping every association.
    const union = new Map<string, MultiRootEdge>();
    rootEdges.forEach((edges, index) => {
      for (const e of edges) {
        const entry = union.get(edgeKey(e)) ?? { ...e, roots: [] };
        entry.roots.push(index);
        union.set(edgeKey(e), entry);
      }
    });

    hooks.afterEdges?.();

    const touched = new Set<string>();
    for (const e of union.values()) {
      touched.add(e.source);
      if (e.resolved) touched.add(e.target);
    }
    const allNodes = db
      .prepare(`SELECT path, title, type, summary, updated FROM documents WHERE path IN (SELECT value FROM json_each(?)) ORDER BY path`)
      .all(JSON.stringify([...touched])) as LinkNode[];
    const byPath = new Map(allNodes.map((n) => [n.path, n]));

    // Selection under the global bounds. The reserve sizes the envelope with
    // every summary at its widest, so the final JSON never exceeds maxChars.
    const reserve = JSON.stringify({
      complete: false,
      roots: summaries.map((s) => ({ ...s, complete: false, reached_edges: COUNT_PLACEHOLDER, returned_edges: COUNT_PLACEHOLDER, omitted_edges: COUNT_PLACEHOLDER, work_exhausted: true })),
      edges: [],
      nodes: [],
    }).length;
    let size = reserve;
    const selected = new Set<string>();
    const keptNodes = new Set<string>();
    const kept: MultiRootEdge[] = [];
    const cursor = rootEdges.map(() => 0);
    const blocked = rootEdges.map(() => false);

    /** Take a root's next unselected edge; false when it is done or does not fit. */
    const take = (index: number): boolean => {
      const edges = rootEdges[index]!;
      while (cursor[index]! < edges.length && selected.has(edgeKey(edges[cursor[index]!]!))) cursor[index]!++;
      if (cursor[index]! >= edges.length) return false;
      const edge = union.get(edgeKey(edges[cursor[index]!]!))!;
      const fresh = [edge.source, ...(edge.resolved ? [edge.target] : [])].filter(
        (p, i, all) => !keptNodes.has(p) && byPath.has(p) && all.indexOf(p) === i
      );
      let cost = JSON.stringify(edge).length + (kept.length > 0 ? 1 : 0);
      fresh.forEach((p, i) => { cost += JSON.stringify(byPath.get(p)).length + (keptNodes.size > 0 || i > 0 ? 1 : 0); });
      if (size + cost > bounds.maxChars || kept.length + 1 > bounds.maxEdges || keptNodes.size + fresh.length > bounds.maxNodes) {
        blocked[index] = true;
        return false;
      }
      kept.push(edge);
      selected.add(edgeKey(edge));
      for (const p of fresh) keptNodes.add(p);
      size += cost;
      cursor[index]!++;
      return true;
    };

    if (opts.strategy === "sequential") {
      for (let i = 0; i < rootEdges.length; i++) while (!blocked[i] && take(i));
    } else {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let i = 0; i < rootEdges.length; i++) if (!blocked[i] && take(i)) progressed = true;
      }
    }

    // Kept edges in a stable order: each root's walk order, roots in order.
    const order = new Map<string, number>();
    rootEdges.flat().forEach((e) => { if (!order.has(edgeKey(e))) order.set(edgeKey(e), order.size); });
    kept.sort((a, b) => order.get(edgeKey(a))! - order.get(edgeKey(b))!);

    for (const [index, s] of summaries.entries()) {
      if (s.status !== "found") continue;
      s.returned_edges = rootEdges[index]!.filter((e) => selected.has(edgeKey(e))).length;
      s.omitted_edges = s.reached_edges - s.returned_edges;
      s.complete = s.omitted_edges === 0 && !s.work_exhausted;
    }
    return {
      complete: summaries.every((s) => s.complete),
      roots: summaries,
      edges: kept,
      nodes: allNodes.filter((n) => keptNodes.has(n.path)),
    };
  })();
}

// --- Measurement helpers ---------------------------------------------------

export interface WalkLike {
  edges: Array<{ source: string; target: string; resolved: boolean }>;
  nodes: Array<{ path: string }>;
}

/** Edges and nodes that appear in more than one independent result, and the bytes they cost. */
export function duplication(results: WalkLike[]): { duplicateEdges: number; duplicateNodes: number; sumBytes: number; unionBytes: number } {
  const edges = new Map<string, WalkLike["edges"][number]>();
  const nodes = new Map<string, WalkLike["nodes"][number]>();
  let totalEdges = 0;
  let totalNodes = 0;
  let sumBytes = 0;
  for (const r of results) {
    sumBytes += JSON.stringify({ edges: r.edges, nodes: r.nodes }).length;
    totalEdges += r.edges.length;
    totalNodes += r.nodes.length;
    for (const e of r.edges) edges.set(edgeKey(e), e);
    for (const n of r.nodes) nodes.set(n.path, n);
  }
  const unionBytes = JSON.stringify({ edges: [...edges.values()], nodes: [...nodes.values()] }).length;
  return { duplicateEdges: totalEdges - edges.size, duplicateNodes: totalNodes - nodes.size, sumBytes, unionBytes };
}

/** The share of a scenario's evidence edges present in any of the results. */
export function coverage(evidence: string[], results: WalkLike[]): number {
  const present = new Set(results.flatMap((r) => r.edges.map(edgeKey)));
  return evidence.filter((k) => present.has(k)).length / evidence.length;
}

/** Median wall time of `runs` executions, in milliseconds. */
export async function medianMs(runs: number, fn: () => unknown): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)]! * 100) / 100;
}
