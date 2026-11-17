import { UntrustedText } from "../evidence/UntrustedText.js";
import { GitHubHostAccount, GitHubIdentity, HOST_ACCOUNT } from "./GitHubIdentity.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { GitHubLink, type GitHubPerson } from "./shared.js";
import { DRAFT_CAPTION, DRAFT_SOURCE } from "./object-parts.js";

/**
 * `GitHubComment` — one comment: the identity row, then the body behind a
 * provenance rule, clamped at 6 lines with "Show whole comment" (#3800,
 * design #3795 §1).
 *
 * `htmlUrl` adds the comment's own direct `GitHub ↗` (D3). In `preview` the
 * comment is not posted yet (W4): the row says so and there is no link.
 *
 * A preview's `author` is the account the host verified it would post as;
 * absent, the row names "The host's GitHub account" and no login (#4154).
 * `login: null` keeps its meaning, a deleted account (`@ghost`), and is
 * for posted comments. A preview shows its whole draft: what is approved is
 * what is posted, so the posted comments' bound does not cut it. It also
 * carries the draft caption, "Brain's draft · not posted", as W1 does: the
 * poster says whose account would post it, the caption says who wrote it.
 */
interface GitHubCommentBase {
  /** "2 d ago". The kit never computes a time. */
  time?: string;
  body: string;
  /** The comment's canonical URL (D3). Renders only when it passes the github.com check. */
  htmlUrl?: string | null;
  /** The payload cut the body before it reached Brain. */
  bodyTruncated?: boolean;
}

export type GitHubCommentProps = GitHubCommentBase &
  (
    | { author: GitHubPerson; preview?: boolean }
    /** A preview whose poster the host could not verify. */
    | { author?: null; preview: true }
  );

/** The comment body's hard bound, from the design's truncation table. */
export const COMMENT_MAX_CHARS = 10_000;

export function GitHubComment(p: GitHubCommentProps) {
  const author = p.author ?? null;
  const login = author === null ? null : author.login === null ? "@ghost" : `@${author.login}`;
  const by = login ?? HOST_ACCOUNT.replace(/^The/, "the");
  const meta = p.preview ? <GitHubStateChip state="not-posted" variant="inline" /> : p.time;
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }} aria-label={`${p.preview ? "Comment not posted" : "Comment"} by ${by}`} data-github-comment="">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", minWidth: 0 }}>
        {author ? <GitHubIdentity {...author} meta={meta} /> : <GitHubHostAccount meta={meta} />}
        {p.preview ? null : <GitHubLink href={p.htmlUrl} name={`Comment by ${by}`} style={{ marginInlineStart: "auto" }} />}
      </div>
      <div style={{ paddingInlineStart: 28 }}>
        <UntrustedText
          text={p.body}
          {...(p.preview ? { ...DRAFT_SOURCE, author: null, caption: DRAFT_CAPTION } : { source: "GitHub", author: login, caption: false as const })}
          frame="rule"
          lines={6}
          expandLabel="Show whole comment"
          {...(p.preview ? {} : { maxChars: COMMENT_MAX_CHARS })}
          truncated={p.bodyTruncated}
        />
      </div>
    </article>
  );
}
