/**
 * Core data types for brainform.
 *
 * Document types are config-driven strings validated at runtime against the
 * effective taxonomy (see taxonomy.ts) — not a compile-time union. Status and
 * relevance remain fixed vocabularies: they are part of the frontmatter
 * contract, not the user's taxonomy.
 */

export const VALID_STATUSES = ["active", "archived", "draft"] as const;
export const VALID_RELEVANCES = ["primary", "secondary", "historical"] as const;

export type DocumentType = string;
export type DocumentStatus = (typeof VALID_STATUSES)[number];
export type DocumentRelevance = (typeof VALID_RELEVANCES)[number];

export interface Document {
  id: number;
  path: string;
  title: string;
  type: DocumentType;
  status: DocumentStatus;
  relevance: DocumentRelevance;
  summary: string | null;
  created: string;
  updated: string;
  content: string;
  content_hash: string;
  file_mtime: string | null;
  deadline: string | null;
  next_review: string | null;
  indexed_at: string;
}

export interface Chunk {
  id: number;
  document_id: number;
  chunk_index: number;
  heading: string;
  content: string;
  token_estimate: number;
  context?: string | null;
}

export interface SearchResult {
  path: string;
  title: string;
  type: string;
  relevance: string;
  status: string;
  summary: string | null;
  tags: string;
  updated?: string;
  score: number;
  snippet: string;
  chunks?: ChunkMatch[];
}

export interface ChunkMatch {
  heading: string;
  content: string;
  score: number;
}

export interface SearchOptions {
  query?: string;
  mode?: "fts" | "vector" | "hybrid";
  rerank?: "none" | "heuristic";
  type?: string;
  tag?: string;
  relevance?: string;
  status?: string;
  includeArchived?: boolean;
  assetsOnly?: boolean;
  limit?: number;
}

export interface AuditIssue {
  path: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  suggestion?: string;
}

export interface IngestInput {
  content: string;
  type?: DocumentType;
  title?: string;
  tags?: string[];
  path?: string;
  smart?: boolean;
}

export const ASSET_EXTENSIONS = [".jpg", ".jpeg", ".png", ".pdf"] as const;

export interface Asset {
  path: string;
  mimeType: string;
  title: string;
  type: DocumentType;
  sizeBytes: number;
}
