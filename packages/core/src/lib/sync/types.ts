/**
 * The shapes the sync pieces hand each other: the merge strategies a file can
 * be resolved with, and the two judgments a sync may ask for — whether an
 * unclassified file is an artifact, and how two edits of one passage relate.
 */

/** How a conflicted file is merged. Chosen per file by `strategyFor`. */
export const MERGE_STRATEGIES = [
  "table-union",
  "timeline-append",
  "synthesize",
  "keep-both",
  "latest-wins-additive",
  "code-merge",
  "cache-union",
] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

/**
 * Two versions of one passage that both sides changed, which a strategy can
 * only combine once it knows how they relate. The merged file is always built
 * from these verbatim; a judgment only chooses which of them it keeps.
 */
export interface JudgmentPair {
  /** Stable across runs for the same inputs, so a decision can be looked up. */
  id: string;
  /** The file the pair belongs to. */
  path: string;
  /** Where the passage sits: the heading path, e.g. "Raft > Next action". */
  context: string;
  ours: string;
  theirs: string;
}

/**
 * How two versions of one passage relate:
 * - `same-fact`: both say the same thing; keep one.
 * - `ours-supersedes` / `theirs-supersedes`: one replaces the other; keep it alone.
 * - `distinct`: both carry information; keep both.
 */
export const PAIR_DECISIONS = ["same-fact", "ours-supersedes", "theirs-supersedes", "distinct"] as const;
export type PairDecision = (typeof PAIR_DECISIONS)[number];

/** A changed file `assess` could not classify from its name, size or extension. */
export interface UnknownFile {
  id: string;
  path: string;
  /** The start of the file as text, bounded by the caller. */
  head: string;
  bytes: number;
}

export const FILE_DECISIONS = ["artifact", "track"] as const;
export type FileDecision = (typeof FILE_DECISIONS)[number];

/** A judgment that cleared its confidence line. Anything below it is absent, never guessed. */
export interface Judged<T extends string> {
  decision: T;
  confidence: number;
}
