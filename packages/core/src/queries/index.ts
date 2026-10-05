/** Concrete supported content-index reads. No config, provider or agent initialization. */
import type { QueryResult, Root, GraphMeta, Subgraph, Maintenance, LinkWalk, ListedDocument, DocumentCandidate, Direction, VoiceVocabulary } from "./types.js";
import { QueryFailure, withSnapshot, integer, text, choice, relativePath } from "./snapshot.js";
import { graphMeta, graphClusters, graphNeighborhood, graphDiscovery, graphMaintenance } from "./graph.js";
import { vocabulary, EXTRACTOR_VERSION } from "./vocabulary.js";
import { linkWalk } from "./links.js";
export type * from "./types.js";
export type { ContentIndexQueries } from "./bound.js";

export function readGraphMeta(opts: Root): QueryResult<GraphMeta> {
  return withSnapshot(opts, "graph", () => {}, (db, meta, version) => graphMeta(db, meta, version));
}

export function readGraphClusters(opts: Root & {
  community?: number;
  includeIsolates?: boolean;
}): QueryResult<Subgraph> {
  return withSnapshot(opts, "graph", () => {
    integer(opts.community);
    if (opts.includeIsolates !== undefined && typeof opts.includeIsolates !== "boolean")
      throw new QueryFailure("invalid_input");
  }, (db, meta, version) => {
    derived(version);
    return graphClusters(db, meta, opts);
  });
}

export function readGraphNeighborhood(opts: Root & {
  center: string;
  depth?: number;
  direction?: Direction;
}): QueryResult<Subgraph> {
  let center = "";
  return withSnapshot(opts, "graph", () => {
    center = relativePath(opts.center);
    integer(opts.depth);
    choice(opts.direction, ["in", "out", "both"]);
  }, (db, _meta, version) => graphNeighborhood(db, version, { ...opts, center }));
}

export function readGraphDiscovery(opts: Root & {
  root?: string;
  direction?: "out" | "both";
  maxDepth?: number;
}): QueryResult<Subgraph> {
  let root: string | undefined;
  return withSnapshot(opts, "graph", () => {
    if (opts.root !== undefined)
      root = relativePath(opts.root);
    integer(opts.maxDepth);
    choice(opts.direction, ["out", "both"]);
  }, (db, meta, version) => {
    derived(version);
    return graphDiscovery(db, meta, { ...opts, root });
  });
}

export function readGraphMaintenance(opts: Root & {
  staleDays?: number;
  now?: string;
}): QueryResult<Maintenance> {
  return withSnapshot(opts, "graph", () => {
    integer(opts.staleDays);
    if (opts.now !== undefined && (typeof opts.now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(opts.now) || !Number.isFinite(Date.parse(opts.now)) || new Date(opts.now).toISOString().slice(0, 10) !== opts.now.slice(0, 10)))
      throw new QueryFailure("invalid_input");
  }, (db, meta, version) => {
    derived(version);
    return graphMaintenance(db, meta, opts);
  });
}

export function readLinkWalk(opts: Root & {
  path: string;
  depth?: number;
  direction?: "outgoing" | "incoming" | "both";
}): QueryResult<LinkWalk> {
  let path = "";
  return withSnapshot(opts, "links", () => {
    path = relativePath(opts.path);
    integer(opts.depth);
    choice(opts.direction, ["outgoing", "incoming", "both"]);
  }, db => {
    if (!db.query("SELECT path FROM documents WHERE path = ?").get(path))
      throw new QueryFailure("not_found");
    return linkWalk(db, { path, depth: Math.min(4, Math.max(1, opts.depth ?? 1)), direction: opts.direction ?? "both" });
  });
}

export function readVoiceVocabulary(opts: Root & {
  limit: number;
}): QueryResult<VoiceVocabulary> {
  return withSnapshot(opts, "voice", () => {
    integer(opts.limit);
    if (opts.limit === undefined || opts.limit < 1) throw new QueryFailure("invalid_input");
  }, db => ({ terms: vocabulary(db, opts.limit), extractorVersion: EXTRACTOR_VERSION }));
}

export function listIndexDocuments(opts: Root & {
  type?: string;
  tag?: string;
  status?: string;
  relevance?: string;
  limit?: number;
}): QueryResult<ListedDocument[]> {
  return withSnapshot(opts, "list", () => {
    integer(opts.limit);
    for (const v of [opts.type, opts.tag, opts.status, opts.relevance]) text(v);
  }, db => {
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status !== "archived") {
      filters.push("d.status != ?");
      params.push("archived");
    }
    for (const field of ["type", "status", "relevance"] as const) {
      if (opts[field] !== undefined) {
        filters.push(`d.${field} = ?`);
        params.push(opts[field]);
      }
    }
    if (opts.tag !== undefined) {
      filters.push("d.id IN (SELECT dt.document_id FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.name = ?)");
      params.push(opts.tag);
    }
    return db.query<ListedDocument, (string | number)[]>(`SELECT d.path, d.title, d.type, d.relevance, d.status,
    (SELECT GROUP_CONCAT(t.name, ', ') FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tags
    FROM documents d WHERE ${filters.join(" AND ") || "1=1"} ORDER BY d.updated DESC LIMIT ?`).all(...params, Math.min(100, Math.max(1, opts.limit ?? 20)));
  });
}

export function findIndexDocuments(opts: Root & {
  type?: string;
  excludeStatus?: string;
  pathSuffix?: string;
}): QueryResult<DocumentCandidate[]> {
  return withSnapshot(opts, "find", () => {
    text(opts.type);
    text(opts.excludeStatus);
    text(opts.pathSuffix);
    if (opts.pathSuffix !== undefined && (opts.pathSuffix.includes("\\") || opts.pathSuffix.split("/").includes("..")))
      throw new QueryFailure("invalid_input");
  }, db => {
    const filters: string[] = [];
    const params: string[] = [];
    if (opts.type !== undefined) {
      filters.push("type = ?");
      params.push(opts.type);
    }
    if (opts.excludeStatus !== undefined) {
      filters.push("status != ?");
      params.push(opts.excludeStatus);
    }
    if (opts.pathSuffix !== undefined) {
      filters.push("substr(path, -length(?)) = ?");
      params.push(opts.pathSuffix, opts.pathSuffix);
    }
    return db.query<DocumentCandidate, string[]>(`SELECT path, updated FROM documents WHERE ${filters.join(" AND ") || "1=1"} ORDER BY path`).all(...params);
  });
}
function derived(version: number): void {
  if (version < 8) throw new QueryFailure("incompatible_index");
}
