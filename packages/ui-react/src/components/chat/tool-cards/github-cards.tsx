// The host GitHub tools' results as the ui-kit GitHub components (#3795).
//
// The components are #3800's, used unchanged. This file maps payloads onto
// them (through `../renderers/github-mapping.ts`) and owns the one fetch they
// trigger: on-demand detail pages through #3796's client, only after the
// reader acts. What loads is display-only and never reaches the model.

import { Fragment, useCallback, useRef, useState, type ReactNode } from "react";
import {
  Callout,
  GitHubComment,
  GitHubCommitRow,
  GitHubDetailSection,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRef,
  GitHubResultList,
  GitHubStateChip,
  GitHubThread,
  GitHubWriteNotice,
  ListRow,
  UntrustedText,
  type GitHubDetailState,
  type GitHubThreadItem,
} from "@schlessera/brain-ui-kit";
import type {
  GithubChangedFile,
  GithubCheckRun,
  GithubComment as GithubCommentPayload,
  GithubCommit,
  GithubDetailError,
  GithubDetailPart,
  GithubError,
  GithubIssue,
  GithubIssueCommentInput,
  GithubIssueCreateInput,
  GithubIssueSearchPayload,
  GithubPullRequest,
  GithubReview,
  GithubReviewComment,
  GithubToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainUiRoot, useRootStore } from "../../../root-context.js";
import { fetchGithubDetailPage, githubAvatarUrl } from "../../../lib/github-details.js";
import {
  ago,
  brainRead,
  checks,
  commentProps,
  commitProps,
  directLink,
  issueState,
  knownTotal,
  person,
  pullState,
  resultRow,
  reviewCounts,
  reviewerRows,
  reviewProps,
  scopeOf,
  searchLink,
  type AvatarFor,
} from "../renderers/github-mapping.js";

/** Brain-origin avatar URLs for this session, or none (initials) without a session. */
function useAvatarFor(): AvatarFor {
  const root = useBrainUiRoot();
  const sessionId = useRootStore("chat", (s) => s.activeSessionId);
  return useCallback((login: string) => (sessionId ? githubAvatarUrl(root.apiBase(), sessionId, login) : null), [root, sessionId]);
}

// ---------------------------------------------------------------------------
// On-demand detail (#3796)
// ---------------------------------------------------------------------------

type DetailItem = GithubCommentPayload | GithubReview | GithubReviewComment | GithubCommit | GithubChangedFile | GithubCheckRun;

interface Detail {
  state: GitHubDetailState;
  items: DetailItem[];
  next: string | null;
  total: number | null;
  errorStatus?: number | string;
  resetAt?: string;
  resetIn?: string;
}

/** The S4–S7 state a detail route error reads as. */
function detailErrorState(error: GithubDetailError | GithubError & { reset_at?: string | null }, now = Date.now()): Omit<Detail, "items" | "next" | "total"> {
  if (error.code === "rate_limited") {
    const reset = error.reset_at ? new Date(error.reset_at) : null;
    if (!reset || Number.isNaN(reset.getTime())) return { state: "rate-limited" };
    const minutes = Math.max(1, Math.ceil((reset.getTime() - now) / 60_000));
    return {
      state: "rate-limited",
      resetAt: reset.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      resetIn: `${minutes} min`,
    };
  }
  if (error.code === "unavailable" && error.reason === "no_credential") return { state: "no-credential" };
  if (error.code === "not_found" || error.code === "forbidden") return { state: "gone" };
  const status = error.reason?.match(/^http_(\d{3})$/)?.[1];
  return { state: "error", ...(status ? { errorStatus: Number(status) } : {}) };
}

/**
 * One on-demand part of one object. Nothing is fetched until `load`; `more`
 * appends the next page; `retry` repeats the last request. The pages are
 * display-only state of this card: nothing here reaches the chat store, the
 * socket or the model.
 */
function useDetail(repository: string, number: number, part: GithubDetailPart) {
  const root = useBrainUiRoot();
  const sessionId = useRootStore("chat", (s) => s.activeSessionId);
  const [detail, setDetail] = useState<Detail>({ state: "idle", items: [], next: null, total: null });
  const last = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      last.current = cursor;
      if (!sessionId) {
        setDetail((d) => ({ ...d, state: "error" }));
        return;
      }
      setDetail((d) => ({ ...d, state: "loading" }));
      const answer = await fetchGithubDetailPage(root, { sessionId, repository, number, part, cursor });
      if (!answer.ok) {
        setDetail((d) => ({ ...d, ...detailErrorState(answer.error) }));
        return;
      }
      const page = answer.page;
      setDetail((d) => {
        const items = append ? [...d.items, ...(page.items as DetailItem[])] : (page.items as DetailItem[]);
        return { state: items.length === 0 ? "empty" : "loaded", items, next: page.next_cursor, total: page.total_count };
      });
    },
    [root, sessionId, repository, number, part],
  );

  return {
    detail,
    load: () => void fetchPage(null, false),
    more: () => void fetchPage(detail.next, true),
    retry: () => void fetchPage(last.current, last.current !== null),
  };
}

const NOUN: Record<GithubDetailPart, string> = {
  comments: "comments",
  reviews: "reviews",
  "review-comments": "line comments",
  commits: "commits",
  files: "files",
  checks: "checks",
};

function moreLabel(detail: Detail): string | undefined {
  if (!detail.next) return undefined;
  const of = detail.total !== null ? ` of ${detail.total}` : "";
  return `Load more · ${detail.items.length}${of} shown`;
}

/** A detail section wired to #3796, rendering its rows with `row`. */
function DetailPart(p: {
  repository: string;
  number: number;
  part: GithubDetailPart;
  object: "issue" | "pull request";
  idleLabel: string;
  row: (item: DetailItem, index: number) => ReactNode;
}) {
  const { detail, load, more, retry } = useDetail(p.repository, p.number, p.part);
  return (
    <GitHubDetailSection
      state={detail.state}
      noun={NOUN[p.part]}
      object={p.object}
      idleLabel={p.idleLabel}
      moreLabel={moreLabel(detail)}
      errorStatus={detail.errorStatus}
      resetAt={detail.resetAt}
      resetIn={detail.resetIn}
      onLoad={load}
      onLoadMore={more}
      onRetry={retry}
    >
      {detail.items.length ? detail.items.map((item, i) => p.row(item, i)) : undefined}
    </GitHubDetailSection>
  );
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** A tool refusal in the result's own words. */
function GithubRefusal({ error }: { error: GithubError }) {
  return <Callout tone={error.code === "rate_limited" ? "gold" : "red"} variant="boxed" icon="failed" text={error.message} />;
}

/** True for an upstream failure after which a write may still have happened. */
function outcomeUnknown(error: GithubError): boolean {
  return error.code === "upstream_error" && error.reason !== "malformed" && error.reason !== "redirect";
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function threadItems(comments: GithubCommentPayload[], reviews: GithubReview[], scope: ReturnType<typeof scopeOf>, fetchedAt: string, avatarFor: AvatarFor): GitHubThreadItem[] {
  const timed: { at: string; item: GitHubThreadItem }[] = [
    ...comments.map((c) => ({ at: c.created_at, item: { kind: "comment" as const, id: `c${c.id}`, ...commentProps(c, scope, fetchedAt, avatarFor) } })),
    ...reviews.map((r) => ({ at: r.submitted_at ?? "", item: { kind: "review" as const, id: `r${r.id}`, ...reviewProps(r, scope, fetchedAt, avatarFor) } })),
  ];
  return timed.sort((a, b) => a.at.localeCompare(b.at)).map((t) => t.item);
}

function commentRow(scope: ReturnType<typeof scopeOf>, fetchedAt: string, avatarFor: AvatarFor) {
  return (item: DetailItem, i: number) => <GitHubComment key={i} {...commentProps(item as GithubCommentPayload, scope, fetchedAt, avatarFor)} />;
}

function IssueCard({ issue }: { issue: GithubIssue }) {
  const avatarFor = useAvatarFor();
  const scope = scopeOf(issue.repository, issue.number);
  const total = knownTotal(issue.comments);
  const earlier = total !== null ? total - issue.comments.items.length : null;
  return (
    <GitHubIssue
      state={issueState(issue)}
      repo={issue.repository}
      number={issue.number}
      htmlUrl={directLink(issue.html_url, scope, { kind: "issue" })}
      title={issue.title}
      author={person(issue.author, avatarFor)}
      opened={issue.created_at ? `opened ${ago(issue.created_at, issue.fetched_at)}` : undefined}
      locked={issue.locked}
      labels={issue.labels.items.map((l) => l.name)}
      body={issue.body}
      bodyLength={issue.body_length}
      bodyTruncated={issue.body_truncated}
      brainRead={brainRead(issue)}
    >
      <GitHubThread
        label={`Comments · ${total ?? `${issue.comments.items.length}+`}`}
        items={threadItems(issue.comments.items, [], scope, issue.fetched_at, avatarFor)}
        before={
          issue.comments.has_more || (earlier !== null && earlier > 0) ? (
            <DetailPart
              repository={issue.repository}
              number={issue.number}
              part="comments"
              object="issue"
              idleLabel={earlier !== null && earlier > 0 ? `Load ${earlier} earlier comments` : "Load earlier comments"}
              row={commentRow(scope, issue.fetched_at, avatarFor)}
            />
          ) : undefined
        }
      />
    </GitHubIssue>
  );
}

const PR_TABS = ["Conversation", "Commits", "Files", "Checks"] as const;

function PullRequestCard({ pr }: { pr: GithubPullRequest }) {
  const avatarFor = useAvatarFor();
  const [tab, setTab] = useState(0);
  const scope = scopeOf(pr.repository, pr.number);
  const commentTotal = knownTotal(pr.comments);
  const commitTotal = knownTotal(pr.commits);
  const checkTotal = pr.checks ? pr.checks.passed + pr.checks.failed + pr.checks.running + pr.checks.skipped : undefined;
  const earlier = commentTotal !== null ? commentTotal - pr.comments.items.length : null;
  const state = pullState(pr);

  const conversation = (
    <GitHubThread
      items={[
        ...threadItems(pr.comments.items, pr.reviews.items, scope, pr.fetched_at, avatarFor),
        ...(state === "merged"
          ? [{ kind: "merge" as const, id: "merge", by: pr.merged_by ? person(pr.merged_by, avatarFor) : null, into: pr.base_ref, sha: pr.merge_commit_sha?.slice(0, 7) ?? null, time: ago(pr.merged_at, pr.fetched_at) }]
          : []),
      ]}
      before={
        pr.comments.has_more || (earlier !== null && earlier > 0) ? (
          <DetailPart
            repository={pr.repository}
            number={pr.number}
            part="comments"
            object="pull request"
            idleLabel={earlier !== null && earlier > 0 ? `Load ${earlier} earlier comments` : "Load earlier comments"}
            row={commentRow(scope, pr.fetched_at, avatarFor)}
          />
        ) : undefined
      }
    />
  );

  const commits = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {pr.commits.items.map((c) => (
        <GitHubCommitRow key={c.sha} {...commitProps(c, scope, pr.fetched_at, avatarFor)} />
      ))}
      {pr.commits.has_more ? (
        <DetailPart
          repository={pr.repository}
          number={pr.number}
          part="commits"
          object="pull request"
          idleLabel={`Show all commits · ${pr.commits.items.length}${commitTotal !== null ? ` of ${commitTotal}` : ""} in result`}
          row={(item, i) => <GitHubCommitRow key={i} {...commitProps(item as GithubCommit, scope, pr.fetched_at, avatarFor)} />}
        />
      ) : null}
    </div>
  );

  const files = (
    <DetailPart
      repository={pr.repository}
      number={pr.number}
      part="files"
      object="pull request"
      idleLabel={`Show files · ${pr.changes.changed_files} changed`}
      row={(item, i) => {
        const file = item as GithubChangedFile;
        return <ListRow key={i} title={file.filename} subtitle={file.previous_filename ? `from ${file.previous_filename} · ${file.status}` : file.status} value={`+${file.additions} −${file.deletions}`} />;
      }}
    />
  );

  const checkRows = (
    <DetailPart
      repository={pr.repository}
      number={pr.number}
      part="checks"
      object="pull request"
      idleLabel={checkTotal !== undefined ? `Show checks · ${checkTotal}` : "Show checks"}
      row={(item, i) => {
        const run = item as GithubCheckRun;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <GitHubStateChip state={run.state === "skipped" ? "none-reported" : run.state === "failed" ? "failing" : run.state} variant="inline" />
            <ListRow title={run.name} value={run.conclusion ?? undefined} />
          </div>
        );
      }}
    />
  );

  return (
    <GitHubPullRequest
      state={state}
      repo={pr.repository}
      number={pr.number}
      htmlUrl={directLink(pr.html_url, scope, { kind: "pull_request" })}
      title={pr.title}
      author={person(pr.author, avatarFor)}
      opened={`opened ${ago(pr.created_at, pr.fetched_at) ?? ""}`.trim()}
      headRef={pr.head_ref}
      baseRef={pr.base_ref}
      labels={pr.labels.items.map((l) => l.name)}
      reviews={reviewCounts(pr)}
      checks={checks(pr.checks)}
      size={{ files: pr.changes.changed_files, additions: pr.changes.additions, deletions: pr.changes.deletions }}
      commits={commitTotal}
      reviewers={reviewerRows(pr, avatarFor)}
      body={pr.body}
      bodyLength={pr.body_length}
      bodyTruncated={pr.body_truncated}
      merge={state === "merged" ? { by: pr.merged_by ? person(pr.merged_by, avatarFor) : null, into: pr.base_ref, sha: pr.merge_commit_sha?.slice(0, 7) ?? null, time: ago(pr.merged_at, pr.fetched_at) } : undefined}
      brainRead={brainRead(pr)}
      tabs={{
        items: [
          { label: PR_TABS[0], ...(commentTotal !== null ? { count: commentTotal } : {}) },
          { label: PR_TABS[1], ...(commitTotal !== null ? { count: commitTotal } : {}) },
          { label: PR_TABS[2], count: pr.changes.changed_files },
          { label: PR_TABS[3], ...(checkTotal !== undefined ? { count: checkTotal } : {}) },
        ],
        active: tab,
        onSelect: setTab,
      }}
    >
      {/* Files and Checks mount, and so load, only when their tab is opened.
          Keyed by tab: the tabs' sections sit in the same place in the tree,
          and without a key React would hand one tab's loaded rows to the next. */}
      <Fragment key={tab}>{tab === 0 ? conversation : tab === 1 ? commits : tab === 2 ? files : checkRows}</Fragment>
      {/* Line comments load on demand (#3796's review-comments part). The
          payload carries no per-review count, so this is one section for the
          pull request rather than a "Show n line comments" per review. */}
      {tab === 0 && pr.reviews.items.length > 0 ? (
        <DetailPart
          repository={pr.repository}
          number={pr.number}
          part="review-comments"
          object="pull request"
          idleLabel="Show line comments"
          row={(item, i) => <GitHubComment key={i} {...commentProps(item as GithubReviewComment, scope, pr.fetched_at, avatarFor)} />}
        />
      ) : null}
    </GitHubPullRequest>
  );
}

/** `brain_github_issue_read`'s result. */
export function GithubReadCard(result: GithubToolResult) {
  if (!result.ok) return <GithubRefusal error={result.error} />;
  if (result.tool !== "brain_github_issue_read") return null;
  return result.result.kind === "pull_request" ? <PullRequestCard pr={result.result} /> : <IssueCard issue={result.result} />;
}

/** `brain_github_issue_search`'s result. */
export function GithubSearchCard(result: GithubToolResult) {
  if (!result.ok) return <GithubRefusal error={result.error} />;
  if (result.tool !== "brain_github_issue_search") return null;
  const search: GithubIssueSearchPayload = result.result;
  return (
    <GitHubResultList
      repo={search.repository}
      query={search.query}
      total={search.total_count}
      results={search.items.map((item) => resultRow(item, search.repository))}
      incomplete={search.incomplete_results}
      searchUrl={searchLink(search)}
    />
  );
}

// ---------------------------------------------------------------------------
// Write (W1–W4)
// ---------------------------------------------------------------------------

/** W3: a write that did not happen, or whose outcome is unknown; otherwise the refusal's own words. */
function WriteRefusal({ error }: { error: GithubError }) {
  if (error.code === "approval_declined") return <GitHubWriteNotice outcome={error.reason === "edited" ? "changed" : "declined"} />;
  if (outcomeUnknown(error)) return <GitHubWriteNotice outcome="unknown" />;
  return <GithubRefusal error={error} />;
}

/** `brain_github_issue_create`'s result: W2 when posted, W3 otherwise. */
export function GithubCreateCard(result: GithubToolResult) {
  if (!result.ok) return <WriteRefusal error={result.error} />;
  if (result.tool !== "brain_github_issue_create") return null;
  const created = result.result;
  const scope = scopeOf(created.repository, created.number);
  return (
    <GitHubIssue
      state="open"
      repo={created.repository}
      number={created.number}
      htmlUrl={directLink(created.html_url, scope, { kind: "issue" })}
      title={created.title}
      labels={created.labels}
      posting={{ status: "posted" }}
    />
  );
}

/** `brain_github_issue_comment`'s result: the target and that the comment is posted (W4's result). */
export function GithubCommentCard(result: GithubToolResult) {
  if (!result.ok) return <WriteRefusal error={result.error} />;
  if (result.tool !== "brain_github_issue_comment") return null;
  const posted = result.result;
  const scope = scopeOf(posted.repository, posted.number);
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 }} data-github-comment-posted="">
      <GitHubStateChip state="posted" />
      <GitHubRef kind="issue" repo={posted.repository} number={posted.number} htmlUrl={directLink(posted.html_url, scope, { kind: "comment", id: posted.comment_id })} />
    </div>
  );
}

/** W1: the issue Brain asks to post, as it will look. */
export function GithubCreatePreview({ input }: { input: GithubIssueCreateInput }) {
  return (
    <GitHubIssue state="open" repo={input.repository} title={input.title} labels={input.labels ?? []} body={input.body ?? null} posting={{ status: "preview" }} />
  );
}

/** W4: the target and the comment Brain asks to post, as it will read. */
export function GithubCommentPreview({ input }: { input: GithubIssueCommentInput }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }} data-github-comment-preview="">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 }}>
        <GitHubStateChip state="not-posted" />
        <GitHubRef kind="issue" repo={input.repository} number={input.number} />
      </div>
      <UntrustedText text={input.body} source="this draft" sourcePhrase="in this draft" frame="rule" caption="Brain's draft · not posted" />
    </div>
  );
}
