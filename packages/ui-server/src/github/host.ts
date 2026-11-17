/**
 * The host GitHub tools (#3797, epic #3791). A hosted turn reads GitHub only
 * through these: the host holds the dedicated credential
 * (`BRAIN_UI_GITHUB_TOOLS_TOKEN`, no fallback), calls the fixed API origin,
 * binds the turn, records the session's untrusted-input taint before any
 * remote text returns, and shapes every response into the contract's
 * payloads (`@schlessera/brain-ui-sdk/tool-contracts`, `github.ts`).
 *
 * Every direct link is taken from the API response and passes the contract's
 * validator, or is null. The search link is built by the contract's builder.
 *
 * Writes (#3798): an issue or a comment goes only to a repository the turn's
 * admitted governance policy lists under `outward.github.repositories`. One
 * outside the list is refused before any card, and nothing is sent. Inside
 * it, the turn's own approval surface shows one per-use card with exactly
 * what will be sent; only an unedited allow sends it, once. Voice refuses
 * before the card. Each admission, refusal and answer is recorded as an
 * `outward_action` (`gh_write`), which the turn journal lists as irreversible.
 *
 * Data routing (G2, #4029): GitHub is the provider-policy recipient `github`.
 * A read or search sends model-chosen text (a query, a repository and number),
 * so a conversation that has shown a provider folder the policy keeps from
 * `github`, or whose exposure cannot be judged, sends GitHub nothing. Writes
 * are not routed: the per-use card, which shows the exact body, and the
 * allow-list are their gate (maintainer ruling, 2026-11-16).
 */
import { githubWriteAllowance } from "@schlessera/brain-common/internal/governance-policy";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { RecipientRoutingRefusal } from "../web-tools/routing.js";
import {
  GITHUB_API_ORIGIN, GITHUB_ISSUE_COMMENT_INPUT_SCHEMA, GITHUB_ISSUE_CREATE_INPUT_SCHEMA, GITHUB_ISSUE_READ_INPUT_SCHEMA, GITHUB_ISSUE_SEARCH_INPUT_SCHEMA, GITHUB_LIMITS, GITHUB_TOOL_NAMES,
  GITHUB_AUTHOR_ASSOCIATIONS, githubDirectUrl, githubSearchUrl, parseGithubRepository,
  type GithubAuthor, type GithubChecks, type GithubComment, type GithubCommit, type GithubErrorCode, type GithubIssue,
  type GithubIssueReadInput, type GithubIssueSearchInput, type GithubIssueSearchPayload, type GithubLabel, type GithubLinkScope,
  type GithubPullRequest, type GithubReadToolName, type GithubReview, type GithubReviewDecision, type GithubSearchItem,
  type GithubToolCall, type GithubToolName, type GithubToolResult, type GithubUser, type GithubWriteToolName,
  type GithubIssueCreatePayload, type GithubIssueCommentPayload,
} from "@schlessera/brain-ui-sdk/tool-contracts";

/** GitHub's name as a provider-policy recipient (G2), beside `apify` and the web providers. */
export const GITHUB_RECIPIENT = "github";

/** Why the turn's data routing refuses a recipient; see `recipientRouting`. */
export type GithubRoutingRefusal = RecipientRoutingRefusal;

/** The recorded `outward_action` of one GitHub write, as the governance writer takes it. */
export interface GithubOutwardAction {
  kind: "outward_action";
  payload: {
    tool: string; input: string; inputTruncated: boolean; action: "gh_write"; target: string;
    historyRewrite: false; tainted: boolean; decision: "approved" | "declined" | "refused"; rule: null;
  };
}

/**
 * What a write needs from its turn. All of it is bound by the host from the
 * turn, never from the call; without it, writes refuse.
 */
export interface GithubWriteTurn {
  /** The admitted policy's `outward.github.repositories`; null when the turn runs under no governance policy. */
  readonly repositories: () => readonly string[] | null;
  readonly posture: "interactive" | "voice";
  /** The turn's own approval surface. */
  readonly requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** The tool's name as this backend shows it on the card. */
  readonly toolName: (name: GithubWriteToolName) => string;
  /** Whether the session has ingested untrusted input; a failing read counts as tainted. */
  readonly tainted: () => boolean;
  /** Whether the turn still holds current authority, checked again after the card. */
  readonly isCurrent: () => boolean;
  /** Records the decision. A write is sent only after its approval's record settles without error. */
  readonly govern: (event: GithubOutwardAction) => void | Promise<void>;
}

/** The turn a call belongs to, bound by the host, never by the call. */
export interface GithubToolsTurn {
  readonly turnId: string;
  readonly principalId: string;
  readonly sessionId: () => string | null;
  readonly signal?: AbortSignal;
  /**
   * Data routing (G2, #4029) under the turn's frozen policy and the
   * conversation's recorded exposures, asked before any read or search
   * request. A throw counts as unproven.
   */
  readonly routing: (recipient: typeof GITHUB_RECIPIENT) => Promise<GithubRoutingRefusal | null>;
  /** Present only on a turn that may write (#3798); an autonomous turn has none. */
  readonly write?: GithubWriteTurn;
}

export interface GithubToolsHostOptions {
  /** The dedicated credential, read once at the edge; undefined answers `unavailable`. */
  token: () => string | undefined;
  /**
   * Records the session's untrusted-input taint. Awaited before any GitHub
   * text is returned; when it throws, the text is withheld.
   */
  untrusted: (turn: GithubToolsTurn, event: { tool: GithubReadToolName; detail: string }) => Promise<void>;
  /** @internal Test seam; production uses the global fetch against {@link GITHUB_API_ORIGIN}. */
  fetch?: typeof fetch;
  now?: () => number;
  /** One request's limit, milliseconds. */
  timeoutMs?: number;
  report?: (message: string) => void;
}

export interface GithubToolsHost {
  call(turn: GithubToolsTurn, call: GithubToolCall): Promise<GithubToolResult>;
}

/** A typed refusal; `resetAt` is when a spent rate limit resets, when GitHub says. */
export class GithubRefusal extends Error {
  constructor(readonly code: GithubErrorCode, readonly reason: string | null, message: string, readonly resetAt: string | null = null) { super(message); }
}

export type Json = Record<string, unknown>;
export const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const text = (value: unknown): string | null => typeof value === "string" ? value : null;
export const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value: unknown): boolean => value === true;
export const LOGIN = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
export const SHA = /^[0-9a-f]{40}$/;
const COLOR = /^[0-9a-fA-F]{6}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const time = (value: unknown): string | null => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
export const requiredTime = (value: unknown, fallback: string): string => time(value) ?? fallback;

/** Cut at `max` characters without splitting a surrogate pair. */
export function cut(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

function user(value: unknown): GithubUser {
  const raw = record(value);
  const login = text(raw?.login);
  return { login: login && LOGIN.test(login) ? login : null, is_bot: raw?.type === "Bot" || (login?.endsWith("[bot]") ?? false) };
}
export function author(value: unknown, association: unknown): GithubAuthor {
  return { ...user(value), author_association: (GITHUB_AUTHOR_ASSOCIATIONS as readonly unknown[]).includes(association) ? association as GithubAuthor["author_association"] : null };
}
export function body(value: unknown, max: number) {
  const raw = text(value) ?? "";
  const { text: kept, truncated } = cut(raw, max);
  return { body: raw.length ? kept : null, body_length: raw.length, body_truncated: truncated };
}
function labels(value: unknown) {
  const all = array(value).map(record).filter((label): label is Json => label !== null);
  const items: GithubLabel[] = all.slice(0, GITHUB_LIMITS.labels).map(label => {
    const color = text(label.color), description = text(label.description);
    return { name: cut(text(label.name) ?? "", GITHUB_LIMITS.labelNameChars).text, color: color && COLOR.test(color) ? color : null,
      description: description ? cut(description, GITHUB_LIMITS.labelDescriptionChars).text : null };
  });
  return { items, total_count: all.length, has_more: all.length > items.length };
}
const stateReason = (value: unknown) => (["completed", "not_planned", "reopened", "duplicate"] as const).find(reason => reason === value) ?? null;
const state = (value: unknown): "open" | "closed" => value === "open" ? "open" : "closed";

export function comment(value: Json, scope: GithubLinkScope, fallback: string): GithubComment | null {
  const id = integer(value.id);
  if (!id) return null;
  return { id, author: author(value.user, value.author_association), created_at: requiredTime(value.created_at, fallback),
    updated_at: requiredTime(value.updated_at, requiredTime(value.created_at, fallback)), ...body(value.body, GITHUB_LIMITS.commentBodyChars),
    html_url: githubDirectUrl(value.html_url, scope, { kind: "comment", id }) };
}

const REVIEW_STATES: Record<string, GithubReview["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };
export function review(value: Json, scope: GithubLinkScope): GithubReview | null {
  const id = integer(value.id), reviewState = REVIEW_STATES[String(value.state)];
  if (!id || !reviewState) return null;
  return { id, author: author(value.user, value.author_association), state: reviewState, submitted_at: time(value.submitted_at),
    ...body(value.body, GITHUB_LIMITS.commentBodyChars), html_url: githubDirectUrl(value.html_url, scope, { kind: "review", id }), line_comments: null };
}

/**
 * Each review's line-comment count (#4147), from one page of a pull request's
 * review comments: the review id to its total, or null (every count unknown).
 * Exact only when that page is the whole collection, every comment validates
 * and names its review, and GitHub's own total, when it gives one, agrees. A
 * page cut short, a comment without a review, a malformed one or a mismatch
 * gives no partial total and no invented zero.
 */
function lineCommentCounts(json: unknown, hasNext: boolean, reported: number | null): Map<number, number> | null {
  if (hasNext || !Array.isArray(json) || json.length > GITHUB_LIMITS.reviewComments) return null;
  if (reported !== null && reported !== json.length) return null;
  const counts = new Map<number, number>(), ids = new Set<number>();
  for (const raw of json) {
    const item = record(raw), id = integer(item?.id), reviewId = integer(item?.pull_request_review_id);
    if (!id || !reviewId || ids.has(id)) return null;
    ids.add(id);
    counts.set(reviewId, (counts.get(reviewId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The latest review state per reviewer. A later `commented` review does not
 * replace an approval, a request for changes or a dismissal, as on GitHub;
 * a pending (unsubmitted) review is not a decision.
 */
export function reviewDecisions(reviews: readonly GithubReview[]): GithubReviewDecision[] {
  const latest = new Map<string, GithubReviewDecision>();
  for (const item of reviews) {
    const login = item.author.login;
    if (!login || item.state === "pending") continue;
    const previous = latest.get(login);
    if (item.state === "commented" && previous && previous.state !== "commented") continue;
    latest.set(login, { reviewer: { login, is_bot: item.author.is_bot }, state: item.state, submitted_at: item.submitted_at });
  }
  return [...latest.values()];
}

export function commit(value: Json, scope: GithubLinkScope): GithubCommit | null {
  const sha = text(value.sha);
  if (!sha || !SHA.test(sha)) return null;
  const detail = record(value.commit), recorded = record(detail?.author);
  const linked = record(value.author);
  const message = cut(text(detail?.message) ?? "", GITHUB_LIMITS.commitMessageChars);
  const name = text(recorded?.name);
  return { sha, author: linked ? user(linked) : null, author_name: name ? cut(name, 256).text : null, authored_at: time(recorded?.date),
    message: message.text, message_truncated: message.truncated, html_url: githubDirectUrl(value.html_url, scope, { kind: "commit", sha }) };
}

/** The `rel="next"` target of a Link header, when GitHub names one. */
export function nextLink(response: Response): string | null {
  const header = response.headers.get("link");
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

/**
 * When a spent rate limit resets: `x-ratelimit-reset` (epoch seconds), else
 * `retry-after` (seconds from now), else unknown.
 */
function rateLimitReset(response: Response, now: () => number): string | null {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isSafeInteger(reset) && reset > 0 && reset < 1e11) return new Date(reset * 1000).toISOString();
  const after = Number(response.headers.get("retry-after"));
  if (Number.isSafeInteger(after) && after >= 0 && after < 1e7) return new Date(now() + after * 1000).toISOString();
  return null;
}

/** How a GET reaches the API: the test seam, the clock and one request's limit. */
export interface GithubTransport { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

/** One GET against the fixed API origin with the host credential. Redirects are followed only within it. */
export async function githubGet(transport: GithubTransport, token: string, path: string, signal: AbortSignal | undefined): Promise<{ json: unknown; response: Response }> {
  let url = new URL(path, GITHUB_API_ORIGIN);
  for (let hop = 0; hop < 4; hop++) {
    if (url.origin !== GITHUB_API_ORIGIN) throw new GithubRefusal("upstream_error", "redirect", "GitHub redirected outside its API.");
    const timeout = AbortSignal.timeout(transport.timeoutMs ?? 20_000);
    let response: Response;
    try {
      response = await (transport.fetch ?? fetch)(url, { method: "GET", redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "brain-ui" } });
    } catch {
      if (signal?.aborted) throw new GithubRefusal("upstream_error", "cancelled", "The turn ended before GitHub answered.");
      throw new GithubRefusal("upstream_error", timeout.aborted ? "timeout" : "network", timeout.aborted ? "GitHub did not answer in time." : "GitHub could not be reached.");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    if (!response.ok) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429;
      if (limited) throw new GithubRefusal("rate_limited", null, "GitHub's rate limit for the host credential is spent; try again later.", rateLimitReset(response, transport.now ?? Date.now));
      if (response.status === 401) throw new GithubRefusal("unavailable", "credential_rejected", "GitHub rejected the host's GitHub tools credential.");
      if (response.status === 404 || response.status === 410) throw new GithubRefusal("not_found", null, "GitHub has no such issue or repository, or the host's credential cannot see it.");
      if (response.status === 403) throw new GithubRefusal("forbidden", null, "The host's GitHub credential is not permitted to read this.");
      if (response.status === 422) throw new GithubRefusal("invalid_input", "github_validation", "GitHub refused the search.");
      throw new GithubRefusal("upstream_error", `http_${response.status}`, `GitHub answered ${response.status}.`);
    }
    try { return { json: await response.json(), response }; }
    catch { throw new GithubRefusal("upstream_error", "malformed", "GitHub returned malformed JSON."); }
  }
  throw new GithubRefusal("upstream_error", "redirect", "GitHub redirected too many times.");
}

export function createGithubToolsHost(options: GithubToolsHostOptions): GithubToolsHost {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const get = (token: string, path: string, signal: AbortSignal | undefined) => githubGet(options, token, path, signal);

  /** A path below the API origin from a `next` link, only when it stays there. */
  const relative = (link: string) => {
    const url = new URL(link);
    if (url.origin !== GITHUB_API_ORIGIN) throw new GithubRefusal("upstream_error", "redirect", "GitHub paged outside its API.");
    return `${url.pathname}${url.search}`;
  };

  /** The most recent comments, oldest first, in at most two pages. */
  async function latestComments(token: string, base: string, total: number, scope: GithubLinkScope, fallback: string, signal?: AbortSignal) {
    const size = GITHUB_LIMITS.comments;
    if (total === 0) return { items: [] as GithubComment[], total_count: 0, has_more: false };
    const last = Math.max(1, Math.ceil(total / size));
    const pages = last > 1 ? [last - 1, last] : [last];
    const raw: unknown[] = [];
    for (const page of pages) raw.push(...array((await get(token, `${base}/comments?per_page=${size}&page=${page}`, signal)).json));
    const items = raw.map(record).filter((item): item is Json => item !== null).map(item => comment(item, scope, fallback))
      .filter((item): item is GithubComment => item !== null).slice(-size);
    return { items, total_count: total, has_more: total > items.length };
  }

  async function checks(token: string, repo: string, sha: string, signal?: AbortSignal): Promise<GithubChecks> {
    const counts = { passed: 0, failed: 0, running: 0, skipped: 0 };
    let reported = 0;
    try {
      let path: string | null = `/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
      for (let page = 0; path; page++) {
        if (page === 10) return null;
        const { json, response } = await get(token, path, signal);
        for (const run of array(record(json)?.check_runs).map(record)) {
          if (!run) continue;
          reported++;
          if (run.status !== "completed") counts.running++;
          else if (["success", "neutral"].includes(String(run.conclusion))) counts.passed++;
          else if (run.conclusion === "skipped") counts.skipped++;
          else counts.failed++;
        }
        const next = nextLink(response);
        path = next ? relative(next) : null;
      }
      const status = record((await get(token, `/repos/${repo}/commits/${sha}/status?per_page=100`, signal)).json);
      for (const item of array(status?.statuses).map(record)) {
        if (!item) continue;
        reported++;
        if (item.state === "success") counts.passed++;
        else if (item.state === "pending") counts.running++;
        else counts.failed++;
      }
    } catch (error) {
      // A credential without checks permission reports nothing, which is not zero.
      if (error instanceof GithubRefusal && ["forbidden", "not_found"].includes(error.code)) return null;
      throw error;
    }
    return reported ? counts : null;
  }

  /** {@link lineCommentCounts} over one bounded request; a credential that cannot read review comments leaves every count unknown. */
  async function reviewCommentCounts(token: string, repo: string, number: number, reported: number | null, signal?: AbortSignal) {
    try {
      const { json, response } = await get(token, `/repos/${repo}/pulls/${number}/comments?per_page=${GITHUB_LIMITS.reviewComments}`, signal);
      return lineCommentCounts(json, nextLink(response) !== null, reported);
    } catch (error) {
      if (error instanceof GithubRefusal && ["forbidden", "not_found"].includes(error.code)) return null;
      throw error;
    }
  }

  async function read(token: string, input: GithubIssueReadInput, signal?: AbortSignal): Promise<GithubIssue | GithubPullRequest> {
    const { owner, repo } = parseGithubRepository(input.repository)!;
    const name = `${owner}/${repo}`, base = `/repos/${name}/issues/${input.number}`;
    const fetchedAt = new Date(now()).toISOString();
    const issue = record((await get(token, base, signal)).json);
    if (!issue || integer(issue.number) !== input.number) throw new GithubRefusal("upstream_error", "malformed", "GitHub returned an unexpected issue.");
    const isPull = record(issue.pull_request) !== null;
    const scope = { owner, repo, number: input.number };
    const title = cut(text(issue.title) ?? "", GITHUB_LIMITS.titleChars);
    const fields = {
      repository: name, number: input.number, title: title.text, title_truncated: title.truncated, state: state(issue.state),
      state_reason: stateReason(issue.state_reason), locked: flag(issue.locked), author: author(issue.user, issue.author_association),
      labels: labels(issue.labels), created_at: requiredTime(issue.created_at, fetchedAt), updated_at: requiredTime(issue.updated_at, fetchedAt),
      closed_at: time(issue.closed_at), ...body(issue.body, GITHUB_LIMITS.bodyChars),
      comments: await latestComments(token, base, integer(issue.comments) ?? 0, scope, fetchedAt, signal),
      html_url: githubDirectUrl(issue.html_url, scope, { kind: isPull ? "pull_request" : "issue" }), fetched_at: fetchedAt,
    };
    if (!isPull) return { kind: "issue", ...fields };
    const pull = record((await get(token, `/repos/${name}/pulls/${input.number}`, signal)).json);
    if (!pull) throw new GithubRefusal("upstream_error", "malformed", "GitHub returned an unexpected pull request.");
    const reviewPage = await get(token, `/repos/${name}/pulls/${input.number}/reviews?per_page=${GITHUB_LIMITS.reviews}`, signal);
    const reviews = array(reviewPage.json).map(record).filter((item): item is Json => item !== null).map(item => review(item, scope))
      .filter((item): item is GithubReview => item !== null);
    const reviewsMore = nextLink(reviewPage.response) !== null;
    const counts = reviews.length ? await reviewCommentCounts(token, name, input.number, integer(pull.review_comments), signal) : null;
    for (const item of reviews) item.line_comments = counts ? counts.get(item.id) ?? 0 : null;
    const commitPage = await get(token, `/repos/${name}/pulls/${input.number}/commits?per_page=${GITHUB_LIMITS.commits}`, signal);
    const commits = array(commitPage.json).map(record).filter((item): item is Json => item !== null).map(item => commit(item, scope))
      .filter((item): item is GithubCommit => item !== null);
    const commitTotal = integer(pull.commits) ?? commits.length;
    const head = record(pull.head), headSha = text(head?.sha);
    const mergeSha = text(pull.merge_commit_sha);
    return { kind: "pull_request", ...fields,
      draft: flag(pull.draft), merged: flag(pull.merged), merged_at: time(pull.merged_at), merged_by: record(pull.merged_by) ? user(pull.merged_by) : null,
      // GitHub fills merge_commit_sha with a test merge while open; only a merged pull request has one.
      merge_commit_sha: flag(pull.merged) && mergeSha && SHA.test(mergeSha) ? mergeSha : null,
      head_ref: cut(text(head?.ref) ?? "", GITHUB_LIMITS.refChars).text, base_ref: cut(text(record(pull.base)?.ref) ?? "", GITHUB_LIMITS.refChars).text,
      requested_reviewers: array(pull.requested_reviewers).slice(0, GITHUB_LIMITS.requestedReviewers).map(user),
      reviews: { items: reviews, total_count: reviewsMore ? null : reviews.length, has_more: reviewsMore },
      review_decisions: reviewDecisions(reviews),
      checks: headSha && SHA.test(headSha) ? await checks(token, name, headSha, signal) : null,
      changes: { changed_files: integer(pull.changed_files) ?? 0, additions: integer(pull.additions) ?? 0, deletions: integer(pull.deletions) ?? 0 },
      commits: { items: commits, total_count: commitTotal, has_more: commitTotal > commits.length },
    };
  }

  async function search(token: string, input: GithubIssueSearchInput, signal?: AbortSignal): Promise<GithubIssueSearchPayload> {
    const { owner, repo } = parseGithubRepository(input.repository)!;
    const name = `${owner}/${repo}`;
    const fetchedAt = new Date(now()).toISOString();
    const qualifiers = [input.kind === "issue" ? "is:issue" : input.kind === "pull_request" ? "is:pr" : null,
      input.state === "open" ? "is:open" : input.state === "closed" ? "is:closed" : null].filter(Boolean).join(" ");
    const searchQuery = qualifiers ? `${qualifiers} ${input.query}` : input.query;
    const params = new URLSearchParams({ q: `repo:${name} ${searchQuery}`, per_page: String(input.limit), sort: "updated", order: "desc" });
    const found = record((await get(token, `/search/issues?${params}`, signal)).json);
    if (!found) throw new GithubRefusal("upstream_error", "malformed", "GitHub returned an unexpected search result.");
    const expectedRepository = `${GITHUB_API_ORIGIN}/repos/${name}`.toLowerCase();
    const items: GithubSearchItem[] = [];
    for (const raw of array(found.items).map(record)) {
      const number = integer(raw?.number);
      // Only this repository's results: a qualifier GitHub honours inside the text never widens the scope.
      if (!raw || !number || String(raw.repository_url).toLowerCase() !== expectedRepository) continue;
      const pull = record(raw.pull_request);
      const title = cut(text(raw.title) ?? "", GITHUB_LIMITS.titleChars).text;
      const excerpt = text(raw.body)?.trim();
      items.push({ kind: pull ? "pull_request" : "issue", number, title, state: state(raw.state), state_reason: stateReason(raw.state_reason),
        draft: pull ? flag(raw.draft) : null, merged_at: pull ? time(pull.merged_at) : null, comments: integer(raw.comments) ?? 0,
        author: author(raw.user, raw.author_association), labels: labels(raw.labels), created_at: requiredTime(raw.created_at, fetchedAt),
        updated_at: requiredTime(raw.updated_at, fetchedAt), excerpt: excerpt ? cut(excerpt, GITHUB_LIMITS.excerptChars).text : null,
        html_url: githubDirectUrl(raw.html_url, { owner, repo, number }, { kind: pull ? "pull_request" : "issue" }) });
    }
    const total = integer(found.total_count) ?? items.length;
    return { kind: "search", repository: name, query: input.query, search_query: searchQuery, total_count: total,
      incomplete_results: flag(found.incomplete_results), has_more: total > items.length, items,
      search_url: githubSearchUrl({ owner, repo }, searchQuery), fetched_at: fetchedAt };
  }

  const refusal = (tool: GithubToolName, code: GithubErrorCode, reason: string | null, message: string): GithubToolResult =>
    ({ ok: false, tool, error: { code, reason, message } });
  const noCredential = (tool: GithubToolName) =>
    refusal(tool, "unavailable", "no_credential", "This host has no GitHub credential for its GitHub tools (BRAIN_UI_GITHUB_TOOLS_TOKEN). GITHUB_TOKEN is never used for them.");

  /**
   * One POST against the fixed API origin, sent once. A redirect is not
   * followed: repeating a write could file it twice.
   */
  async function post(token: string, path: string, payload: Json, signal: AbortSignal | undefined): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL(path, GITHUB_API_ORIGIN), { method: "POST", redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, body: JSON.stringify(payload),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json",
          "x-github-api-version": "2022-11-28", "user-agent": "brain-ui" } });
    } catch {
      // The request may have reached GitHub: say so rather than invite a duplicate.
      throw new GithubRefusal("upstream_error", signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network",
        "GitHub did not confirm the write. It may still have been made: read the issue before trying again.");
    }
    if (!response.ok) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429;
      if (limited) throw new GithubRefusal("rate_limited", null, "GitHub's rate limit for the host credential is spent; nothing was written. Try again later.");
      if (response.status === 401) throw new GithubRefusal("unavailable", "credential_rejected", "GitHub rejected the host's GitHub tools credential; nothing was written.");
      if (response.status === 404 || response.status === 410) throw new GithubRefusal("not_found", null, "GitHub has no such issue or repository, or the host's credential cannot see it; nothing was written.");
      if (response.status === 403) throw new GithubRefusal("forbidden", null, "The host's GitHub credential is not permitted to write here; nothing was written.");
      if (response.status === 422) throw new GithubRefusal("invalid_input", "github_validation", "GitHub refused the write as invalid; nothing was written.");
      throw new GithubRefusal("upstream_error", `http_${response.status}`, `GitHub answered ${response.status}; the write may not have been made.`);
    }
    try { return await response.json(); }
    catch { throw new GithubRefusal("upstream_error", "malformed", "GitHub accepted the write but returned malformed JSON."); }
  }

  /** What one write sends: the card shows `card`, and `payload` is the request body, built from the same values. */
  function prepareWrite(call: Extract<GithubToolCall, { tool: GithubWriteToolName }>) {
    if (call.tool === GITHUB_TOOL_NAMES.create) {
      const input = GITHUB_ISSUE_CREATE_INPUT_SCHEMA.parse(call.input);
      const payload: Json = { title: input.title, ...(input.body !== undefined ? { body: input.body } : {}), ...(input.labels !== undefined ? { labels: input.labels } : {}) };
      return { repository: input.repository, path: `/repos/${input.repository}/issues`, payload, card: { repository: input.repository, ...payload } as Json,
        target: input.repository, describe: `File this issue in ${input.repository} on GitHub` };
    }
    const input = GITHUB_ISSUE_COMMENT_INPUT_SCHEMA.parse(call.input);
    const payload: Json = { body: input.body };
    return { repository: input.repository, path: `/repos/${input.repository}/issues/${input.number}/comments`, payload,
      card: { repository: input.repository, number: input.number, ...payload } as Json, target: `${input.repository}#${input.number}`,
      describe: `Post this comment on ${input.repository}#${input.number} on GitHub` };
  }

  /** Canonical JSON with sorted keys, so an echoed card compares equal to the one shown. */
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Json).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

  async function write(turn: GithubToolsTurn, call: Extract<GithubToolCall, { tool: GithubWriteToolName }>): Promise<GithubToolResult> {
    const { tool } = call;
    const ctx = turn.write;
    // An autonomous or otherwise unbound turn has no approval surface and no policy: it never writes.
    if (!ctx) return refusal(tool, "policy_denied", "no_write_surface", "GitHub writes are not available in this turn. Unattended work never writes to GitHub.");
    const prepared = prepareWrite(call);
    const visible = ctx.toolName(tool);
    let tainted = true;
    try { tainted = ctx.tainted(); } catch { /* Unknown taint is tainted. */ }
    /** Records the decision. Only an approval's record is load-bearing: unrecorded, nothing is sent. */
    const decide = async (decision: "approved" | "declined" | "refused"): Promise<boolean> => {
      const recorded = canonical(prepared.card);
      try {
        await ctx.govern({ kind: "outward_action", payload: { tool: visible, input: recorded.slice(0, 8192), inputTruncated: recorded.length > 8192,
          action: "gh_write", target: prepared.target, historyRewrite: false, tainted, decision, rule: null } });
        return true;
      } catch (error) {
        options.report?.(`GitHub write ${decision} not recorded: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    // The allow-list first: a repository it does not open never reaches a card or GitHub.
    const allowance = githubWriteAllowance(ctx.repositories() ?? [], prepared.repository);
    if (!allowance) {
      await decide("refused");
      return refusal(tool, "policy_denied", "repository_not_allowed",
        `${prepared.repository} is not open to GitHub writes. The governance policy's outward.github.repositories must list it (owner/repo or owner/*); nothing was sent.`);
    }
    if (ctx.posture !== "interactive") {
      await decide("refused");
      return refusal(tool, "approval_declined", "voice_posture", "Voice cannot approve a GitHub write. Nothing was sent; ask for it in a typed conversation.");
    }
    const token = options.token();
    if (!token) return noCredential(tool);
    const decision = await ctx.requestPermission({ toolUseId: `github-${crypto.randomUUID()}`, toolName: visible, kind: "command", input: prepared.card,
      description: `${prepared.describe}, exactly as shown. It is sent once, in your name, through the host's GitHub credential, and cannot be undone from here.`
        + (tainted ? " This conversation has read untrusted input; its content may have been shaped by it." : "") });
    // An edited card is a different write: it is refused, and the call must be made again as wanted, which rechecks it.
    const edited = decision.behavior === "allow" && decision.updatedInput !== undefined && canonical(decision.updatedInput) !== canonical(prepared.card);
    if (decision.behavior !== "allow" || edited) {
      await decide("declined");
      return refusal(tool, "approval_declined", edited ? "edited" : "declined", edited
        ? "The approval changed what would be sent, so nothing was sent. Make the call again with the content you want, to be approved as it is."
        : "The user declined this GitHub write; nothing was sent.");
    }
    if (turn.signal?.aborted || !ctx.isCurrent()) {
      await decide("refused");
      return refusal(tool, "upstream_error", "cancelled", "The turn ended before the write was sent; nothing was sent.");
    }
    if (!await decide("approved")) return refusal(tool, "unavailable", "recording_unavailable", "The approval could not be recorded, so nothing was sent.");
    const { owner, repo } = parseGithubRepository(prepared.repository)!;
    const created = record(await post(token, prepared.path, prepared.payload, turn.signal));
    if (tool === GITHUB_TOOL_NAMES.create) {
      const number = integer(created?.number);
      if (!created || !number) throw new GithubRefusal("upstream_error", "malformed", "GitHub accepted the issue but returned an unexpected answer.");
      const result: GithubIssueCreatePayload = { kind: "issue_created", repository: `${owner}/${repo}`, number,
        title: cut(text(created.title) ?? "", GITHUB_LIMITS.titleChars).text, labels: labels(created.labels).items.map(label => label.name),
        created_at: requiredTime(created.created_at, new Date(now()).toISOString()),
        html_url: githubDirectUrl(created.html_url, { owner, repo, number }, { kind: "issue" }) };
      return { ok: true, tool, result };
    }
    const number = (call.input as { number: number }).number;
    const id = integer(created?.id);
    if (!created || !id) throw new GithubRefusal("upstream_error", "malformed", "GitHub accepted the comment but returned an unexpected answer.");
    const result: GithubIssueCommentPayload = { kind: "comment_created", repository: `${owner}/${repo}`, number, comment_id: id,
      created_at: requiredTime(created.created_at, new Date(now()).toISOString()),
      html_url: githubDirectUrl(created.html_url, { owner, repo, number }, { kind: "comment", id }) };
    return { ok: true, tool, result };
  }

  return {
    async call(turn, call) {
      const { tool } = call;
      if (tool === GITHUB_TOOL_NAMES.create || tool === GITHUB_TOOL_NAMES.comment) {
        try { return await write(turn, call); }
        catch (error) {
          if (error instanceof GithubRefusal) return refusal(tool, error.code, error.reason, error.message);
          if (error instanceof Error && error.name === "ZodError") return refusal(tool, "invalid_input", null, "The input does not match the tool's schema; nothing was sent.");
          options.report?.(`GitHub tool ${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
          return refusal(tool, "upstream_error", null, "The GitHub write failed; it may not have been made.");
        }
      }
      const token = options.token();
      if (!token) return noCredential(tool);
      // G2 before any request: a refusal sends GitHub nothing, so nothing returns to taint.
      let routed: GithubRoutingRefusal | null = "recipient_unproven";
      try { routed = await turn.routing(GITHUB_RECIPIENT); } catch { /* Unknown exposure is unproven. */ }
      if (routed === "recipient_restricted") return refusal(tool, "policy_denied", routed,
        "This conversation has shown folders the provider policy does not allow github to receive, so nothing was sent to GitHub. Start a new conversation for this GitHub work.");
      if (routed) return refusal(tool, "policy_denied", "recipient_unproven",
        "The provider policy restricts folders for github, and this conversation's exposure to them is unknown here, so nothing was sent to GitHub.");
      try {
        if (tool === GITHUB_TOOL_NAMES.read) {
          const input = GITHUB_ISSUE_READ_INPUT_SCHEMA.parse(call.input);
          const result = await read(token, input, turn.signal);
          await options.untrusted(turn, { tool, detail: `${input.repository}#${input.number}` });
          return { ok: true, tool, result };
        }
        if (tool === GITHUB_TOOL_NAMES.search) {
          const input = GITHUB_ISSUE_SEARCH_INPUT_SCHEMA.parse(call.input);
          const result = await search(token, input, turn.signal);
          await options.untrusted(turn, { tool, detail: input.repository });
          return { ok: true, tool, result };
        }
        return refusal(tool, "invalid_input", null, "Unknown GitHub tool.");
      } catch (error) {
        if (error instanceof GithubRefusal) return refusal(tool, error.code, error.reason, error.message);
        if (error instanceof Error && error.name === "ZodError") return refusal(tool, "invalid_input", null, "The input does not match the tool's schema.");
        options.report?.(`GitHub tool ${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
        return refusal(tool, "upstream_error", null, "The GitHub read failed.");
      }
    },
  };
}
