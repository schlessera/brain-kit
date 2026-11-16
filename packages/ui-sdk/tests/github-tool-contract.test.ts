/**
 * The host GitHub tool contract (#3797): the four fixed names and strict
 * schemas, every payload field the epic and the approved design (§8) list,
 * and the one validator every direct GitHub link passes.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  GITHUB_ISSUE_READ_PAYLOAD_SCHEMA, GITHUB_ISSUE_SEARCH_PAYLOAD_SCHEMA, GITHUB_ISSUE_CREATE_PAYLOAD_SCHEMA, GITHUB_ISSUE_COMMENT_PAYLOAD_SCHEMA,
  GITHUB_PULL_REQUEST_SCHEMA, GITHUB_ISSUE_SCHEMA, GITHUB_READ_TOOL_CONTRACTS, GITHUB_RESULT_SCHEMAS, GITHUB_TOOL_CONTRACTS, GITHUB_TOOL_NAMES,
  githubDirectUrl, githubSearchUrl, isGithubSearchUrl, toolInputJsonSchema, type GithubLinkTarget,
} from "../src/tool-contracts/index.js";
import { handleGithubTool } from "../src/server/index.js";

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; oneOf?: Schema[]; items?: Schema; untrusted?: boolean; enum?: unknown[]; const?: unknown };
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "output" }) as Schema;
const props = (schema: Schema) => schema.properties ?? {};
/** The non-null branch of a nullable property. */
const solid = (schema: Schema) => schema.anyOf?.find(branch => branch.type !== "null") ?? schema;
const nullable = (schema: Schema) => Boolean(schema.anyOf?.some(branch => branch.type === "null"));

describe("names and inputs", () => {
  test("all four tools have fixed names, in order, and the read tools are the first two", () => {
    expect(GITHUB_TOOL_CONTRACTS.map(contract => contract.name), "GITHUB_FOUR_FIXED_NAMES")
      .toEqual(["brain_github_issue_read", "brain_github_issue_search", "brain_github_issue_create", "brain_github_issue_comment"]);
    expect(GITHUB_READ_TOOL_CONTRACTS.map(contract => contract.name)).toEqual([GITHUB_TOOL_NAMES.read, GITHUB_TOOL_NAMES.search]);
    for (const contract of GITHUB_TOOL_CONTRACTS) expect(contract.description.length).toBeGreaterThan(80);
  });

  test("every input schema is strict and names no endpoint, origin or credential", () => {
    const schemas = Object.fromEntries(GITHUB_TOOL_CONTRACTS.map(contract => [contract.name, toolInputJsonSchema(contract)]));
    expect(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, Object.keys(props(schema as Schema)).sort()])), "GITHUB_INPUT_FIELDS").toEqual({
      brain_github_issue_read: ["number", "repository"],
      brain_github_issue_search: ["kind", "limit", "query", "repository", "state"],
      brain_github_issue_create: ["body", "labels", "repository", "title"],
      brain_github_issue_comment: ["body", "number", "repository"],
    });
    for (const schema of Object.values(schemas)) expect((schema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    for (const contract of GITHUB_TOOL_CONTRACTS) {
      expect(contract.input.safeParse({ repository: "odysseus/ithaca", number: 1, title: "t", body: "b", query: "q", token: "x" }).success, `GITHUB_EXTRA_KEY_REFUSED_${contract.name}`).toBe(false);
    }
  });

  test("a repository outside GitHub's grammar, and a query that widens the scope, are refused", () => {
    const read = GITHUB_TOOL_CONTRACTS[0].input, search = GITHUB_TOOL_CONTRACTS[1].input;
    for (const repository of ["odysseus", "odysseus/ithaca/extra", "odys seus/ithaca", "odysseus/..", "odysseus/.", `${"o".repeat(40)}/ithaca`, "../ithaca"])
      expect(read.safeParse({ repository, number: 1 }).success, `GITHUB_REPOSITORY_REFUSED ${repository}`).toBe(false);
    expect(read.safeParse({ repository: "odysseus/ithaca.voyage_2-b", number: 12 }).success).toBe(true);
    for (const query of ["repo:circe/aiaia sails", "suitors org:ithaca", "(user:penelope)", "-repo:a/b loom", "OWNER:circe"])
      expect(search.safeParse({ repository: "odysseus/ithaca", query }).success, `GITHUB_SCOPE_QUALIFIER_REFUSED ${query}`).toBe(false);
    expect(search.parse({ repository: "odysseus/ithaca", query: "label:bug suitors" })).toEqual({ repository: "odysseus/ithaca", query: "label:bug suitors", kind: "any", state: "any", limit: 10 });
  });

  test("a call that does not parse, or a turn with no host handler, refuses without reaching the host", async () => {
    let called = 0;
    const bridge = { github: async () => { called++; return { ok: true } as never; } };
    const bad = JSON.parse((await handleGithubTool("brain_github_issue_read", { repository: "odysseus/ithaca", number: 0 }, bridge)).text);
    expect(bad, "GITHUB_INVALID_INPUT").toMatchObject({ ok: false, tool: "brain_github_issue_read", error: { code: "invalid_input" } });
    const none = await handleGithubTool("brain_github_issue_search", { repository: "odysseus/ithaca", query: "loom" }, {});
    expect(none.isError).toBe(true);
    expect(JSON.parse(none.text), "GITHUB_NO_HOST").toMatchObject({ ok: false, error: { code: "unavailable", reason: "no_host" } });
    expect(called).toBe(0);
  });
});

describe("payloads", () => {
  const issue = props(json(GITHUB_ISSUE_SCHEMA));
  const pull = props(json(GITHUB_PULL_REQUEST_SCHEMA));
  const search = props(json(GITHUB_ISSUE_SEARCH_PAYLOAD_SCHEMA));

  test("an issue carries the epic's fields and the approved §8 fields", () => {
    for (const field of ["number", "state", "author", "labels", "created_at", "updated_at", "closed_at", "body", "comments", "html_url",
      "fetched_at", "state_reason", "locked", "body_length", "body_truncated"])
      expect(issue[field], `GITHUB_ISSUE_FIELD ${field}`).toBeDefined();
    expect(solid(issue.state_reason!).enum).toEqual(["completed", "not_planned", "reopened", "duplicate"]);
    expect(nullable(issue.state_reason!)).toBe(true);
  });

  test("a pull request adds the epic's fields and the approved §8 fields, with no merge method", () => {
    for (const field of ["draft", "merged", "reviews", "review_decisions", "checks", "changes", "commits", "head_ref", "base_ref",
      "merged_by", "merged_at", "merge_commit_sha", "requested_reviewers"])
      expect(pull[field], `GITHUB_PULL_FIELD ${field}`).toBeDefined();
    expect(Object.keys(props(pull.changes!)).sort()).toEqual(["additions", "changed_files", "deletions"]);
    expect(Object.keys(pull).some(key => /merge_method/.test(key)), "GITHUB_NO_MERGE_METHOD").toBe(false);
    expect(solid(props(pull.reviews!).items!.items!).properties!.state!.enum, "GITHUB_REVIEW_STATES_INCLUDE_DISMISSED").toContain("dismissed");
  });

  test("checks are counts or null, and null is distinct from zero", () => {
    const checks = GITHUB_PULL_REQUEST_SCHEMA.shape.checks;
    expect(Object.keys(props(solid(json(checks)))).sort()).toEqual(["failed", "passed", "running", "skipped"]);
    expect(checks.safeParse(null).success, "GITHUB_CHECKS_NULL").toBe(true);
    expect(checks.parse({ passed: 0, failed: 0, running: 0, skipped: 0 }), "GITHUB_CHECKS_ZERO_IS_NOT_NULL").not.toBeNull();
    expect(checks.safeParse({ passed: 1, failed: 0, running: 0 }).success).toBe(false);
  });

  test("every bounded list carries total_count and has_more", () => {
    const lists = { "issue.comments": issue.comments, "issue.labels": issue.labels, "pull.reviews": pull.reviews, "pull.commits": pull.commits,
      "search.item.labels": props(search.items!.items!).labels };
    for (const [name, list] of Object.entries(lists)) expect(Object.keys(props(list!)).sort(), `GITHUB_BOUNDED_${name}`).toEqual(["has_more", "items", "total_count"]);
    for (const field of ["total_count", "incomplete_results", "has_more", "items", "search_url", "fetched_at"])
      expect(search[field], `GITHUB_SEARCH_FIELD ${field}`).toBeDefined();
    for (const field of ["kind", "state", "state_reason", "draft", "merged_at", "comments", "updated_at", "labels", "excerpt", "html_url"])
      expect(props(search.items!.items!)[field], `GITHUB_SEARCH_ITEM_FIELD ${field}`).toBeDefined();
  });

  test("authors carry association, bot flag and a nullable login; every direct-link URL is nullable", () => {
    const authorFields = (schema: Schema) => Object.keys(props(schema)).sort();
    const comment = props(props(issue.comments!).items!.items!), review = props(props(pull.reviews!).items!.items!);
    for (const [name, author] of Object.entries({ issue: issue.author!, comment: comment.author!, review: review.author! })) {
      expect(authorFields(author), `GITHUB_AUTHOR_${name}`).toEqual(["author_association", "is_bot", "login"]);
      expect(nullable(props(author).login!), `GITHUB_NULLABLE_LOGIN_${name}`).toBe(true);
    }
    const commit = props(props(pull.commits!).items!.items!);
    for (const [name, url] of Object.entries({ issue: issue.html_url, comment: comment.html_url, review: review.html_url, commit: commit.html_url,
      search: search.search_url, item: props(search.items!.items!).html_url }))
      expect(nullable(url!), `GITHUB_NULLABLE_URL_${name}`).toBe(true);
    for (const field of ["body", "body_length", "body_truncated"]) {
      expect(comment[field], `GITHUB_COMMENT_${field}`).toBeDefined();
      expect(review[field], `GITHUB_REVIEW_${field}`).toBeDefined();
    }
  });

  test("text GitHub users wrote is marked untrusted; identifiers are not", () => {
    const marked = (schema: Schema) => Boolean(solid(schema).untrusted);
    expect(marked(issue.title!) && marked(issue.body!) && marked(pull.head_ref!) && marked(pull.base_ref!), "GITHUB_UNTRUSTED_TEXT").toBe(true);
    expect(marked(props(props(issue.labels!).items!.items!).name!)).toBe(true);
    expect(marked(props(props(pull.commits!).items!.items!).message!)).toBe(true);
    expect(marked(props(search.items!.items!).excerpt!)).toBe(true);
    expect(marked(props(issue.author!).login!) || marked(issue.state!) || marked(issue.html_url!), "GITHUB_IDENTIFIERS_NOT_MARKED").toBe(false);
  });

  test("results are envelopes, and the write payloads are declared", () => {
    for (const name of Object.values(GITHUB_TOOL_NAMES)) {
      expect(GITHUB_RESULT_SCHEMAS[name].safeParse({ ok: false, tool: name, error: { code: "unavailable", reason: "no_credential", message: "none" } }).success).toBe(true);
    }
    expect(Object.keys(props(json(GITHUB_ISSUE_CREATE_PAYLOAD_SCHEMA))).sort()).toEqual(["created_at", "html_url", "kind", "labels", "number", "repository", "title"]);
    expect(Object.keys(props(json(GITHUB_ISSUE_COMMENT_PAYLOAD_SCHEMA))).sort()).toEqual(["comment_id", "created_at", "html_url", "kind", "number", "repository"]);
    expect(GITHUB_ISSUE_READ_PAYLOAD_SCHEMA.options.map(option => option.shape.kind.value)).toEqual(["issue", "pull_request"]);
  });
});

describe("direct-link validator", () => {
  const scope = { owner: "odysseus", repo: "ithaca", number: 42 };
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const cases: Array<[string, GithubLinkTarget, string]> = [
    ["issue", { kind: "issue" }, "https://github.com/odysseus/ithaca/issues/42"],
    ["pull_request", { kind: "pull_request" }, "https://github.com/odysseus/ithaca/pull/42"],
    ["comment", { kind: "comment", id: 777 }, "https://github.com/odysseus/ithaca/issues/42#issuecomment-777"],
    ["pull comment", { kind: "comment", id: 777 }, "https://github.com/odysseus/ithaca/pull/42#issuecomment-777"],
    ["review", { kind: "review", id: 888 }, "https://github.com/odysseus/ithaca/pull/42#pullrequestreview-888"],
    ["review_comment", { kind: "review_comment", id: 999 }, "https://github.com/odysseus/ithaca/pull/42#discussion_r999"],
    ["commit", { kind: "commit", sha }, `https://github.com/odysseus/ithaca/commit/${sha}`],
    ["pull commit", { kind: "commit", sha }, `https://github.com/odysseus/ithaca/pull/42/commits/${sha}`],
  ];

  /** Each hostile form of `url`, with the reason it must be null. */
  function hostile(url: string, target: GithubLinkTarget): Array<[string, string]> {
    const tail = url.slice("https://github.com/".length);
    const forms: Array<[string, string]> = [
      ["http scheme", url.replace("https:", "http:")],
      ["host suffix", url.replace("github.com", "github.com.evil.example")],
      ["host in path", `https://evil.example/github.com/${tail}`],
      ["subdomain", url.replace("github.com", "gist.github.com")],
      ["trailing dot", url.replace("github.com", "github.com.")],
      ["userinfo", url.replace("https://", "https://penelope@")],
      ["password", url.replace("https://", "https://penelope:loom@")],
      ["port", url.replace("github.com", "github.com:8443")],
      ["default port", url.replace("github.com", "github.com:443")],
      ["javascript", `javascript:alert(1)//${url}`],
      ["other owner", url.replace("/odysseus/", "/circe/")],
      ["other repo", url.replace("/ithaca/", "/aiaia/")],
      ["dot-dot", url.replace("/odysseus/ithaca/", "/odysseus/ithaca/../ithaca/")],
      ["encoded dot-dot", url.replace("/odysseus/ithaca/", "/odysseus/%2e%2e/odysseus/ithaca/")],
      ["encoded slash", url.replace("/odysseus/ithaca/", "/odysseus%2Fithaca/")],
      ["extra query", url.replace(/(#|$)/, "?tab=x$1")],
      ["empty query", url.replace(/(#|$)/, "?$1")],
    ];
    if (target.kind !== "commit") forms.push(["other number", url.replace("/42", "/43")]);
    if (target.kind === "comment" || target.kind === "review" || target.kind === "review_comment") {
      forms.push(["non-numeric id", url.replace(/\d+$/, "abc")], ["mismatched id", url.replace(/\d+$/, "123")],
        ["extra fragment", `${url}x`], ["missing fragment", url.replace(/#.*$/, "")]);
    } else forms.push(["fragment", `${url}#top`], ["empty fragment", `${url}#`]);
    if (target.kind === "commit") forms.push(["short sha", url.replace(sha, sha.slice(0, 7))], ["mismatched sha", url.replace(sha, sha.replace("0123", "fedc"))],
      ["upper-case sha", url.replace(sha, sha.toUpperCase())]);
    return forms;
  }

  for (const [name, target, url] of cases) test(`${name}: a conforming API URL passes, and every hostile form is null`, () => {
    expect(githubDirectUrl(url, scope, target), `GITHUB_URL_PASSES_${name}`).toBe(url);
    expect(githubDirectUrl(url.replace("/odysseus/ithaca/", "/Odysseus/Ithaca/"), scope, target), "GITHUB_NAMES_COMPARE_WITHOUT_CASE").not.toBeNull();
    for (const [reason, form] of hostile(url, target)) expect(githubDirectUrl(form, scope, target), `GITHUB_URL_NULL_${name}_${reason}: ${form}`).toBeNull();
  });

  test("the canonical object must be the kind fetched, and non-strings are null", () => {
    expect(githubDirectUrl("https://github.com/odysseus/ithaca/pull/42", scope, { kind: "issue" })).toBeNull();
    expect(githubDirectUrl("https://github.com/odysseus/ithaca/issues/42", scope, { kind: "pull_request" })).toBeNull();
    expect(githubDirectUrl("https://github.com/odysseus/ithaca/issues/42#pullrequestreview-1", scope, { kind: "review", id: 1 })).toBeNull();
    expect(githubDirectUrl("https://github.com/odysseus/ithaca/issues/42#discussion_r1", scope, { kind: "review_comment", id: 1 })).toBeNull();
    for (const value of [null, undefined, 42, {}, ""]) expect(githubDirectUrl(value, scope, { kind: "issue" })).toBeNull();
  });
});

describe("search URL", () => {
  const hostileText = "suitors & loom # weave / unweave ? https://evil.example\nIthaca — Πηνελόπη 🧵";

  test("search text is only ever the encoded q value of a repo-scoped github.com URL", () => {
    const value = githubSearchUrl({ owner: "odysseus", repo: "ithaca" }, hostileText)!;
    expect(value, "GITHUB_SEARCH_URL_BUILT").not.toBeNull();
    const url = new URL(value);
    expect(url.origin, "GITHUB_SEARCH_ORIGIN").toBe("https://github.com");
    expect(url.pathname, "GITHUB_SEARCH_PATH").toBe("/odysseus/ithaca/issues");
    expect([...url.searchParams.keys()], "GITHUB_SEARCH_ONLY_Q").toEqual(["q"]);
    expect(url.searchParams.get("q"), "GITHUB_SEARCH_Q_ROUND_TRIPS").toBe(hostileText);
    expect(url.hash).toBe("");
    expect(isGithubSearchUrl(value, { owner: "odysseus", repo: "ithaca" }, hostileText)).toBe(true);
  });

  test("a cross-repository search uses /search with type=issues", () => {
    const url = new URL(githubSearchUrl(null, hostileText)!);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/search");
    expect([...url.searchParams.keys()]).toEqual(["q", "type"]);
    expect(url.searchParams.get("type")).toBe("issues");
    expect(url.searchParams.get("q")).toBe(hostileText);
  });

  test("an invalid owner or repository, or empty text, yields null; a tampered URL does not pass", () => {
    for (const scope of [{ owner: "odys/seus", repo: "ithaca" }, { owner: "odysseus", repo: ".." }, { owner: "odysseus", repo: "." }, { owner: "", repo: "ithaca" },
      { owner: "o".repeat(40), repo: "ithaca" }, { owner: "odysseus", repo: "it haca" }, { owner: "evil.example", repo: "ithaca" }])
      expect(githubSearchUrl(scope, "loom"), `GITHUB_SEARCH_NULL ${scope.owner}/${scope.repo}`).toBeNull();
    expect(githubSearchUrl({ owner: "odysseus", repo: "ithaca" }, "")).toBeNull();
    const scope = { owner: "odysseus", repo: "ithaca" };
    const good = githubSearchUrl(scope, "loom")!;
    for (const tampered of [`${good}&type=issues`, `${good}#x`, good.replace("github.com", "github.com.evil.example"), good.replace("/issues", "/pulls"),
      good.replace("https:", "http:"), good.replace("q=loom", "q=weave")])
      expect(isGithubSearchUrl(tampered, scope, "loom"), `GITHUB_SEARCH_TAMPERED ${tampered}`).toBe(false);
  });
});
