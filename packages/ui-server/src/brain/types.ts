export interface BrainSearchResult {
  path: string;
  title: string;
  type: string;
  relevance: string;
  score: number;
  snippet: string;
}

export interface BrainSearchResponse {
  results: BrainSearchResult[];
  /** Degraded-mode notices from the CLI, e.g. vector search unavailable so results are FTS-only. */
  warnings: string[];
}

export interface BrainDocument {
  path: string;
  title: string;
  type: string;
  status: string;
  relevance: string;
  tags: string[];
  created: string;
  updated: string;
  summary?: string;
}

export interface BrainStats {
  documents: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byRelevance: Record<string, number>;
  tags: number;
  links: number;
  brokenLinks: number;
  chunks: number;
}

export interface BrainSyncResult {
  success: boolean;
  commits: number;
  conflicts: number;
  message: string;
}
