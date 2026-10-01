/** Supported detached content-index results. See docs/content-index-queries.md. */
export type Direction = "in" | "out" | "both";
export type QueryCode = "missing_index" | "incompatible_index" | "corrupt_index" | "busy_index" | "unavailable_index" | "not_computed" | "not_found" | "invalid_input";
export interface Snapshot {
  schemaVersion: number; // observed diagnostic, never a caller's SQL floor
  newestIndexedAt: string | null;
}
export type QueryResult<T> = {
  ok: true;
  value: T;
  snapshot: Snapshot;
} | {
  ok: false;
  error: {
    code: QueryCode;
    retryable: boolean;
  };
};
export interface Root {
  brainPath: string;
}
export interface Node {
  id: number;
  path: string;
  title: string;
  type: string;
  inDegree: number;
  outDegree: number;
  community?: number;
  pagerank?: number;
  x?: number;
  y?: number;
  distance?: number;
  virtual?: boolean;
}
export interface Edge {
  source: number;
  target: number;
}
export interface Community {
  community: number;
  size: number;
  label: string | null;
  topTerms: string[];
}
export interface GraphMeta {
  available: boolean;
  reason?: "schema" | "not_computed";
  schemaVersion: number;
  computedAt: string | null;
  stale: boolean;
  nodeCount: number;
  edgeCount: number;
  communities: Community[];
  defaultRoot: {
    path: string;
    virtual: boolean;
  } | null;
  layoutSkipped?: boolean;
}
export interface Subgraph {
  nodes: Node[];
  edges: Edge[];
  truncated: boolean;
  reachableCount?: number;
  unreachableCount?: number;
}
export interface Maintenance {
  orphans: Node[];
  unreachable: Node[];
  brokenLinks: {
    sourcePath: string;
    target: string;
  }[];
  stale: (Node & {
    updated: string;
  })[];
  staleDays: number;
}
export interface LinkWalk {
  edges: {
    source: string;
    target: string;
    resolved: boolean;
  }[];
  nodes: {
    path: string;
    title: string;
    type: string;
    summary: string | null;
    updated: string | null;
  }[];
}
export interface ListedDocument {
  path: string;
  title: string;
  type: string;
  relevance: string | null;
  status: string | null;
  tags: string | null;
}
export interface DocumentCandidate {
  path: string;
  updated: string | null;
}
export interface VoiceVocabulary {
  terms: string[];
  extractorVersion: number;
}
