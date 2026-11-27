import type { Database } from "bun:sqlite";

import { linkWalk } from "../queries/links.js";

/**
 * The wiki-link walk behind the `brain_graph` MCP tool: the edges reached from
 * a starting document, and the documents those edges touch.
 */

export interface LinkEdge {
  source: string;
  target: string;
  resolved: boolean;
}

export interface LinkNode {
  path: string;
  title: string;
  type: string;
  summary: string | null;
  updated: string | null;
}

export interface LinkWalkOptions {
  path: string;
  /** Hops to follow, already clamped by the caller. */
  depth: number;
  direction: "outgoing" | "incoming" | "both";
}

/**
 * Walk the link graph and look up every touched document, inside one read
 * transaction. The index can be rewritten by another process at any time
 * (`brain index`, a git hook); with WAL, the transaction pins one snapshot,
 * so a document deleted halfway through cannot leave a resolved edge whose
 * endpoint has no node. The walk itself is `linkWalk`, which the query API
 * runs on its own snapshot.
 *
 * `afterEdges` is a test seam: it runs between the traversal and the node
 * lookup, where a concurrent writer would do harm.
 */
export function walkLinks(
  db: Database,
  opts: LinkWalkOptions,
  afterEdges?: () => void
): { edges: LinkEdge[]; nodes: LinkNode[] } {
  return db.transaction(() => linkWalk(db, opts, afterEdges))();
}
