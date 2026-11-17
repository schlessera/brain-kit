// The host GitHub tools' results as the ui-kit GitHub components (#3795).
//
// The components are #3800's, used unchanged. This file maps payloads onto
// them (through `../renderers/github-mapping.ts`) and owns the one fetch they
// trigger: on-demand detail pages through #3796's client, only after the
// reader acts. What loads is display-only and never reaches the model.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
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

/**
 * Brain-origin avatar URLs for this session, and only for logins the tool
 * result itself names (#3795). Anyone else, including authors of detail
 * loaded later, keeps initials: the avatar route serves only logins the
 * session has seen, and the card asks for no others.
 */
function useAvatarFor(logins: ReadonlySet<string>): AvatarFor {
  const root = useBrainUiRoot();
  const sessionId = useRootStore("chat", (s) => s.activeSessionId);
  return useCallback(
    (login: string) => (sessionId && logins.has(login) ? githubAvatarUrl(root.apiBase(), sessionId, login) : null),
    [root, sessionId, logins],
  );
}

type Named = { login: string | null } | null | undefined;
function loginsOf(...people: Named[]): Set<string> {
  return new Set(people.flatMap((p) => (p?.login ? [p.login] : [])));
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
  /**
   * A refusal the kit's S4–S7 words would misdescribe: one the host made
   * itself (not this chat's owner, not in this session, not a pull request,
   * the reader's sign-in) or GitHub rejecting the host's credential. Shown in
   * the host's own words instead of a state that blames GitHub.
   */
  refusal?: string;
  /** Pages answered so far, so a page that adds no visible row can be followed. */
  pages?: number;
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
  // GitHub's own refusals carry no reason or "github"; the host's carry theirs.
  const fromGithub = error.reason === null || error.reason === "github";
  if ((error.code === "not_found" || error.code === "forbidden") && fromGithub) return { state: "gone" };
  // S4 says "GitHub answered N" or "GitHub didn't answer", so only those two
  // facts read as S4: GitHub's HTTP status, or no answer from GitHub. Every
  // other failure (the host's own, its catch-all, an unreadable or redirected
  // answer) reads in the host's words, with its own Try again.
  const status = error.reason?.match(/^http_(\d{3})$/)?.[1];
  if (error.code === "upstream_error" && status) return { state: "error", errorStatus: Number(status) };
  if (error.code === "upstream_error" && (error.reason === "network" || error.reason === "timeout")) return { state: "error" };
  return { state: "error", refusal: error.message };
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
      // Nothing is sent without a session; that is no failure of GitHub's.
      if (!sessionId) {
        setDetail((d) => ({ ...d, state: "error", refusal: "Open this chat again to load more from GitHub." }));
        return;
      }
      // A new request starts clean: no earlier failure's status or reset time survives it.
      setDetail((d) => ({ ...d, state: "loading", refusal: undefined, errorStatus: undefined, resetAt: undefined, resetIn: undefined }));
      const answer = await fetchGithubDetailPage(root, { sessionId, repository, number, part, cursor });
      if (!answer.ok) {
        setDetail((d) => ({ ...d, ...detailErrorState(answer.error) }));
        return;
      }
      const page = answer.page;
      setDetail((d) => {
        const items = append ? [...d.items, ...(page.items as DetailItem[])] : (page.items as DetailItem[]);
        // Empty only when nothing is left to load: a page with no items can
        // still point on (the checks part's runs end by pointing at statuses).
        return { state: items.length === 0 && !page.next_cursor ? "empty" : "loaded", items, next: page.next_cursor, total: page.total_count, pages: (d.pages ?? 0) + 1 };
      });
    },
    [root, sessionId, repository, number, part],
  );

  const load = useCallback(() => void fetchPage(null, false), [fetchPage]);
  return {
    detail,
    load,
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

/** "Load more · 60 of 70 shown": `onScreen` counts what the reader sees, the result's rows included. */
function moreLabel(detail: Detail, onScreen: number): string | undefined {
  if (!detail.next) return undefined;
  const of = detail.total !== null ? ` of ${detail.total}` : "";
  return `Load more · ${onScreen}${of} shown`;
}

/** A detail section wired to #3796, rendering its rows with `row`. */
function DetailPart(p: {
  repository: string;
  number: number;
  part: GithubDetailPart;
  object: "issue" | "pull request";
  idleLabel: string;
  row: (item: DetailItem, index: number) => ReactNode;
  /**
   * Items the card already shows from the tool result. The route pages from
   * the oldest item, so its pages overlap what the result carried; these are
   * left out rather than drawn twice.
   */
  shown?: (item: DetailItem) => boolean;
  /** How many rows the card already shows from the tool result. */
  shownCount?: number;
  /** Load when the section first mounts (a tab's first open), not on a press. */
  autoLoad?: boolean;
}) {
  const { detail, load, more, retry } = useDetail(p.repository, p.number, p.part);
  const started = useRef(false);
  useEffect(() => {
    if (!p.autoLoad || started.current) return;
    started.current = true;
    load();
  }, [p.autoLoad, load]);
  const rows = p.shown ? detail.items.filter((item) => !p.shown!(item)) : detail.items;
  // A page that adds nothing on screen (empty, or only rows the result
  // already shows) is followed to the next, so one press always shows
  // something new or ends the list. The result carries at most one page of
  // duplicates, so this follows at most a page or two per press.
  const seen = useRef({ pages: 0, rows: 0 });
  useEffect(() => {
    const before = seen.current;
    seen.current = { pages: detail.pages ?? 0, rows: rows.length };
    if (detail.state === "loaded" && detail.next && (detail.pages ?? 0) > before.pages && rows.length === before.rows) more();
  }, [detail.pages, detail.state, detail.next, rows.length, more]);
  if (detail.refusal) {
    const refused = (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }} data-github-detail="refused">
        <GithubRefusal error={{ code: "unavailable", reason: null, message: detail.refusal }} />
        <Button label="Try again" tone="quiet" size="sm" block={false} onClick={retry} />
      </div>
    );
    // A later page refused: the rows already loaded stay, the refusal follows them.
    if (!rows.length) return refused;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <GitHubDetailSection state="loaded" noun={NOUN[p.part]} object={p.object} idleLabel={p.idleLabel} onLoad={load}>
          {rows.map((item, i) => p.row(item, i))}
        </GitHubDetailSection>
        {refused}
      </div>
    );
  }
  return (
    <GitHubDetailSection
      state={detail.state}
      noun={NOUN[p.part]}
      object={p.object}
      idleLabel={p.idleLabel}
      moreLabel={moreLabel(detail, (p.shownCount ?? 0) + rows.length)}
      errorStatus={detail.errorStatus}
      resetAt={detail.resetAt}
      resetIn={detail.resetIn}
      onLoad={load}
      onLoadMore={more}
      onRetry={retry}
    >
      {rows.length ? rows.map((item, i) => p.row(item, i)) : undefined}
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
  // `cancelled` is ambiguous: the host uses it both before sending ("nothing
  // was sent") and mid-request ("may still have been made"), so the host's
  // own words say which. `malformed` and `redirect` are their own refusals.
  // An `http_NNN` is GitHub answering with that status, which W3's "GitHub
  // didn't answer" would misstate; the host's words for it say the write may
  // not have been made.
  return error.code === "upstream_error" && (error.reason === "network" || error.reason === "timeout");
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
  const logins = useMemo(() => loginsOf(issue.author, ...issue.comments.items.map((c) => c.author)), [issue]);
  const avatarFor = useAvatarFor(logins);
  const shownComments = useMemo(() => new Set(issue.comments.items.map((c) => c.id)), [issue]);
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
              shown={(item) => shownComments.has((item as GithubCommentPayload).id)}
              shownCount={shownComments.size}
            />
          ) : undefined
        }
      />
    </GitHubIssue>
  );
}

const PR_TABS = ["Conversation", "Commits", "Files", "Checks"] as const;

function PullRequestCard({ pr }: { pr: GithubPullRequest }) {
  const logins = useMemo(
    () =>
      loginsOf(
        pr.author,
        pr.merged_by,
        ...pr.comments.items.map((c) => c.author),
        ...pr.reviews.items.map((r) => r.author),
        ...pr.review_decisions.map((d) => d.reviewer),
        ...pr.requested_reviewers,
        ...pr.commits.items.map((c) => c.author),
      ),
    [pr],
  );
  const avatarFor = useAvatarFor(logins);
  const shownComments = useMemo(() => new Set(pr.comments.items.map((c) => c.id)), [pr]);
  const shownCommits = useMemo(() => new Set(pr.commits.items.map((c) => c.sha)), [pr]);
  const [tab, setTab] = useState(0);
  // A tab's section mounts on its first open and stays mounted, hidden, after:
  // Files and Checks load on that first open (§7), and coming back to a tab
  // keeps what it loaded.
  const [visited, setVisited] = useState<ReadonlySet<number>>(() => new Set([0]));
  const select = (index: number) => {
    setTab(index);
    setVisited((v) => (v.has(index) ? v : new Set([...v, index])));
  };
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
            shown={(item) => shownComments.has((item as GithubCommentPayload).id)}
            shownCount={shownComments.size}
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
          shown={(item) => shownCommits.has((item as GithubCommit).sha)}
          shownCount={shownCommits.size}
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
      autoLoad
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
      autoLoad
      row={(item, i) => {
        const run = item as GithubCheckRun;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {/* A skipped run is reported, not absent: no state chip, and its word. */}
            {run.state === "skipped" ? null : <GitHubStateChip state={run.state === "failed" ? "failing" : run.state} variant="inline" />}
            <ListRow title={run.name} value={run.state === "skipped" ? "skipped" : (run.conclusion ?? undefined)} />
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
        onSelect: select,
      }}
    >
      {[conversation, commits, files, checkRows].map((content, index) =>
        visited.has(index) ? (
          <div key={index} hidden={tab !== index}>
            {content}
          </div>
        ) : null,
      )}
      {/* Line comments load on demand (#3796's review-comments part). The
          payload carries no per-review count, so this is one section for the
          pull request rather than a "Show n line comments" per review. */}
      {pr.reviews.items.length > 0 ? (
        <div hidden={tab !== 0}>
        <DetailPart
          repository={pr.repository}
          number={pr.number}
          part="review-comments"
          object="pull request"
          idleLabel="Show line comments"
          row={(item, i) => <GitHubComment key={i} {...commentProps(item as GithubReviewComment, scope, pr.fetched_at, avatarFor)} />}
        />
        </div>
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
  // Only the reader's own choice on the approval card reads as declined or
  // changed; a refusal no one chose (a voice turn) keeps the host's words.
  if (error.code === "approval_declined" && (error.reason === "declined" || error.reason === "edited"))
    return <GitHubWriteNotice outcome={error.reason === "edited" ? "changed" : "declined"} />;
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
  const htmlUrl = directLink(posted.html_url, scope, { kind: "comment", id: posted.comment_id });
  // The comment tool posts on issues and pull requests alike; only the
  // validated URL says which (`/pull/` or `/issues/`). Without one, the
  // target is named without claiming either.
  const kind = htmlUrl ? (new URL(htmlUrl).pathname.split("/")[3] === "pull" ? "pr" : "issue") : null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 }} data-github-comment-posted="">
      <GitHubStateChip state="posted" />
      {kind ? <GitHubRef kind={kind} repo={posted.repository} number={posted.number} htmlUrl={htmlUrl} /> : <Target repository={posted.repository} number={posted.number} />}
    </div>
  );
}

/** A comment's target when its kind is unknown: `owner/repo #n`, claiming neither issue nor pull request. */
function Target({ repository, number }: { repository: string; number: number }) {
  return (
    <span style={{ color: "var(--bk-color-ink-dim)", fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }} data-github-target="">
      {repository} #{number}
    </span>
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
        {/* The approval names a number, not whether it is an issue or a pull request (#4154). */}
        <Target repository={input.repository} number={input.number} />
      </div>
      <UntrustedText text={input.body} source="this draft" sourcePhrase="in this draft" frame="rule" caption="Brain's draft · not posted" />
    </div>
  );
}
