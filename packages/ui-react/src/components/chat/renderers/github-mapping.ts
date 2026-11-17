// Maps the host GitHub tools' payloads (#3797) onto the ui-kit GitHub
// components' props (#3800). Pure: no React, no fetch.
//
// The mapping is honest (#3795):
// - A `null` or absent field maps to the component's absent state, never to
//   zero or passing.
// - Every direct link is re-checked with #3797's `githubDirectUrl` against the
//   object it belongs to. A URL that fails, or a `null`, passes as absent, so
//   the slot shows no link. Nothing here builds, rewrites or repairs a URL.
// - An avatar is a brain-origin #3796 avatar-route URL, and only for a login
//   in this result.

import {
  githubDirectUrl,
  isGithubSearchUrl,
  parseGithubRepository,
  type GithubAuthor,
  type GithubChecks,
  type GithubComment,
  type GithubCommit,
  type GithubIssue,
  type GithubIssueSearchPayload,
  type GithubLinkScope,
  type GithubLinkTarget,
  type GithubPullRequest,
  type GithubReview,
  type GithubReviewComment,
  type GithubSearchItem,
  type GithubUser,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { GitHubPerson, GitHubResult, GitHubReviewState } from "@schlessera/brain-ui-kit";

/** Builds a brain-origin avatar URL for a login, or nothing when there is no session to scope it. */
export type AvatarFor = (login: string) => string | null;

const ASSOCIATION: Record<string, string> = {
  OWNER: "owner",
  MEMBER: "member",
  COLLABORATOR: "collaborator",
  CONTRIBUTOR: "contributor",
  FIRST_TIME_CONTRIBUTOR: "first-time contributor",
  FIRST_TIMER: "first-timer",
  MANNEQUIN: "mannequin",
  NONE: "none",
};

/** A person in the kit's terms. A deleted account (`login: null`) stays `@ghost` and fetches nothing. */
export function person(user: GithubUser | GithubAuthor, avatarFor: AvatarFor): GitHubPerson {
  const association = "author_association" in user && user.author_association ? (ASSOCIATION[user.author_association] ?? null) : null;
  return {
    login: user.login,
    association,
    bot: user.is_bot,
    avatarSrc: user.login === null ? null : avatarFor(user.login),
  };
}

/** The object a link must point into. `null` when the repository name does not parse, so no link renders. */
export function scopeOf(repository: string, number: number): GithubLinkScope | null {
  const parsed = parseGithubRepository(repository);
  return parsed ? { owner: parsed.owner, repo: parsed.repo, number } : null;
}

/** A direct link's URL after #3797's validator, or `null` (no link). */
export function directLink(url: string | null | undefined, scope: GithubLinkScope | null, target: GithubLinkTarget): string | null {
  if (!url || !scope) return null;
  return githubDirectUrl(url, scope, target);
}

/** The search footnote's link after #3797's search-URL check, or `null`. */
export function searchLink(payload: GithubIssueSearchPayload): string | null {
  const repo = parseGithubRepository(payload.repository);
  if (!payload.search_url || !repo) return null;
  return isGithubSearchUrl(payload.search_url, { owner: repo.owner, repo: repo.repo }, payload.search_query) ? payload.search_url : null;
}

/** "3 d ago", anchored to when the host fetched the result, never to the reader's clock. */
export function ago(at: string | null, fetchedAt: string): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(fetchedAt) - Date.parse(at);
  if (!Number.isFinite(ms)) return undefined;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

/** The PR's state in the kit's words. Merged and draft take precedence over open and closed. */
export function pullState(pr: GithubPullRequest): "open" | "draft" | "merged" | "closed" {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

/** The issue's state in the kit's words. Closed as not planned or duplicate reads not planned. */
export function issueState(issue: GithubIssue): "open" | "completed" | "not-planned" {
  if (issue.state === "open") return "open";
  return issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "not-planned" : "completed";
}

const REVIEW_STATE: Record<GithubReview["state"], GitHubReviewState> = {
  approved: "approved",
  changes_requested: "changes-requested",
  commented: "commented",
  dismissed: "dismissed",
  // An unsubmitted draft review is not a request for review: it reads as not reported.
  pending: null,
};

function reviewState(state: GithubReview["state"] | null | undefined): GitHubReviewState {
  return state ? REVIEW_STATE[state] : null;
}

/**
 * The reviews fact: changes requested and approved, from each reviewer's latest
 * decision. With no decisions and no reviews reported at all, `null` (absent).
 */
export function reviewCounts(pr: GithubPullRequest): { changesRequested: number; approved: number } | null {
  if (pr.review_decisions.length === 0 && pr.reviews.total_count === null) return null;
  return {
    changesRequested: pr.review_decisions.filter((d) => d.state === "changes_requested").length,
    approved: pr.review_decisions.filter((d) => d.state === "approved").length,
  };
}

/** One row per reviewer: the latest decision, then requested reviewers with no review yet. */
export function reviewerRows(pr: GithubPullRequest, avatarFor: AvatarFor) {
  const decided = new Set(pr.review_decisions.map((d) => d.reviewer.login));
  return [
    ...pr.review_decisions.map((d) => ({ person: person(d.reviewer, avatarFor), state: reviewState(d.state), time: ago(d.submitted_at, pr.fetched_at) })),
    ...pr.requested_reviewers.filter((r) => !decided.has(r.login)).map((r) => ({ person: person(r, avatarFor), state: "review-requested" as GitHubReviewState })),
  ];
}

/** Checks as the payload states them: `null` stays `null` ("None reported"). */
export function checks(value: GithubChecks): { passed: number; failed: number; running: number; skipped: number } | null {
  return value === null ? null : { ...value };
}

/** A known total, or `null` when the payload does not state one. */
export function knownTotal(list: { items: unknown[]; total_count: number | null; has_more: boolean }): number | null {
  if (list.total_count !== null) return list.total_count;
  return list.has_more ? null : list.items.length;
}

/** "Brain read: …": what the tool result itself carried. It never grows when the reader loads detail. */
export function brainRead(object: GithubIssue | GithubPullRequest): string {
  const parts: string[] = [object.body ? "description" : "no description"];
  if (object.kind === "pull_request") {
    if (object.reviews.items.length) parts.push(`${object.reviews.items.length} ${object.reviews.items.length === 1 ? "review" : "reviews"}`);
  }
  const shown = object.comments.items.length;
  const total = knownTotal(object.comments);
  if (shown) parts.push(total !== null && total > shown ? `latest ${shown} of ${total} comments` : `${shown} ${shown === 1 ? "comment" : "comments"}`);
  if (object.kind === "pull_request") {
    if (object.commits.items.length) parts.push(`${object.commits.items.length} ${object.commits.items.length === 1 ? "commit" : "commits"}`);
    if (object.checks !== null) parts.push("checks summary");
  }
  return `${parts.join(", ")}.`;
}

/** A comment's props, with its own direct link re-checked against the object it belongs to. */
export function commentProps(comment: GithubComment | GithubReviewComment, scope: GithubLinkScope | null, fetchedAt: string, avatarFor: AvatarFor) {
  const isReviewComment = "review_id" in comment;
  return {
    author: person(comment.author, avatarFor),
    time: ago(comment.created_at, fetchedAt),
    body: comment.body ?? "",
    bodyTruncated: comment.body_truncated,
    htmlUrl: directLink(comment.html_url, scope, { kind: isReviewComment ? "review_comment" : "comment", id: comment.id }),
  };
}

export function reviewProps(review: GithubReview, scope: GithubLinkScope | null, fetchedAt: string, avatarFor: AvatarFor) {
  return {
    reviewer: person(review.author, avatarFor),
    state: reviewState(review.state),
    time: ago(review.submitted_at, fetchedAt),
    body: review.body,
    htmlUrl: directLink(review.html_url, scope, { kind: "review", id: review.id }),
  };
}

export function commitProps(commit: GithubCommit, scope: GithubLinkScope | null, fetchedAt: string, avatarFor: AvatarFor) {
  const subject = commit.message.split("\n")[0] ?? "";
  return {
    sha: commit.sha.slice(0, 7),
    subject,
    message: commit.message_truncated ? `${commit.message}\n…` : commit.message,
    author: commit.author ? person(commit.author, avatarFor) : null,
    time: ago(commit.authored_at, fetchedAt),
    htmlUrl: directLink(commit.html_url, scope, { kind: "commit", sha: commit.sha }),
  };
}

/** One search row. Its link is re-checked against the row's own number. */
export function resultRow(item: GithubSearchItem, repository: string): GitHubResult {
  const state: GitHubResult["state"] =
    item.kind === "pull_request"
      ? item.merged_at
        ? "merged"
        : item.state === "closed"
          ? "closed"
          : item.draft
            ? "draft"
            : "open"
      : item.state === "open"
        ? "open"
        : item.state_reason === "not_planned" || item.state_reason === "duplicate"
          ? "not-planned"
          : "completed";
  const facts = [
    ...item.labels.items.slice(0, 3).map((label) => label.name),
    `${item.comments} ${item.comments === 1 ? "comment" : "comments"}`,
  ];
  return {
    kind: item.kind === "pull_request" ? "pr" : "issue",
    number: item.number,
    state,
    title: item.title,
    facts,
    summary: item.excerpt,
    htmlUrl: directLink(item.html_url, scopeOf(repository, item.number), { kind: item.kind }),
  };
}
