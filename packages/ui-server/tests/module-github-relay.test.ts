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
let large = 0;
let hold: Promise<void> | null = null;

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body: await request.text() });
    if (hold) await hold;
    if (redirect) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    if (large) {
      // A chunked body with no length: only reading it shows its size.
      let sent = 0;
      return new Response(new ReadableStream({ pull(controller) { if (sent >= large) return controller.close(); sent += 1024; controller.enqueue(new Uint8Array(1024)); } }), { status: 201 });
    }
    return Response.json({ ok: true, path: url.pathname }, { headers: { link: '<https://api.github.com/repos/ithaca/watchtower/issues?page=2>; rel="next"' } });
  } });
});
afterAll(() => { upstream.stop(true); });
const relays: ModuleGitHubRelay[] = [];
afterEach(async () => { for (const relay of relays.splice(0)) await relay.stop(); seen.length = 0; redirect = false; large = 0; hold = null; });

function relay(options: { token?: string | undefined; writes?: string; maxCalls?: number; maxResponseBytes?: number; maxConcurrent?: number } = {}) {
  const writes: ModuleGitHubWriteRecord[] = [];
  const started = startModuleGitHubRelay({ token: () => "token" in options ? options.token : TOKEN, repositories: ["ithaca/watchtower"],
    writes: parseModuleGitHubWrites(options.writes ?? "").writes, observe: write => { writes.push(write); },
    origin: upstream.url.origin, ...(options.maxCalls ? { maxCalls: options.maxCalls } : {}), ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}), ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}) });
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
    const refusal = await foreign.json();
    expect(refusal.brain_relay_refusal).toBe("repository_not_granted");
    expect(refusal.message, "NOT_GRANTED_NAMES_SETTING").toContain("BRAIN_UI_MODULE_REPOSITORIES");
    const doubled = await call("GET", "/repos//sparta/barracks");
    expect(doubled.status, "DOUBLE_SLASH_REFUSED").toBe(400);
    expect((await doubled.json()).message, "INVALID_PATH_NAMES_SETTING").toContain("BRAIN_UI_MODULE_REPOSITORIES");
    expect((await call("GET", "/user")).status, "NON_REPOSITORY_PATH_REFUSED").toBe(403);
    const malformed = await call("GET", "/repos/ithaca/%E0/issues");
    expect(malformed.status, "MALFORMED_ESCAPE_REFUSED").toBe(400);
    expect((await malformed.json()).message, "MALFORMED_ESCAPE_NAMES_SETTING").toContain("BRAIN_UI_MODULE_REPOSITORIES");
    const removal = await call("DELETE", "/repos/ithaca/watchtower");
    expect(removal.status, "DELETE_REFUSED").toBe(403);
    expect((await removal.json()).message, "NOT_RELAYED_NAMES_SETTINGS").toMatch(/BRAIN_UI_MODULE_REPOSITORIES.*BRAIN_UI_MODULE_GITHUB_WRITES/);
    expect((await call("GET", "/repos/ithaca/watchtower/../../sparta/barracks")).status).not.toBe(200);
    expect(seen, "NOTHING_FORWARDED").toEqual([]);
  });

  test("a repository GraphQL query is forwarded; a mutation, another root, an alias or a second root is refused", async () => {
    const { call } = relay();
    const query = "query Closed($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(last: 5, states: CLOSED) { nodes { number } } } }";
    expect((await call("POST", "/graphql", { query, variables: { owner: "ithaca", name: "watchtower" } })).status, "GRAPHQL_QUERY_FORWARDED").toBe(200);
    expect(seen).toHaveLength(1);
    const refused: Array<{ query: string; variables?: unknown; operationName?: string }> = [
      { query: 'mutation { closeIssue(input: { issueId: "I_1" }) { clientMutationId } }' },
      { query: "{ viewer { login } }" },
      { query: '{ r: repository(owner: "ithaca", name: "watchtower") { id } }' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { id } viewer { login } }' },
      { query: query, variables: { owner: "sparta", name: "barracks" } },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { id } } mutation { addComment(input: {}) { clientMutationId } }' },
    ];
    // Nested traversal to another repository or owner (third review of #4265).
    refused.push(
      { query: '{ repository(owner: "ithaca", name: "watchtower") { owner { repository(name: "barracks") { issues(first: 5) { nodes { title } } } } } }' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { owner { repositories(first: 5) { nodes { name } } } } }' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { forks(first: 5) { nodes { name } } parent { name } } }' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { issue(number: 7) { repository { name } } } }' },
    );
    // Strings and comments this reader and GitHub's parser could end in different places (review of #4265).
    refused.push(
      { query: 'query Q { repository(owner: "ithaca", name: "watchtower") { id } } # x\r mutation M { closeIssue(input: { issueId: "I_1" }) { clientMutationId } }', operationName: "M" } as never,
      { query: '{ repository(owner: "ithaca", name: "watchtower") { label(name: """a \\""" b""") { id } } } """ repository(owner: "sparta", name: "barracks") { id } """' },
      { query: '{ repository(owner: "ithaca", name: "watchtower") { label(name: "a\\"b") { id } } }' },
    );
    for (const body of refused) {
      const response = await call("POST", "/graphql", body);
      expect(response.status, `GRAPHQL_REFUSED: ${body.query}`).toBe(403);
      expect((await response.json()).message, "GRAPHQL_REFUSAL_NAMES_SETTING").toContain("BRAIN_UI_MODULE_REPOSITORIES");
    }
    // operationName must name the one query.
    expect((await call("POST", "/graphql", { query, operationName: "Other", variables: { owner: "ithaca", name: "watchtower" } })).status, "OPERATION_NAME_MISMATCH_REFUSED").toBe(403);
    expect((await call("POST", "/graphql", { query, operationName: "Closed", variables: { owner: "ithaca", name: "watchtower" } })).status, "OPERATION_NAME_MATCH_FORWARDED").toBe(200);
    expect(seen, "REFUSED_GRAPHQL_NOT_FORWARDED").toHaveLength(2);
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

  test("calls beyond the in-flight bound are refused before they are read", async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const { call } = relay({ maxConcurrent: 2 });
    const first = call("GET", "/repos/ithaca/watchtower/issues"), second = call("GET", "/repos/ithaca/watchtower/pulls");
    while (seen.length < 2) await Bun.sleep(5);
    const third = await call("GET", "/repos/ithaca/watchtower/labels");
    expect(third.status, "IN_FLIGHT_BOUND").toBe(503);
    expect((await third.json()).brain_relay_refusal).toBe("relay_busy");
    release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect((await call("GET", "/repos/ithaca/watchtower/labels")).status, "BOUND_FREES_AFTER_FINISH").toBe(200);
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
    const extra = await call("PATCH", "/repos/ithaca/watchtower/issues/7", { state: "open", title: "Renamed" });
    expect(extra.status, "STATE_EXTRA_FIELD_REFUSED").toBe(400);
    expect((await extra.json()).message, "EXTRA_FIELD_NAMES_SETTING").toContain("BRAIN_UI_MODULE_GITHUB_WRITES");
    expect((await call("POST", COMMENTS, { body: "x", extra: true })).status, "COMMENT_EXTRA_FIELD_REFUSED").toBe(400);
    expect(seen.map(entry => `${entry.method} ${entry.path}`)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/ithaca/watchtower/issues/7"]);
    expect(writes, "WRITES_RECORDED").toEqual([
      { repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 200 },
      { repository: "ithaca/watchtower", operation: "issue_state", number: 7, status: 200 },
    ]);
  });

  test("an oversized response is refused while it is read, and a write GitHub answered is still recorded", async () => {
    const { call, writes } = relay({ writes: "https://github.com/ithaca/watchtower#issue_comment", maxResponseBytes: 8 * 1024 });
    large = 64 * 1024;
    const response = await call("POST", COMMENTS, { body: "Telemachus asks why this closed." });
    expect(response.status, "OVERSIZED_RESPONSE_REFUSED").toBe(502);
    expect((await response.json()).brain_relay_refusal).toBe("response_too_large");
    expect(writes, "ANSWERED_WRITE_RECORDED").toEqual([{ repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 201 }]);
  });

  test("a chunked request body past the bound is refused", async () => {
    const { started } = relay({ writes: "https://github.com/ithaca/watchtower#issue_comment" });
    const big = new ReadableStream({ start(controller) { for (let i = 0; i < 1100; i++) controller.enqueue(new Uint8Array(1024).fill(32)); controller.close(); } });
    const response = await fetch(`http://localhost${COMMENTS}`, { method: "POST", unix: started.socketPath, body: big } as RequestInit);
    expect(response.status, "CHUNKED_REQUEST_BOUNDED").toBe(413);
    expect(seen).toEqual([]);
  });

  test("a write whose upstream answer is lost is still recorded, with an unknown status", async () => {
    const writes: ModuleGitHubWriteRecord[] = [];
    const lost = startModuleGitHubRelay({ token: () => TOKEN, repositories: ["ithaca/watchtower"],
      writes: parseModuleGitHubWrites("https://github.com/ithaca/watchtower#issue_comment").writes, observe: write => { writes.push(write); },
      fetch: (async () => { throw new Error("connection reset after the request was sent"); }) as unknown as typeof fetch });
    relays.push(lost);
    const response = await fetch(`http://localhost${COMMENTS}`, { method: "POST", unix: lost.socketPath, body: JSON.stringify({ body: "Why closed?" }) } as RequestInit);
    expect(response.status).toBe(502);
    expect(writes, "LOST_WRITE_RECORDED").toEqual([{ repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 0 }]);
  });

  test("stopping lets a write in flight finish and be recorded, and takes no new call", async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const { call, writes, started } = relay({ writes: "https://github.com/ithaca/watchtower#issue_comment" });
    const pending = call("POST", COMMENTS, { body: "Telemachus asks why this closed." });
    while (seen.length < 1) await Bun.sleep(5);
    const stopping = started.stop();
    await Bun.sleep(20);
    release();
    await stopping;
    expect((await pending).status, "IN_FLIGHT_WRITE_FINISHES").toBe(200);
    expect(writes, "IN_FLIGHT_WRITE_RECORDED").toEqual([{ repository: "ithaca/watchtower", operation: "issue_comment", number: 7, status: 200 }]);
  });

  test("the operator list parses only GitHub repositories and known operations", () => {
    const parsed = parseModuleGitHubWrites("https://github.com/ithaca/watchtower#issue_comment, https://gitlab.com/ithaca/x#issue_comment https://github.com/ithaca/watchtower#merge");
    expect([...parsed.writes.get("ithaca/watchtower") ?? []]).toEqual(["issue_comment"]);
    expect(parsed.invalid).toEqual(["https://gitlab.com/ithaca/x#issue_comment", "https://github.com/ithaca/watchtower#merge"]);
  });
});

test("graphqlQueryRepository reads literal and variable arguments, and refuses comments, escapes and block strings", () => {
  // A close event's closer, as a heartbeat check reads it, stays inside the repository.
  expect(graphqlQueryRepository('query Closed($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(last: 5, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { createdAt actor { login } closer { __typename ... on PullRequest { number merged } } } } } } } }',
    { owner: "ithaca", name: "watchtower", number: 7 }), "NESTED_IN_REPOSITORY_ALLOWED").toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower") { id } }', {})).toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('query { repository(owner:"ithaca" name:"watchtower") { id } }', {}), "COMMALESS_ARGUMENTS_ALLOWED").toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower", extra) { id } }', {}), "STRAY_ARGUMENT_TEXT_REFUSED").toBeNull();
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower") { issues(first: 5) { edges { node { number } } } } }', {}), "CONNECTION_EDGES_ALLOWED").toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('query {\n  repository(name: $n, owner: $o) { label(name: "bug") { id } }\n}', { o: "ithaca", n: "watchtower" })).toBe("ithaca/watchtower");
  expect(graphqlQueryRepository('# mutation { x }\nquery { repository(name: $n, owner: $o) { description } }', { o: "ithaca", n: "watchtower" }), "COMMENT_REFUSED").toBeNull();
  expect(graphqlQueryRepository('{ repository(owner: "ithaca", name: "watchtower") { ...Fields } } fragment Fields on Repository { id }', {})).toBeNull();
  expect(graphqlQueryRepository("subscription { repository(owner: \"ithaca\", name: \"watchtower\") { id } }", {})).toBeNull();
});
