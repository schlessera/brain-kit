/**
 * The one reader over the derived graph tables, behind both read surfaces in
 * core: the `brain graph` CLI (`./queries.ts`) and the supported `./queries`
 * API (`../../queries/graph.ts`), whose graph semantics are the former UI
 * server's. Each surface selects a concrete profile below; profiles are not a
 * public option and not an extension point (#1354).
 *
 * The reader owns the mechanics both surfaces share: which documents are
 * nodes, the distinct edge list and its adjacency, path lookup, the
 * breadth-first walk, depth/staleness defaults and bounds, the precomputed
 * root distances, broken links and the scene caps. The adapters own their
 * result shapes and error policy, which differ on purpose:
 *
 * - Node scope. The UI counts a NULL `asset_type` as markdown; the CLI
 *   requires `'markdown'`, as the precompute does.
 * - Edge order. The CLI sorts edges by (source, target); the UI keeps the
 *   engine's DISTINCT order.
 * - Caps. The UI bounds a neighborhood walk and scene at 1,500 nodes and every
 *   other scene at 5,000 nodes / 20,000 edges, ranked by pagerank, and reports
 *   `truncated`; it also limits each maintenance list to 5,000. The CLI has no
 *   cap or walk budget anywhere, so its `truncated` is always false.
 * - Isolates. UI clusters exclude isolates unless asked; CLI clusters include
 *   them unless asked. (The UI judges isolation by precomputed degree, the CLI
 *   by the live links — that, like node degrees and layout fields, is node
 *   materialization and stays with each adapter.)
 * - Paths and missing nodes. The UI strips a leading `./` or `/` and fails a
 *   missing center or root with `not_found`; the CLI matches the stored path
 *   exactly and returns an empty subgraph.
 * - Old and uncomputed data. The UI refuses derived modes before v8 or before
 *   a precompute; the CLI reads whatever exists, degrading a missing derived
 *   table to no rows.
 * - `staleDays`. Both default to 180; the UI clamps to 1..3650, the CLI takes
 *   the value as given. The UI accepts a caller clock and compares the date
 *   prefix in SQL; the CLI uses the system clock and the whole string.
 * - Root seed list. The UI keeps finite JSON numbers; the CLI coerces entries
 *   to integers.
 *
 * Every table read here is governed by docs/integration-contract.md.
 */

import type { Database } from "bun:sqlite";

import type { GraphDirection, GraphEdgeRecord } from "./types.js";

/** Depth beyond this stops being a neighbourhood and becomes the whole vault. */
export const MAX_NEIGHBORHOOD_DEPTH = 3;
/** Discovery rings past this are noise at any realistic corpus size. */
export const MAX_DISCOVERY_DEPTH = 8;
/** Default staleness horizon, matching the core taxonomy default. */
export const DEFAULT_STALE_DAYS = 180;
/** The synthesized virtual-root node; no document carries id 0. */
export const VIRTUAL_ROOT_ID = 0;

const VIRTUAL_ROOT_PREFIX = "virtual:";

export interface GraphProfile {
  /** SQL predicate selecting graph nodes from a `documents` alias. */
  nodeScope(alias: string): string;
  /** Appended to the distinct edge query. */
  edgeOrder: string;
  /** Strip a leading `./` or `/` before looking a path up. */
  normalizePaths: boolean;
  /** Cluster isolates when the caller does not say. */
  isolatesByDefault: boolean;
  /** Walk budget and scene node cap for a neighborhood. */
  neighborhoodNodes: number;
  /** Walk budget and scene node cap for every other scene. */
  sceneNodes: number;
  sceneEdges: number;
  /** Row limit for each maintenance list; Infinity for none. */
  findingLimit: number;
  /** Inclusive staleDays bounds, or null to take the value as given. */
  staleDays: { min: number; max: number } | null;
  /** How the precomputed root seed list is read. */
  rootLinks: "finite" | "integer";
  /** Whether a missing derived table reads as no rows instead of failing. */
  degradeDerived: boolean;
}

/** The supported `./queries` graph: the former UI server's reader. */
export const UI_GRAPH_PROFILE: GraphProfile = Object.freeze({
  nodeScope: (alias: string) => `COALESCE(${alias}.asset_type, 'markdown') = 'markdown'`,
  edgeOrder: "",
  normalizePaths: true,
  isolatesByDefault: false,
  neighborhoodNodes: 1500,
  sceneNodes: 5000,
  sceneEdges: 20000,
  findingLimit: 5000,
  staleDays: Object.freeze({ min: 1, max: 3650 }),
  rootLinks: "finite",
  degradeDerived: false,
});

/** `brain graph export` and `brain graph stats`. */
export const CLI_GRAPH_PROFILE: GraphProfile = Object.freeze({
  nodeScope: (alias: string) => `${alias}.asset_type = 'markdown'`,
  edgeOrder: " ORDER BY source, target",
  normalizePaths: false,
  isolatesByDefault: true,
  neighborhoodNodes: Infinity,
  sceneNodes: Infinity,
  sceneEdges: Infinity,
  findingLimit: Infinity,
  staleDays: null,
  rootLinks: "integer",
  degradeDerived: true,
});

/** The distinct edge list plus adjacency in both directions, in edge order. */
export interface LinkStructure {
  edges: GraphEdgeRecord[];
  out: Map<number, number[]>;
  in: Map<number, number[]>;
}

export interface Walk {
  /** Hops from the start, in the order nodes were reached. */
  distances: Map<number, number>;
  /** The walk stopped at its node budget. */
  truncated: boolean;
}

export interface Scene<N> {
  nodes: N[];
  edges: GraphEdgeRecord[];
  truncated: boolean;
}

export interface GraphRootKey {
  path: string;
  virtual: boolean;
}

/** Ranking inputs for a capped scene. */
interface RankedNode {
  id: number;
  pagerank?: number;
  virtual?: boolean;
}

/**
 * One request's read of the graph on a connection the caller owns: the
 * supported API's root-bound snapshot or the CLI's resolved database. The
 * reader never opens, closes or writes a connection.
 */
export class GraphReader {
  private structure: LinkStructure | undefined;

  constructor(
    private readonly db: Database,
    readonly profile: GraphProfile
  ) {}

  /** The node predicate over `documents d`. */
  get scope(): string {
    return this.profile.nodeScope("d");
  }

  /**
   * One edge per distinct (source, target) document pair — two wiki links that
   * resolve to the same note are one edge — with self-links dropped and both
   * ends graph nodes. Shared by the adjacency load and the edge counts so
   * every count agrees with the edges drawn.
   */
  get edgeSql(): string {
    return `SELECT DISTINCT l.source_id AS source, l.target_id AS target
  FROM links l
  JOIN documents d ON d.id = l.source_id AND ${this.profile.nodeScope("d")}
  JOIN documents t ON t.id = l.target_id AND ${this.profile.nodeScope("t")}
   WHERE l.target_id IS NOT NULL AND l.target_id <> l.source_id${this.profile.edgeOrder}`;
  }

  /** Loaded once per reader, straight from `links`: no derived table needed. */
  links(): LinkStructure {
    if (this.structure) return this.structure;
    const edges = this.db.query<GraphEdgeRecord, []>(this.edgeSql).all();
    const out = new Map<number, number[]>();
    const inbound = new Map<number, number[]>();
    for (const edge of edges) {
      push(out, edge.source, edge.target);
      push(inbound, edge.target, edge.source);
    }
    this.structure = { edges, out, in: inbound };
    return this.structure;
  }

  /** The node id at `path`, or null when no graph node has it. */
  lookup(path: string): number | null {
    const key = this.profile.normalizePaths ? path.replace(/^\.?\//, "") : path;
    const row = this.db
      .query<{ id: number }, [string]>(`SELECT d.id AS id FROM documents d WHERE ${this.scope} AND d.path = ?`)
      .get(key);
    return row?.id ?? null;
  }

  /** Breadth-first, level by level, stopping at `maxDepth` hops or `budget` nodes. */
  walk(start: number, direction: GraphDirection, maxDepth: number, budget: number): Walk {
    const structure = this.links();
    const distances = new Map<number, number>([[start, 0]]);
    let frontier = [start];
    let depth = 0;
    let truncated = false;
    while (frontier.length > 0 && depth < maxDepth && !truncated) {
      depth++;
      const next: number[] = [];
      for (const id of frontier) {
        const neighbors: number[] = [];
        if (direction !== "in") neighbors.push(...(structure.out.get(id) ?? []));
        if (direction !== "out") neighbors.push(...(structure.in.get(id) ?? []));
        for (const neighbor of neighbors) {
          if (distances.has(neighbor)) continue;
          if (distances.size >= budget) {
            truncated = true;
            break;
          }
          distances.set(neighbor, depth);
          next.push(neighbor);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    return { distances, truncated };
  }

  /** The ego walk: depth 1..3 (default 1), both directions by default. */
  neighborhood(center: number, depth?: number, direction?: GraphDirection): Walk {
    return this.walk(
      center,
      direction ?? "both",
      clamp(depth ?? 1, 1, MAX_NEIGHBORHOOD_DEPTH),
      this.profile.neighborhoodNodes
    );
  }

  /** Depth 1..8, default 8. */
  discoveryDepth(maxDepth?: number): number {
    return clamp(maxDepth ?? MAX_DISCOVERY_DEPTH, 1, MAX_DISCOVERY_DEPTH);
  }

  /** The discovery walk from an explicit root, outbound by default. */
  discovery(root: number, maxDepth: number, direction?: GraphDirection): Walk {
    return this.walk(root, direction ?? "out", maxDepth, this.profile.sceneNodes);
  }

  includeIsolates(requested?: boolean): boolean {
    return requested ?? this.profile.isolatesByDefault;
  }

  staleDays(requested?: number): number {
    const days = requested ?? DEFAULT_STALE_DAYS;
    const bounds = this.profile.staleDays;
    return bounds ? clamp(days, bounds.min, bounds.max) : days;
  }

  /**
   * Precomputed distances from the default root, in table order, optionally
   * limited to `maxDepth`. Direction does not apply: the precomputed walk is
   * the one that was run.
   */
  rootDistances(maxDepth?: number): Map<number, number> {
    const rows =
      maxDepth === undefined
        ? this.derived<{ id: number; distance: number }>(
            "SELECT document_id AS id, distance FROM graph_root_distances"
          )
        : this.derived<{ id: number; distance: number }>(
            "SELECT document_id AS id, distance FROM graph_root_distances WHERE distance <= ?",
            [maxDepth]
          );
    return new Map(rows.map((row) => [row.id, row.distance]));
  }

  /** The precomputed virtual root's seed ids from `graph_root_links`. */
  rootLinks(raw: string | null | undefined): number[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return this.profile.rootLinks === "integer"
        ? parsed.map(Number).filter(Number.isInteger)
        : parsed.filter((id): id is number => Number.isFinite(id));
    } catch {
      return [];
    }
  }

  /** Unresolved wiki links with their literal text, by source path then text. */
  brokenLinks(): { sourcePath: string; target: string }[] {
    const limit = this.profile.findingLimit;
    const sql = `SELECT d.path AS sourcePath, l.target AS target
     FROM links l JOIN documents d ON d.id = l.source_id
    WHERE l.target_id IS NULL
    ORDER BY d.path ASC, l.target ASC`;
    return Number.isFinite(limit)
      ? this.db.query<{ sourcePath: string; target: string }, [number]>(`${sql} LIMIT ?`).all(limit)
      : this.db.query<{ sourcePath: string; target: string }, []>(sql).all();
  }

  /**
   * Narrows `edges` to the ones between kept nodes, applying the profile's
   * caps. Over the node cap the highest-pagerank nodes survive (a virtual root
   * always does — dropping the thing the view is rooted on would be
   * nonsense); over the edge cap, the edges whose weaker end ranks highest.
   */
  scene<N extends RankedNode>(nodes: N[], edges: GraphEdgeRecord[], nodeCap: number, walkTruncated = false): Scene<N> {
    let truncated = false;
    let keptNodes = nodes;
    if (nodes.length > nodeCap) {
      truncated = true;
      keptNodes = [...nodes]
        .sort((a, b) => Number(b.virtual ?? false) - Number(a.virtual ?? false) || (b.pagerank ?? 0) - (a.pagerank ?? 0))
        .slice(0, nodeCap);
    }
    const ids = new Set(keptNodes.map((n) => n.id));
    let keptEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    if (keptEdges.length > this.profile.sceneEdges) {
      truncated = true;
      const rank = new Map(keptNodes.map((n) => [n.id, n.pagerank ?? 0]));
      keptEdges = keptEdges
        .map((edge) => ({ edge, weight: Math.min(rank.get(edge.source) ?? 0, rank.get(edge.target) ?? 0) }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, this.profile.sceneEdges)
        .map((entry) => entry.edge);
    }
    return { nodes: keptNodes, edges: keptEdges, truncated: truncated || walkTruncated };
  }

  /**
   * A read of a derived (v8) table. A read-only connection never migrates, so
   * on an older database the table is absent; a degrading profile reads that
   * as no rows.
   */
  derived<T>(sql: string, params: (string | number)[] = []): T[] {
    if (!this.profile.degradeDerived) return this.db.query<T, (string | number)[]>(sql).all(...params);
    try {
      return this.db.prepare<T, (string | number)[]>(sql).all(...params);
    } catch {
      return [];
    }
  }
}

/** `graph_root` metadata: an indexed path, or `virtual:<entry file>`. */
export function parseGraphRootKey(raw: string | null | undefined): GraphRootKey | null {
  if (!raw) return null;
  if (raw.startsWith(VIRTUAL_ROOT_PREFIX)) return { path: raw.slice(VIRTUAL_ROOT_PREFIX.length), virtual: true };
  return { path: raw, virtual: false };
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
