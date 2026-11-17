import type { ReactNode } from "react";
import { UntrustedText } from "../evidence/UntrustedText.js";
import { color } from "../tokens.js";
import { GitHubIdentity } from "./GitHubIdentity.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { GitHubLink, type GitHubPerson } from "./shared.js";
import { COMMENT_MAX_CHARS } from "./GitHubComment.js";

/** A review's state. `null` is a state the payload does not report, read as absent. */
export type GitHubReviewState = "approved" | "changes-requested" | "commented" | "dismissed" | "review-requested" | null;

/**
 * `GitHubReview` — a review is its own event in the thread, not a comment
 * (#3800, design #3795 §1). The state sits beside the reviewer; the body
 * shows only when there is one, so an approval alone is a single line.
 *
 * Line comments load on demand: "Show n line comments" calls
 * `onShowLineComments`, and the host renders what it loads as `children`
 * (a `GitHubDetailSection` of `GitHubComment`s, each with its own link).
 */
export interface GitHubReviewProps {
  reviewer: GitHubPerson;
  state: GitHubReviewState;
  time?: string;
  body?: string | null;
  /** The review's canonical URL (D3). */
  htmlUrl?: string | null;
  lineComments?: number;
  onShowLineComments?: () => void;
  children?: ReactNode;
}

export function GitHubReview(p: GitHubReviewProps) {
  const login = p.reviewer.login === null ? "@ghost" : `@${p.reviewer.login}`;
  const state = p.state ?? "not-reported";
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }} aria-label={`Review by ${login}`} data-github-review="">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", minWidth: 0 }}>
        <GitHubIdentity
          {...p.reviewer}
          meta={
            <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "0 8px" }}>
              <GitHubStateChip state={state} variant="inline" />
              {p.time ? <span>{p.time}</span> : null}
            </span>
          }
        />
        <GitHubLink href={p.htmlUrl} name={`Review by ${login}`} style={{ marginInlineStart: "auto" }} />
      </div>
      {p.body ? (
        <div style={{ paddingInlineStart: 28 }}>
          <UntrustedText text={p.body} source="GitHub" author={login} frame="rule" caption={false} lines={6} expandLabel="Show whole review" maxChars={COMMENT_MAX_CHARS} />
        </div>
      ) : null}
      {p.lineComments && p.onShowLineComments && !p.children ? (
        <div style={{ paddingInlineStart: 28 }}>
          <button type="button" className="bk-text-btn" data-tone="inherit" onClick={p.onShowLineComments} style={{ color: color.inkDim, fontSize: 12 }}>
            Show {p.lineComments} line {p.lineComments === 1 ? "comment" : "comments"}
          </button>
        </div>
      ) : null}
      {p.children ? <div style={{ paddingInlineStart: 28 }}>{p.children}</div> : null}
    </article>
  );
}
