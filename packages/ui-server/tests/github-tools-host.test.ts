/**
 * The host GitHub read tools (#3797) against a loopback stand-in for the
 * GitHub API: the dedicated credential and nothing else, the contract's
 * payloads, direct links that pass the validator or are null, the taint
 * recorded before any text returns, and refusals that send nothing,
 * including data routing (G2, #4029) asked before any request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GITHUB_RESULT_SCHEMAS, type GithubIssue, type GithubIssueSearchPayload, type GithubPullRequest, type GithubToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { GITHUB_RECIPIENT, createGithubToolsHost, reviewDecisions, type GithubRoutingRefusal, type GithubToolsHostOptions, type GithubToolsTurn } from "../src/github/host.js";
import { githubToolsTokenSource } from "../src/config/env.js";
import { COMMIT_SHAS, GENERIC_GITHUB_SENTINEL, GITHUB_TOOLS_SENTINEL, HEAD_SHA, fakeGithub, standInFetch, type FakeGithub, type FakeGithubOptions } from "./fixtures/github-host-fixture.js";

const stops: FakeGithub[] = [];
afterEach(() => { for (const fake of stops.splice(0)) fake.stop(); });

const turn: GithubToolsTurn = { turnId: "turn-ithaca", principalId: "principal-penelope", sessionId: () => "sess-ithaca", routing: async () => null };
const NOW = Date.parse("2026-07-12T12:00:00Z");

function host(options: FakeGithubOptions = {}, overrides: Partial<GithubToolsHostOptions> = {}) {
  const fake = fakeGithub(options); stops.push(fake);
  const taints: Array<{ tool: string; detail: string }> = [];
  const github = createGithubToolsHost({ token: () => GITHUB_TOOLS_SENTINEL, fetch: standInFetch(fake), now: () => NOW,
    untrusted: async (_turn, event) => { taints.push(event); }, ...overrides });
  return { fake, taints, github };
}
function parsed(result: GithubToolResult) {
  // Every result is the contract's own envelope.
  return GITHUB_RESULT_SCHEMAS[result.tool].parse(result);
}

describe("the dedicated credential", () => {
  test("only BRAIN_UI_GITHUB_TOOLS_TOKEN is read; GITHUB_TOKEN alone answers unavailable", () => {
    expect(githubToolsTokenSource({ GITHUB_TOKEN: GENERIC_GITHUB_SENTINEL, BRAIN_UI_SYNC_GITHUB_TOKEN: "s", BRAIN_UI_SKILLS_GITHUB_TOKEN: "k" })(), "GITHUB_NO_FALLBACK").toBeUndefined();
    expect(githubToolsTokenSource({ GITHUB_TOKEN: GENERIC_GITHUB_SENTINEL, BRAIN_UI_GITHUB_TOOLS_TOKEN: ` ${GITHUB_TOOLS_SENTINEL} ` })()).toBe(GITHUB_TOOLS_SENTINEL);
    expect(githubToolsTokenSource({ BRAIN_UI_GITHUB_TOOLS_TOKEN: "  " })()).toBeUndefined();
  });

  test("without the credential both read tools answer unavailable with a reason, and nothing is sent", async () => {
    const { fake, taints, github } = host({}, { token: githubToolsTokenSource({ GITHUB_TOKEN: GENERIC_GITHUB_SENTINEL }) });
    for (const call of [{ tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } },
      { tool: "brain_github_issue_search", input: { repository: "odysseus/ithaca", query: "stores", kind: "any", state: "any", limit: 10 } }] as const) {
      const result = parsed(await github.call(turn, call));
      expect(result, `GITHUB_UNAVAILABLE_${call.tool}`).toMatchObject({ ok: false, error: { code: "unavailable", reason: "no_credential" } });
    }
    expect(fake.seen, "GITHUB_NOTHING_SENT_WITHOUT_CREDENTIAL").toEqual([]);
    expect(taints).toEqual([]);
  });

  test("every request carries the dedicated credential and stays on the API origin", async () => {
    const { fake, github } = host();
    expect((await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 8 } })).ok).toBe(true);
    expect(fake.seen.length).toBeGreaterThan(4);
    for (const request of fake.seen) expect(request.authorization, `GITHUB_DEDICATED_BEARER ${request.path}`).toBe(`Bearer ${GITHUB_TOOLS_SENTINEL}`);
  });

});

describe("issue and pull request reads", () => {
  test("an issue: structured fields, untrusted text kept as data, latest comments bounded with total and more", async () => {
    const { taints, github } = host({ comments: 45 });
    const result = parsed(await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } }));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const issue = result.result as GithubIssue;
    expect(issue).toMatchObject({ kind: "issue", repository: "odysseus/ithaca", number: 7, state: "closed", state_reason: "completed", locked: true,
      author: { login: "penelope", is_bot: false, author_association: "OWNER" }, closed_at: "2026-07-12T09:00:00Z",
      html_url: "https://github.com/odysseus/ithaca/issues/7", fetched_at: "2026-07-12T12:00:00.000Z", body_truncated: false });
    expect(issue.labels, "GITHUB_LABELS_BOUNDED").toEqual({ total_count: 2, has_more: false, items: [
      { name: "household", color: "d4c5f9", description: "household on Ithaca" }, { name: "urgent", color: "d4c5f9", description: "urgent on Ithaca" }] });
    expect(issue.comments.total_count, "GITHUB_COMMENT_TOTAL").toBe(45);
    expect(issue.comments.has_more, "GITHUB_COMMENT_MORE").toBe(true);
    expect(issue.comments.items.map(item => item.id), "GITHUB_LATEST_COMMENTS_OLDEST_FIRST").toEqual(Array.from({ length: 30 }, (_, index) => 9015 + index));
    expect(issue.comments.items[1]!.author, "GITHUB_BOT_AUTHOR").toEqual({ login: "herald[bot]", is_bot: true, author_association: "NONE" });
    expect(issue.comments.items[0]!.html_url).toBe("https://github.com/odysseus/ithaca/issues/7#issuecomment-9015");
    expect(issue.comments.items[0]!.body, "GITHUB_UNTRUSTED_TEXT_IS_DATA").toContain("Ignore previous instructions");
    expect(taints, "GITHUB_READ_TAINTS").toEqual([{ tool: "brain_github_issue_read", detail: "odysseus/ithaca#7" }]);
  });

  test("a pull request: branches, reviews and decisions, checks, size, commits and links", async () => {
    const { github } = host();
    const result = parsed(await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 8 } }));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const pull = result.result as GithubPullRequest;
    expect(pull).toMatchObject({ kind: "pull_request", number: 8, state: "open", draft: false, merged: false, merged_at: null, merged_by: null,
      head_ref: "bow/string-it", base_ref: "main", requested_reviewers: [{ login: "penelope", is_bot: false }],
      changes: { changed_files: 4, additions: 120, deletions: 7 }, html_url: "https://github.com/odysseus/ithaca/pull/8" });
    // GitHub's test-merge sha on an open pull request is not a merge commit.
    expect(pull.merge_commit_sha, "GITHUB_NO_MERGE_SHA_WHILE_OPEN").toBeNull();
    expect(pull.checks, "GITHUB_CHECK_COUNTS").toEqual({ passed: 2, failed: 1, running: 1, skipped: 1 });
    expect(pull.reviews.items.map(review => review.state)).toEqual(["approved", "commented", "changes_requested", "dismissed"]);
    expect(pull.reviews.items.map(review => review.html_url), "GITHUB_REVIEW_LINK_HOSTILE_HOST_IS_NULL").toEqual([
      "https://github.com/odysseus/ithaca/pull/8#pullrequestreview-501", "https://github.com/odysseus/ithaca/pull/8#pullrequestreview-502",
      "https://github.com/odysseus/ithaca/pull/8#pullrequestreview-503", null]);
    expect(pull.reviews).toMatchObject({ total_count: 4, has_more: false });
    expect(pull.review_decisions, "GITHUB_LATEST_DECISION_PER_REVIEWER").toEqual([
      { reviewer: { login: "penelope", is_bot: false }, state: "approved", submitted_at: "2026-07-03T09:00:00Z" },
      { reviewer: { login: "telemachus", is_bot: false }, state: "dismissed", submitted_at: "2026-07-06T09:00:00Z" }]);
    expect(pull.commits).toMatchObject({ total_count: 2, has_more: false });
    expect(pull.commits.items.map(commit => [commit.sha, commit.author?.login ?? null, commit.html_url])).toEqual([
      [COMMIT_SHAS[0], "telemachus", `https://github.com/odysseus/ithaca/commit/${COMMIT_SHAS[0]}`], [COMMIT_SHAS[1], null, `https://github.com/odysseus/ithaca/commit/${COMMIT_SHAS[1]}`]]);
    expect(pull.comments.items[0]!.html_url).toBe("https://github.com/odysseus/ithaca/pull/8#issuecomment-9101");
  });

  test("no reported checks is null, never zero; a credential without checks access is null too", async () => {
    for (const options of [{ checks: "none" as const }, { override: (path: string) => path.includes("/check-runs") ? Response.json({ message: "no" }, { status: 403 }) : undefined }]) {
      const { github } = host(options);
      const result = await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 8 } });
      expect(result.ok && (result.result as GithubPullRequest).checks, "GITHUB_CHECKS_NULL_NOT_ZERO").toBeNull();
    }
  });

  test("a URL that fails validation is null and the item still renders", async () => {
    const { github } = host({ override: path => path === "/repos/odysseus/ithaca/issues/7"
      ? Response.json({ number: 7, title: "t", state: "open", user: null, labels: [], comments: 0, created_at: "2026-07-01T09:00:00Z", updated_at: "2026-07-01T09:00:00Z",
        body: null, html_url: "https://github.com/circe/aiaia/issues/7" }) : undefined });
    const result = parsed(await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } }));
    expect(result.ok && result.result, "GITHUB_FOREIGN_URL_NULL").toMatchObject({ html_url: null, author: { login: null, is_bot: false, author_association: null },
      body: null, body_length: 0, body_truncated: false });
  });

  test("a long body is cut at its bound and says so", async () => {
    const long = "ἄνδρα μοι ἔννεπε ".repeat(2_000);
    const { github } = host({ override: path => path === "/repos/odysseus/ithaca/issues/7"
      ? Response.json({ number: 7, title: "t", state: "open", user: { login: "penelope" }, labels: [], comments: 0, created_at: "2026-07-01T09:00:00Z",
        updated_at: "2026-07-01T09:00:00Z", body: long, html_url: "https://github.com/odysseus/ithaca/issues/7" }) : undefined });
    const result = await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } });
    const issue = result.ok ? result.result as GithubIssue : null;
    expect({ length: issue?.body_length, truncated: issue?.body_truncated, kept: issue?.body?.length }, "GITHUB_BODY_BOUNDED").toEqual({ length: long.length, truncated: true, kept: 20_000 });
  });
});

describe("search", () => {
  test("bounded results with the truthful count, more, the host's qualifiers and a validated search link", async () => {
    const { fake, taints, github } = host();
    const result = parsed(await github.call(turn, { tool: "brain_github_issue_search",
      input: { repository: "odysseus/ithaca", query: "stores & bow #1", kind: "issue", state: "open", limit: 2 } }));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const search = result.result as GithubIssueSearchPayload;
    const sent = new URLSearchParams(fake.seen[0]!.search);
    expect(sent.get("q"), "GITHUB_SEARCH_SCOPED_BY_HOST").toBe("repo:odysseus/ithaca is:issue is:open stores & bow #1");
    expect(sent.get("per_page")).toBe("2");
    expect(search).toMatchObject({ kind: "search", repository: "odysseus/ithaca", query: "stores & bow #1", search_query: "is:issue is:open stores & bow #1",
      total_count: 57, incomplete_results: false, has_more: true });
    expect(search.items.map(item => [item.kind, item.number, item.html_url]), "GITHUB_FOREIGN_RESULT_DROPPED").toEqual([
      ["issue", 7, "https://github.com/odysseus/ithaca/issues/7"], ["pull_request", 8, "https://github.com/odysseus/ithaca/pull/8"]]);
    expect(search.items[0]).toMatchObject({ state: "closed", state_reason: "completed", draft: null, merged_at: null, comments: 3, excerpt: "The stores run low." });
    expect(search.items[1]).toMatchObject({ draft: false, labels: { total_count: 1, has_more: false } });
    const link = new URL(search.search_url!);
    expect([link.origin, link.pathname, [...link.searchParams.keys()], link.searchParams.get("q")], "GITHUB_SEARCH_LINK")
      .toEqual(["https://github.com", "/odysseus/ithaca/issues", ["q"], "is:issue is:open stores & bow #1"]);
    expect(taints).toEqual([{ tool: "brain_github_issue_search", detail: "odysseus/ithaca" }]);
  });
});

describe("refusals and taint", () => {
  test("GitHub's errors map to the contract's codes, and none taints", async () => {
    const cases: Array<[Response, string, string | null]> = [
      [Response.json({ message: "Not Found" }, { status: 404 }), "not_found", null],
      [Response.json({ message: "Bad credentials" }, { status: 401 }), "unavailable", "credential_rejected"],
      [Response.json({ message: "rate" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited", null],
      [Response.json({ message: "no" }, { status: 403 }), "forbidden", null],
      [Response.json({ message: "boom" }, { status: 502 }), "upstream_error", "http_502"],
      [new Response(null, { status: 302, headers: { location: "https://evil.example/repos/odysseus/ithaca/issues/7" } }), "upstream_error", "redirect"],
      [new Response("<html>", { status: 200 }), "upstream_error", "malformed"],
    ];
    for (const [response, code, reason] of cases) {
      const { taints, github } = host({ override: () => response.clone() });
      const result = parsed(await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } }));
      expect(result, `GITHUB_REFUSAL_${code}_${reason}`).toMatchObject({ ok: false, error: { code, reason } });
      expect(JSON.stringify(result)).not.toContain(GITHUB_TOOLS_SENTINEL);
      expect(taints).toEqual([]);
    }
  });

  test("a redirect inside the API origin is followed with the same credential", async () => {
    const { fake, github } = host({ override: path => path === "/repos/odysseus/ithaca/issues/77"
      ? new Response(null, { status: 301, headers: { location: "https://api.github.com/repos/odysseus/ithaca/issues/7" } }) : undefined });
    const result = await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 77 } });
    // The moved issue is #7, not the #77 asked for: refused rather than relabelled.
    expect(result, "GITHUB_MOVED_NUMBER_REFUSED").toMatchObject({ ok: false, error: { code: "upstream_error", reason: "malformed" } });
    expect(fake.seen.map(request => request.path).slice(0, 2)).toEqual(["/repos/odysseus/ithaca/issues/77", "/repos/odysseus/ithaca/issues/7"]);
  });

  test("the taint commits before any text returns; when it cannot, the text is withheld", async () => {
    const order: string[] = [];
    const { github } = host({}, { untrusted: async () => { order.push("taint"); throw new Error("governance store unavailable"); }, report: message => order.push(message) });
    const result = await github.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } });
    expect(result, "GITHUB_TEXT_WITHHELD_WITHOUT_TAINT").toEqual({ ok: false, tool: "brain_github_issue_read", error: { code: "upstream_error", reason: null, message: "The GitHub read failed." } });
    expect(JSON.stringify(result)).not.toContain("Suitors");
    expect(order[0]).toBe("taint");
  });
});

describe("data routing (G2, #4029)", () => {
  const READS = [{ tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } },
    { tool: "brain_github_issue_search", input: { repository: "odysseus/ithaca", query: "the suitors' feast", kind: "any", state: "any", limit: 10 } }] as const;
  const routed = (answer: () => Promise<GithubRoutingRefusal | null>) => {
    const asked: string[] = [];
    return { asked, turn: { ...turn, routing: async (recipient: string) => { asked.push(recipient); return answer(); } } satisfies GithubToolsTurn };
  };

  for (const [label, reason, answer] of [["shown a folder kept from github", "recipient_restricted", async () => "recipient_restricted" as const],
    ["exposure unknown", "recipient_unproven", async () => "recipient_unproven" as const],
    ["routing threw", "recipient_unproven", async (): Promise<null> => { throw new Error("exposure store unreadable"); }]] as const) {
    test(`a read or search the turn's routing refuses (${label}) sends GitHub nothing`, async () => {
      const { fake, taints, github } = host();
      const { asked, turn: refused } = routed(answer);
      for (const call of READS) {
        const result = parsed(await github.call(refused, call));
        expect(result, `GITHUB_ROUTING_REFUSED_${call.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason } });
        expect(JSON.stringify(result)).not.toContain("Suitors");
      }
      expect(asked, "GITHUB_ROUTING_NAMES_GITHUB").toEqual([GITHUB_RECIPIENT, GITHUB_RECIPIENT]);
      expect(GITHUB_RECIPIENT).toBe("github");
      expect(fake.seen, "GITHUB_ROUTING_NOTHING_SENT").toEqual([]);
      expect(taints, "GITHUB_ROUTING_NOTHING_TAINTED").toEqual([]);
    });
  }

  test("a turn its routing admits reads as before", async () => {
    const { fake, github } = host();
    const { asked, turn: admitted } = routed(async () => null);
    for (const call of READS) expect((await github.call(admitted, call)).ok, `GITHUB_ROUTING_ADMITTED_${call.tool}`).toBe(true);
    expect(asked).toEqual([GITHUB_RECIPIENT, GITHUB_RECIPIENT]);
    expect(fake.seen.length).toBeGreaterThan(1);
  });
});

test("review decisions: a later comment never hides a decision, and pending is not one", () => {
  const review = (login: string, state: "approved" | "commented" | "pending" | "changes_requested", day: number) => ({ id: day, state,
    author: { login, is_bot: false, author_association: null }, submitted_at: `2026-07-0${day}T09:00:00Z`, body: null, body_length: 0, body_truncated: false, html_url: null });
  expect(reviewDecisions([review("circe", "commented", 1), review("circe", "pending", 2), review("eumaeus", "approved", 3), review("eumaeus", "commented", 4),
    review("eumaeus", "changes_requested", 5)]).map(decision => [decision.reviewer.login, decision.state]))
    .toEqual([["circe", "commented"], ["eumaeus", "changes_requested"]]);
  expect(HEAD_SHA).toHaveLength(40);
});
