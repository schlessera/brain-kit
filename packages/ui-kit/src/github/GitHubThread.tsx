import type { ReactNode } from "react";
import { color, font } from "../tokens.js";
import { GitHubComment, type GitHubCommentProps } from "./GitHubComment.js";
import { GitHubMergeEvent, type GitHubMergeEventProps } from "./GitHubMergeEvent.js";
import { GitHubReview, type GitHubReviewProps } from "./GitHubReview.js";
import { CAPS } from "./shared.js";

/**
 * `GitHubThread` — the returned comments, reviews and the merge, newest last
 * (#3800, design #3795 §1–§2).
 *
 * Earlier items load on demand: the host puts a `GitHubDetailSection`
 * ("Load 9 earlier comments") in `before`, and renders what it loads as that
 * section's rows, above the items the tool returned.
 */
export type GitHubThreadItem =
  | ({ kind: "comment"; id: string } & GitHubCommentProps)
  | ({ kind: "review"; id: string } & GitHubReviewProps)
  | ({ kind: "merge"; id: string } & GitHubMergeEventProps);

export interface GitHubThreadProps {
  items: GitHubThreadItem[];
  /** The heading, e.g. "Comments · 17". Absent inside a PR's Conversation tab, whose tab names it. */
  label?: string;
  /** Above the items: the on-demand section for earlier ones. */
  before?: ReactNode;
  /** Shown when there are no items. Defaults to "No comments on GitHub yet." */
  emptyText?: string;
}

export function GitHubThread(p: GitHubThreadProps) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }} aria-label={p.label ?? "Conversation"} data-github-thread="">
      {p.label ? <h3 style={{ ...CAPS, margin: 0 }}>{p.label}</h3> : null}
      {p.before}
      {p.items.length === 0 ? (
        <p style={{ margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— {p.emptyText ?? "No comments on GitHub yet."}</p>
      ) : (
        p.items.map((item) => {
          if (item.kind === "comment") {
            const { kind: _kind, id, ...rest } = item;
            return <GitHubComment key={id} {...rest} />;
          }
          if (item.kind === "review") {
            const { kind: _kind, id, ...rest } = item;
            return <GitHubReview key={id} {...rest} />;
          }
          const { kind: _kind, id, ...rest } = item;
          return <GitHubMergeEvent key={id} {...rest} variant="event" />;
        })
      )}
    </section>
  );
}
