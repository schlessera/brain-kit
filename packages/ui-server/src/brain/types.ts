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

/**
 * `brain stats --history --json` (additive in 0.40.0): the recorded daily
 * snapshots, oldest first, one array per field; `null` where a snapshot has
 * no figure. Passed through untouched — only the fields a consumer here
 * names are typed.
 */
export interface BrainStatsHistory {
  dates: string[];
  documents: (number | null)[];
  health: Record<string, (number | null)[]>;
  [field: string]: unknown;
}

/** What a `brain sync` that exited 0 printed; a failed sync throws instead. */
export interface BrainSyncResult {
  message: string;
}

/** Outcome of saving content, including a recoverable indexing failure. */
export interface BrainAddResult {
  action: "created" | "appended";
  path: string;
  title: string;
  type: string;
  indexed: boolean;
  indexError?: string;
}
