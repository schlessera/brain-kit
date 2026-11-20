/**
 * The module GitHub relay (#4259): a module cron job's only route to the
 * GitHub API of its granted repositories. The upstream is a loopback GitHub
 * stand-in; no real token and no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { moduleGitHubTokenSource } from "../src/config/env.js";
import { graphqlQueryRepository, parseModuleGitHubWrites, startModuleGitHubRelay, type ModuleGitHubRelay, type ModuleGitHubWriteRecord } from "../src/github/module-relay.js";

const TOKEN = "odysseus-module-github-token";
let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ method: string; path: string; authorization: string | null; body: string }> = [];
let redirect = false;

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body: await request.text() });
    if (redirect) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    return Response.json({ ok: true, path: url.pathname }, { headers: { link: '<https://api.github.com/repos/ithaca/watchtower/issues?page=2>; rel="next"' } });
  } });
});
afterAll(() => { upstream.stop(true); });
const relays: ModuleGitHubRelay[] = [];
afterEach(async () => { for (const relay of relays.splice(0)) await relay.stop(); seen.length = 0; redirect = false; });

function relay(options: { token?: string | undefined; writes?: string; maxCalls?: number } = {}) {
  const writes: ModuleGitHubWriteRecord[] = [];
  const started = startModuleGitHubRelay({ token: () => "token" in options ? options.token : TOKEN, repositories: ["ithaca/watchtower"],
    writes: parseModuleGitHubWrites(options.writes ?? "").writes, observe: write => { writes.push(write); },
    origin: upstream.url.origin, ...(options.maxCalls ? { maxCalls: options.maxCalls } : {}) });
  relays.push(started);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`http://localhost${path}`, {
    method, unix: started.socketPath, headers: { authorization: "Bearer worker-supplied", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as RequestInit);
  return { call, writes, started };
}

describe("module GitHub relay reads (#4259)", () => {
  test("a granted repository read is forwarded with the host token only, and pagination headers come back", async () => {
    const { call } = relay();
    const response = await call("GET", "/repos/ithaca/watchtower/issues?state=closed");
    expect(response.status).toBe(200);
    expect(response.headers.get("link"), "RELAY_KEEPS_LINK").toContain("page=2");
    expect(seen, "RELAY_FORWARDS_WITH_HOST_TOKEN").toEqual([{ method: "GET", path: "/repos/ithaca/watchtower/issues?state=closed", authorization: `Bearer ${TOKEN}`, body: "" }]);
  });

  test("a repository outside the grant, and any other path, is refused before a request leaves the host", async () => {
    const { call } = relay();
    const foreign = await call("GET", "/repos/sparta/barracks/issues");
    expect(foreign.status, "FOREIGN_REPOSITORY_REFUSED").toBe(403);
    expect((await foreign.json()).brain_relay_refusal).toBe("repository_not_granted");
    expect((await call("GET", "/user")).status, "NON_REPOSITORY_PATH_REFUSED").toBe(403);
    expect((await call("DELETE", "/repos/ithaca/watchtower")).status, "DELETE_REFUSED").toBe(403);
    expect((await call("GET", "/repos/ithaca/watchtower/../../sparta/barracks")).status).not.toBe(200);
    expect(seen, "NOTHING_FORWARDED").toEqual([]);
  });

  test("a repository GraphQL query is forwarded; a mutation, another root, an alias or a second root is refused", async () => {
    const { call } = relay();
    const query = "query Closed($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(last: 5, states: CLOSED) { nodes { number } } } }";
    expect((await call("POST", "/graphql", { query, variables: { owner: "ithaca", name: "watchtower" } })).status, "GRAPHQL_QUERY_FORWARDED").toBe(200);
    expect(seen).toHaveLength(1);
    const refused = [
      { query: 'mutation { closeIssue(input: { issueId: "I_1" }) { clientMutationId } }' },
      { query: "{ viewer { login } }" },
      { query: '{ r: repository(owner: "ithaca", name: "watchtower") { id } }' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { id } viewer { login } }' },
      { query: query, variables: { owner: "sparta", name: "barracks" } },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { id } } mutation { addComment(input: {}) { clientMutationId } }' },
    ];
    for (const body of refused) {
      const response = await call("POST", "/graphql", body);
      expect(response.status, `GRAPHQL_REFUSED: ${body.query}`).toBe(403);
    }
    expect(seen, "REFUSED_GRAPHQL_NOT_FORWARDED").toHaveLength(1);
  });

  test("without BRAIN_UI_MODULE_GITHUB_TOKEN every call is refused, naming the setting", async () => {
    const { call } = relay({ token: undefined });
    const response = await call("GET", "/repos/ithaca/watchtower/issues");
    expect(response.status).toBe(503);
    expect((await response.json()).message, "NO_TOKEN_NAMES_SETTING").toContain("BRAIN_UI_MODULE_GITHUB_TOKEN");
    expect(seen).toEqual([]);
    expect(moduleGitHubTokenSource({ GITHUB_TOKEN: "x", BRAIN_UI_SYNC_GITHUB_TOKEN: "y", BRAIN_UI_GITHUB_TOOLS_TOKEN: "z" })(), "NO_TOKEN_FALLBACK").toBeUndefined();
    expect(moduleGitHubTokenSource({ BRAIN_UI_MODULE_GITHUB_TOKEN: ` ${TOKEN} ` })()).toBe(TOKEN);
  });

  test("a redirect is never followed, and the call budget is enforced", async () => {
    redirect = true;
    const { call } = relay({ maxCalls: 1 });
    expect((await call("GET", "/repos/ithaca/watchtower")).status, "REDIRECT_REFUSED").toBe(502);
    redirect = false;
    const over = await call("GET", "/repos/ithaca/watchtower");
    expect(over.status, "BUDGET_ENFORCED").toBe(429);
    expect(seen).toHaveLength(1);
  });
});

describe("module GitHub relay writes (#4259)", () => {
  const COMMENTS = "/repos/ithaca/watchtower/issues/7/comments";
  test("a write the operator has not enabled is refused before any request, naming the setting", async () => {
    const { call } = relay({ writes: "https://github.com/ithaca/watchtower#issue_state" });
    const response = await call("POST", COMMENTS, { body: "Telemachus asks why this closed." });
    expect(response.status).toBe(403);
    expect((await response.json()).message, "WRITE_NAMES_SETTING").toContain("BRAIN_UI_MODULE_GITHUB_WRITES");
    expect(seen).toEqual([]);
  });

  test("enabled writes are forwarded and recorded; a malformed write body is refused", async () => {
    const { call, writes } = relay({ writes: "https://github.com/ithaca/watchtower#issue_comment https://github.com/Ithaca/Watchtower#issue_state" });
    expect((await call("POST", COMMENTS, { body: "Telemachus asks why this closed." })).status, "COMMENT_FORWARDED").toBe(200);
    expect((await call("PATCH", "/repos/ithaca/watchtower/issues/7", { state: "open" })).status, "STATE_FORWARDED").toBe(200);
    expect((await call("PATCH", "/repos/ithaca/watchtower/issues/7", { state: "open", title: "Renamed" })).status, "STATE_EXTRA_FIELD_REFUSED").toBe(400);
    expect((await call("POST", COMMENTS, { body: "x", extra: true })).status, "COMMENT_EXTRA_FIELD_REFUSED").toBe(400);
    expect(seen.map(entry => `${entry.method} ${entry.path}`)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/ithaca/watchtower/issues/7"]);
    expect(writes, "WRITES_RECORDED").toEqual([
      { repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 200 },
      { repository: "ithaca/watchtower", operation: "issue_state", number: 7, status: 200 },
    ]);
  });

  test("the operator list parses only GitHub repositories and known operations", () => {
    const parsed = parseModuleGitHubWrites("https://github.com/ithaca/watchtower#issue_comment, https://gitlab.com/ithaca/x#issue_comment https://github.com/ithaca/watchtower#merge");
    expect([...parsed.writes.get("ithaca/watchtower") ?? []]).toEqual(["issue_comment"]);
    expect(parsed.invalid).toEqual(["https://gitlab.com/ithaca/x#issue_comment", "https://github.com/ithaca/watchtower#merge"]);
  });
});

test("graphqlQueryRepository reads literal and variable arguments and ignores strings and comments", () => {
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower") { id } }', {})).toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('# mutation { x }\nquery { repository(name: $n, owner: $o) { description } }', { o: "ithaca", n: "watchtower" })).toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower") { ...Fields } } fragment Fields on Repository { id }', {})).toBeNull();
  expect(graphqlQueryRepository("subscription { repository(owner: \"ithaca\", name: \"watchtower\") { id } }", {})).toBeNull();
});
