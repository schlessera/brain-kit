import type { Database } from "bun:sqlite";

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
 * endpoint has no node.
 *
 * `afterEdges` is a test seam: it runs between the traversal and the node
 * lookup, where a concurrent writer would do harm.
 */
export function walkLinks(
  db: Database,
  opts: LinkWalkOptions,
  afterEdges?: () => void
): { edges: LinkEdge[]; nodes: LinkNode[] } {
  return db.transaction(() => {
    const edges: LinkEdge[] = [];
    const visited = new Set<string>();
    let frontier = new Set<string>([opts.path]);

    for (let hop = 0; hop < opts.depth; hop++) {
      const nextFrontier = new Set<string>();

      for (const currentPath of frontier) {
        if (visited.has(currentPath)) continue;
        visited.add(currentPath);

        if (opts.direction === "outgoing" || opts.direction === "both") {
          // A target_id whose document is gone reads as unresolved, with
          // the raw link text as its target.
          const outgoing = db
            .prepare(
              `SELECT d.path AS source, COALESCE(t.path, l.target) AS target,
                      t.id IS NOT NULL AS resolved
               FROM links l
               JOIN documents d ON d.id = l.source_id
               LEFT JOIN documents t ON t.id = l.target_id
               WHERE d.path = ?`
            )
            .all(currentPath) as Array<{ source: string; target: string; resolved: number }>;

          for (const row of outgoing) {
            const resolved = row.resolved === 1;
            edges.push({ source: row.source, target: row.target, resolved });
            if (resolved) nextFrontier.add(row.target);
          }
        }

        if (opts.direction === "incoming" || opts.direction === "both") {
          const incoming = db
            .prepare(
              `SELECT d2.path AS source, d.path AS target
               FROM links l
               JOIN documents d ON d.id = l.target_id
               JOIN documents d2 ON d2.id = l.source_id
               WHERE d.path = ?`
            )
            .all(currentPath) as Array<{ source: string; target: string }>;

          for (const row of incoming) {
            edges.push({ source: row.source, target: row.target, resolved: true });
            nextFrontier.add(row.source);
          }
        }
      }

      frontier = nextFrontier;
    }

    const seen = new Set<string>();
    const uniqueEdges = edges.filter((e) => {
      const key = `${e.source}->${e.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    afterEdges?.();

    // Every source is a document; a target is one only when resolved.
    const touched = new Set<string>();
    for (const e of uniqueEdges) {
      touched.add(e.source);
      if (e.resolved) touched.add(e.target);
    }
    const nodes = db
      .prepare(
        `SELECT path, title, type, summary, updated FROM documents
         WHERE path IN (SELECT value FROM json_each(?))
         ORDER BY path`
      )
      .all(JSON.stringify([...touched])) as LinkNode[];

    return { edges: uniqueEdges, nodes };
  })();
}
