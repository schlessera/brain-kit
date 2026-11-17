import { UntrustedText } from "../evidence/UntrustedText.js";
import { GitHubIdentity } from "./GitHubIdentity.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { GitHubLink, type GitHubPerson } from "./shared.js";
import { DRAFT_SOURCE } from "./object-parts.js";

/**
 * `GitHubComment` — one comment: the identity row, then the body behind a
 * provenance rule, clamped at 6 lines with "Show whole comment" (#3800,
 * design #3795 §1).
 *
 * `htmlUrl` adds the comment's own direct `GitHub ↗` (D3). In `preview` the
 * comment is not posted yet (W4): the row says so and there is no link.
 */
export interface GitHubCommentProps {
  author: GitHubPerson;
  /** "2 d ago". The kit never computes a time. */
  time?: string;
  body: string;
  /** The comment's canonical URL (D3). Renders only when it passes the github.com check. */
  htmlUrl?: string | null;
  /** The payload cut the body before it reached Brain. */
  bodyTruncated?: boolean;
  preview?: boolean;
}

/** The comment body's hard bound, from the design's truncation table. */
export const COMMENT_MAX_CHARS = 10_000;

export function GitHubComment(p: GitHubCommentProps) {
  const login = p.author.login === null ? "@ghost" : `@${p.author.login}`;
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }} aria-label={`${p.preview ? "Comment not posted" : "Comment"} by ${login}`} data-github-comment="">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", minWidth: 0 }}>
        <GitHubIdentity {...p.author} meta={p.preview ? <GitHubStateChip state="not-posted" variant="inline" /> : p.time} />
        {p.preview ? null : <GitHubLink href={p.htmlUrl} name={`Comment by ${login}`} style={{ marginInlineStart: "auto" }} />}
      </div>
      <div style={{ paddingInlineStart: 28 }}>
        <UntrustedText
          text={p.body}
          {...(p.preview ? { ...DRAFT_SOURCE, author: null } : { source: "GitHub", author: login })}
          frame="rule"
          caption={false}
          lines={6}
          expandLabel="Show whole comment"
          maxChars={COMMENT_MAX_CHARS}
          truncated={p.bodyTruncated}
        />
      </div>
    </article>
  );
}
