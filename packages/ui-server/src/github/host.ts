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
 * The write tools are declared in the contract and answer `unavailable` here
 * until #3798 registers them with their approval cards.
 */
import {
  GITHUB_API_ORIGIN, GITHUB_ISSUE_READ_INPUT_SCHEMA, GITHUB_ISSUE_SEARCH_INPUT_SCHEMA, GITHUB_LIMITS, GITHUB_TOOL_NAMES,
  GITHUB_AUTHOR_ASSOCIATIONS, githubDirectUrl, githubSearchUrl, parseGithubRepository,
  type GithubAuthor, type GithubChecks, type GithubComment, type GithubCommit, type GithubErrorCode, type GithubIssue,
  type GithubIssueReadInput, type GithubIssueSearchInput, type GithubIssueSearchPayload, type GithubLabel, type GithubLinkScope,
  type GithubPullRequest, type GithubReadToolName, type GithubReview, type GithubReviewDecision, type GithubSearchItem,
  type GithubToolCall, type GithubToolName, type GithubToolResult, type GithubUser,
} from "@schlessera/brain-ui-sdk/tool-contracts";

/** The turn a call belongs to, bound by the host, never by the call. */
export interface GithubToolsTurn {
  readonly turnId: string;
  readonly principalId: string;
  readonly sessionId: () => string | null;
  readonly signal?: AbortSignal;
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

class GithubRefusal extends Error {
  constructor(readonly code: GithubErrorCode, readonly reason: string | null, message: string) { super(message); }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value: unknown): boolean => value === true;
const LOGIN = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
const SHA = /^[0-9a-f]{40}$/;
const COLOR = /^[0-9a-fA-F]{6}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const time = (value: unknown): string | null => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
const requiredTime = (value: unknown, fallback: string): string => time(value) ?? fallback;

/** Cut at `max` characters without splitting a surrogate pair. */
function cut(value: string, max: number): { text: string; truncated: boolean } {
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
function author(value: unknown, association: unknown): GithubAuthor {
  return { ...user(value), author_association: (GITHUB_AUTHOR_ASSOCIATIONS as readonly unknown[]).includes(association) ? association as GithubAuthor["author_association"] : null };
}
function body(value: unknown, max: number) {
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

function comment(value: Json, scope: GithubLinkScope, fallback: string): GithubComment | null {
  const id = integer(value.id);
  if (!id) return null;
  return { id, author: author(value.user, value.author_association), created_at: requiredTime(value.created_at, fallback),
    updated_at: requiredTime(value.updated_at, requiredTime(value.created_at, fallback)), ...body(value.body, GITHUB_LIMITS.commentBodyChars),
    html_url: githubDirectUrl(value.html_url, scope, { kind: "comment", id }) };
}

const REVIEW_STATES: Record<string, GithubReview["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };
function review(value: Json, scope: GithubLinkScope): GithubReview | null {
  const id = integer(value.id), reviewState = REVIEW_STATES[String(value.state)];
  if (!id || !reviewState) return null;
  return { id, author: author(value.user, value.author_association), state: reviewState, submitted_at: time(value.submitted_at),
    ...body(value.body, GITHUB_LIMITS.commentBodyChars), html_url: githubDirectUrl(value.html_url, scope, { kind: "review", id }) };
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

function commit(value: Json, scope: GithubLinkScope): GithubCommit | null {
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
function nextLink(response: Response): string | null {
  const header = response.headers.get("link");
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}

export function createGithubToolsHost(options: GithubToolsHostOptions): GithubToolsHost {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;

  /** One GET against the fixed API origin. Redirects are followed only within it. */
  async function get(token: string, path: string, signal: AbortSignal | undefined): Promise<{ json: unknown; response: Response }> {
    let url = new URL(path, GITHUB_API_ORIGIN);
    for (let hop = 0; hop < 4; hop++) {
      if (url.origin !== GITHUB_API_ORIGIN) throw new GithubRefusal("upstream_error", "redirect", "GitHub redirected outside its API.");
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(url, { method: "GET", redirect: "manual",
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
        if (limited) throw new GithubRefusal("rate_limited", null, "GitHub's rate limit for the host credential is spent; try again later.");
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

  return {
    async call(turn, call) {
      const { tool } = call;
      if (tool === GITHUB_TOOL_NAMES.create || tool === GITHUB_TOOL_NAMES.comment)
        return refusal(tool, "unavailable", "not_registered", "GitHub writes are not available on this host yet.");
      const token = options.token();
      if (!token) return refusal(tool, "unavailable", "no_credential", "This host has no GitHub credential for its GitHub tools (BRAIN_UI_GITHUB_TOOLS_TOKEN). GITHUB_TOKEN is never used for them.");
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
