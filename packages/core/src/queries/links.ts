import type { Database } from "bun:sqlite";
import type { LinkWalk } from "./types.js";
/**
 * The wiki-link walk behind the `brain_graph` MCP tool: the edges reached from
 * a starting document, and the documents those edges touch.
 */
/** Private traversal on the caller's already pinned read transaction. */
export function linkWalk(db: Database, opts: {
  path: string;
  depth: number;
  direction: "outgoing" | "incoming" | "both";
}): LinkWalk {
  const edges: LinkWalk["edges"] = [];
  const visited = new Set<string>();
  let frontier = new Set<string>([opts.path]);
  for (let hop = 0; hop < opts.depth; hop++) {
    const nextFrontier = new Set<string>();
    for (const currentPath of frontier) {
      if (visited.has(currentPath))
        continue;
      visited.add(currentPath);
      if (opts.direction === "outgoing" || opts.direction === "both") {
        // A target_id whose document is gone reads as unresolved, with
        // the raw link text as its target.
        const outgoing = db
          .query(`SELECT d.path AS source, COALESCE(t.path, l.target) AS target,
          t.id IS NOT NULL AS resolved
       FROM links l
       JOIN documents d ON d.id = l.source_id
       LEFT JOIN documents t ON t.id = l.target_id
       WHERE d.path = ?`)
          .all(currentPath) as Array<{
          source: string;
          target: string;
          resolved: number;
        }>;
        for (const row of outgoing) {
          const resolved = row.resolved === 1;
          edges.push({ source: row.source, target: row.target, resolved });
          if (resolved)
            nextFrontier.add(row.target);
        }
      }
      if (opts.direction === "incoming" || opts.direction === "both") {
        const incoming = db
          .query(`SELECT d2.path AS source, d.path AS target
       FROM links l
       JOIN documents d ON d.id = l.target_id
       JOIN documents d2 ON d2.id = l.source_id
       WHERE d.path = ?`)
          .all(currentPath) as Array<{
          source: string;
          target: string;
        }>;
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
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
  // Every source is a document; a target is one only when resolved.
  const touched = new Set<string>();
  for (const e of uniqueEdges) {
    touched.add(e.source);
    if (e.resolved)
      touched.add(e.target);
  }
  const nodes = db
    .query(`SELECT path, title, type, summary, updated FROM documents
     WHERE path IN (SELECT value FROM json_each(?))
     ORDER BY path`)
    .all(JSON.stringify([...touched])) as LinkWalk["nodes"];
  return { edges: uniqueEdges, nodes };
}
