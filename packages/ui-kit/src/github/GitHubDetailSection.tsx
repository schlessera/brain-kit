import type { ReactNode } from "react";
import { DetailSection } from "../evidence/DetailSection.js";

/**
 * `GitHubDetailSection` — a part of a GitHub object loaded only when the
 * reader asks (#3800, design #3795 §7). ui-react owns the #3796 client and
 * passes the section's `state`; the kit draws it.
 *
 * A thin wrapper: the states, copy, focus and announcements are the shared
 * `DetailSection` with `source="GitHub"` (ruling G2 of #4209, which shares
 * them with the Gmail components). Its API and behaviour are unchanged.
 *
 * | state           | design | shows |
 * |-----------------|--------|-------|
 * | `idle`          | S0     | the load button; "Loads from GitHub when you ask. Brain won't see it." |
 * | `loading`       | S1     | ghost rows; static under reduced motion |
 * | `loaded`        | S2     | the rows, "Load more" while `moreLabel` is set, and "Loaded for you · Brain hasn't read these" |
 * | `empty`         | S3     | "GitHub returned no {noun} for this {object}." |
 * | `error`         | S4     | the failure and its status, and Try again |
 * | `rate-limited`  | S5     | when the limit resets, and Try again after that time (enabled) |
 * | `no-credential` | S6     | no GitHub access is set up |
 * | `gone`          | S7     | GitHub no longer shows the object to this brain |
 *
 * Display-only honesty: what loads here is for the reader. The section says
 * so, and the "Brain read" line on the object never changes.
 *
 * Focus: Load more moves focus to the first new row once it arrives. A
 * failure, empty or unavailable state is announced politely, once, through
 * one live region that changes only when the state does.
 */
export type GitHubDetailState = "idle" | "loading" | "loaded" | "empty" | "error" | "rate-limited" | "no-credential" | "gone";

export interface GitHubDetailSectionProps {
  state: GitHubDetailState;
  /** What loads, plural: "commits", "comments", "files", "checks". */
  noun: string;
  /** The object it belongs to: "pull request", "issue". */
  object: string;
  /** S0's button: "Show commits · 4 of 112 in result". */
  idleLabel: string;
  /** S2's Load more: "Load 30 more · 32 of 112 shown". Absent once everything has loaded. */
  moreLabel?: string;
  /** S4: what GitHub answered, e.g. 502. Absent when there was no answer. */
  errorStatus?: number | string;
  /** S5: the wall-clock time the limit resets ("14:32"), and how long until then ("12 min"). */
  resetAt?: string;
  resetIn?: string;
  /** The rows: `GitHubCommitRow`s, `GitHubComment`s, file or check rows. */
  children?: ReactNode;
  onLoad?: () => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}

export function GitHubDetailSection(p: GitHubDetailSectionProps) {
  return <DetailSection {...p} source="GitHub" attribute="data-github-detail" />;
}
