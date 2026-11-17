/**
 * The GitHub detail pages and avatar proxy (#3796) against loopback stand-ins
 * for the GitHub API and the avatar host: only an object a GitHub tool result
 * in the session returned, only for the chat's owner, only the fixed parts,
 * pages in the tools' contract types bounded to the page size, direct links
 * that pass the validator or are null, typed failures, and avatars judged by
 * their bytes, sent no credential and cached within a bound.
 *
 * Keyless and offline: both stand-ins listen on loopback after the network
 * preload; the token is a synthetic sentinel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { GITHUB_DETAIL_ERROR_RESPONSE_SCHEMA, GITHUB_DETAIL_PAGE_SCHEMA, type GithubDetailPage, type GithubIssue, type GithubToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../src/app-env.js";
import type { Principal } from "../src/db/principals.js";
import { createGithubDetails, githubSessionScope, sniffImage, type GithubDetailsOptions } from "../src/github/details.js";
import { createGithubToolsHost } from "../src/github/host.js";
import { createGithubDetailRoutes, type GithubDetailRouteDeps } from "../src/routes/github-details.js";
import { COMMIT_SHAS, GITHUB_TOOLS_SENTINEL, fakeGithub, standInFetch, type FakeGithub, type FakeGithubOptions } from "./fixtures/github-host-fixture.js";

const SESSION = "sess-ithaca-details";
const OTHER = "sess-aiaia";
const NOW = Date.parse("2026-07-12T12:00:00Z");
const WEB = "https://github.com/odysseus/ithaca";
const owner = { id: "principal-penelope", kind: "owner" } as Principal;
const stranger = { id: "principal-suitor", kind: "agent" } as Principal;

const stops: Array<{ stop(): void }> = [];
afterEach(() => { for (const fake of stops.splice(0)) fake.stop(); });

// ------------------------------------------------------------ stand-ins

/** A PNG header naming `width` x `height`, padded to `bytes`. */
function png(width: number, height: number, bytes = 64): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.max(bytes, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}

interface FakeAvatars { origin: string; seen: Array<{ path: string; search: string; authorization: string | null; cookie: string | null }>; stop(): void }
function fakeAvatars(): FakeAvatars {
  const seen: FakeAvatars["seen"] = [];
  const asPng = (body: BodyInit) => new Response(body, { headers: { "content-type": "image/png" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname, search: url.search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
    switch (url.pathname) {
      case "/penelope": case "/telemachus": case "/herald%5Bbot%5D": case "/eumaeus": return asPng(png(64, 64));
      // Labelled PNG, but not one by its bytes.
      case "/circe": return asPng('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      case "/siren": return asPng("<!doctype html><html><body>Come closer</body></html>");
      // Over the byte cap, and over the pixel cap.
      case "/cyclops": return asPng(png(64, 64, 600 * 1024));
      case "/polyphemus": return asPng(png(4096, 4096));
      default: return new Response("Not Found", { status: 404 });
    }
  } });
  const result = { origin: `http://127.0.0.1:${server.port}`, seen, stop: () => { void server.stop(true); } };
  stops.push(result);
  return result;
}
function avatarFetch(fake: Pick<FakeAvatars, "origin">): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://avatars.githubusercontent.com") throw new Error(`avatar left its host: ${url.href}`);
    return fetch(new URL(`${url.pathname}${url.search}`, fake.origin), init);
  }) as typeof fetch;
}

const comment = (id: number, html_url: string) => ({ id, html_url, user: { login: "eumaeus", type: "User" }, author_association: "CONTRIBUTOR",
  body: `Comment ${id}: the swineherd keeps watch.`, created_at: "2026-07-03T09:00:00Z", updated_at: "2026-07-03T09:00:00Z" });
const linked = (body: unknown, next: boolean) => Response.json(body, next ? { headers: { link: '<https://api.github.com/next?page=2>; rel="next"' } } : undefined);

/**
 * The standard stand-in, then, once the tool results are recorded (`detail`
 * set), the detail endpoints and the test's own overrides.
 */
function github(options: FakeGithubOptions & { comments?: number } = {}): FakeGithub & { detail: boolean } {
  const total = options.comments ?? 45;
  const state = { detail: false };
  const fake = fakeGithub({ ...options, comments: undefined, override: (path, search) => {
    if (!state.detail) return undefined;
    const custom = options.override?.(path, search);
    if (custom) return custom;
    const page = Number(search.get("page") ?? "1"), perPage = Number(search.get("per_page") ?? "30");
    if (path === "/repos/odysseus/ithaca/issues/7/comments") {
      const all = Array.from({ length: total }, (_, index) => comment(9000 + index, `${WEB}/issues/7#issuecomment-${9000 + index}`));
      return linked(all.slice((page - 1) * perPage, page * perPage), page * perPage < total);
    }
    if (path === "/repos/odysseus/ithaca/pulls/8/commits") {
      // Ignores per_page on purpose: the host still returns at most a page.
      const shas = Array.from({ length: 40 }, (_, index) => String(index).padStart(40, "0"));
      const all = shas.map(sha => ({ sha, html_url: `${WEB}/commit/${sha}`, author: { login: "telemachus", type: "User" },
        commit: { message: `Wax ${sha.slice(-2)}`, author: { name: "Telemachus", date: "2026-07-04T09:00:00Z" } } }));
      return linked(page === 1 ? all : all.slice(30 * (page - 1), 30 * page), page === 1);
    }
    if (path === "/repos/odysseus/ithaca/pulls/8/comments") return Response.json([
      { id: 801, pull_request_review_id: 501, in_reply_to_id: null, user: { login: "penelope", type: "User" }, author_association: "OWNER", path: "bow/string.ts", line: 12,
        body: "Tighter.", created_at: "2026-07-05T09:00:00Z", updated_at: "2026-07-05T09:00:00Z", html_url: `${WEB}/pull/8#discussion_r801` },
      { id: 802, pull_request_review_id: null, in_reply_to_id: 801, user: { login: "telemachus", type: "User" }, author_association: "COLLABORATOR", path: "bow/string.ts", line: null,
        body: "Done.", created_at: "2026-07-05T10:00:00Z", updated_at: "2026-07-05T10:00:00Z", html_url: `${WEB}/pull/8#discussion_r999` },
    ]);
    if (path === "/repos/odysseus/ithaca/pulls/8/files") return Response.json([
      { filename: "bow/string.ts", status: "modified", additions: 100, deletions: 7, changes: 107, patch: "@@ the diff never leaves @@" },
      { filename: "bow/wax.ts", previous_filename: "bow/tallow.ts", status: "renamed", additions: 20, deletions: 0, changes: 20 },
    ]);
    return undefined;
  } });
  stops.push(fake);
  return Object.defineProperty(fake, "detail", { get: () => state.detail, set: (value: boolean) => { state.detail = value; } }) as FakeGithub & { detail: boolean };
}

// ------------------------------------------------------------- history

/** What the real host's tools returned, as the session's history records it. */
async function toolResults(fake: FakeGithub): Promise<GithubToolResult[]> {
  const host = createGithubToolsHost({ token: () => GITHUB_TOOLS_SENTINEL, fetch: standInFetch(fake), now: () => NOW, untrusted: async () => {} });
  const turn = { turnId: "turn-ithaca", principalId: owner.id, sessionId: () => SESSION, routing: async () => null };
  const results = [
    await host.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } }),
    await host.call(turn, { tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 8 } }),
  ];
  for (const result of results) if (!result.ok) throw new Error(JSON.stringify(result));
  return results;
}
function history(results: GithubToolResult[], names: string[] = results.map(() => "mcp__brain-ui__brain_github_issue_read")): SessionHistoryMessage[] {
  return [{ role: "user", content: "Look up the suitors", toolCalls: [] },
    { role: "assistant", content: "", toolCalls: results.map((result, index) => ({ id: `call-${index}`, name: names[index]!, input: {}, output: JSON.stringify(result), isError: !result.ok })) }];
}

/** A read of #7 whose comment authors are the avatar cases. */
function avatarResult(base: GithubToolResult): GithubToolResult {
  const issue = structuredClone((base as Extract<GithubToolResult, { ok: true }>).result) as GithubIssue;
  issue.comments.items = ["circe", "siren", "cyclops", "polyphemus", "telemachus"].map((login, index) => ({ ...issue.comments.items[0]!, id: 7000 + index,
    html_url: null, author: { login, is_bot: false, author_association: "NONE" } }));
  return { ok: true, tool: "brain_github_issue_read", result: issue };
}

// ---------------------------------------------------------------- app

interface Harness {
  fake: FakeGithub & { detail: boolean };
  avatars: FakeAvatars;
  details: ReturnType<typeof createGithubDetails>;
  get(path: string, as?: Principal): Promise<Response>;
  json<T = unknown>(path: string, as?: Principal): Promise<{ status: number; body: T }>;
  histories: Record<string, SessionHistoryMessage[]>;
}

async function harness(options: { github?: FakeGithubOptions & { comments?: number }; details?: Partial<GithubDetailsOptions>; routes?: Partial<GithubDetailRouteDeps>; } = {}): Promise<Harness> {
  const fake = github(options.github), avatars = fakeAvatars();
  const results = await toolResults(fake);
  fake.detail = true;
  const histories: Record<string, SessionHistoryMessage[]> = { [SESSION]: history([...results, avatarResult(results[0]!)]), [OTHER]: [] };
  const details = createGithubDetails({ token: () => GITHUB_TOOLS_SENTINEL, fetch: standInFetch(fake), avatarFetch: avatarFetch(avatars), now: () => NOW, ...options.details });
  const app = new Hono<AppEnv>();
  const principals: Record<string, Principal> = { [owner.id]: owner, [stranger.id]: stranger };
  app.use("*", async (c, next) => { const id = c.req.header("x-principal"); if (id && principals[id]) c.set("principal", principals[id]); await next(); });
  app.route("/api", createGithubDetailRoutes({ details, principalValid: () => true,
    owns: (principal, sessionId) => principal.kind === "owner" && sessionId in histories,
    retired: () => false, history: async sessionId => histories[sessionId] ?? [], ...options.routes }));
  const get = (path: string, as: Principal = owner) => Promise.resolve(app.fetch(new Request(`http://localhost/api${path}`, { headers: { "x-principal": as.id } })));
  return { fake, avatars, details, histories, get,
    async json<T>(path: string, as?: Principal) { const response = await get(path, as); return { status: response.status, body: await response.json() as T }; } };
}

const pageOf = (body: unknown) => GITHUB_DETAIL_PAGE_SCHEMA.parse(body);
const errorOf = (body: unknown) => GITHUB_DETAIL_ERROR_RESPONSE_SCHEMA.parse(body).error;
const detailPath = (number: number, part: string, cursor?: string) => `/sessions/${SESSION}/github/odysseus/ithaca/${number}/${part}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
const detailRequests = (fake: FakeGithub) => fake.seen.filter(request => /\/(comments|commits|reviews|files|check-runs|status)$/.test(request.path) || request.path.endsWith("/pulls/8"));

// --------------------------------------------------------------- tests

describe("paging an object the session returned", () => {
  test("the owner pages an issue's comments with cursors, each page bounded and in the contract's types", async () => {
    const t = await harness();
    t.fake.seen.length = 0;
    const first = await t.json(detailPath(7, "comments"));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const one = pageOf(first.body) as Extract<GithubDetailPage, { part: "comments" }>;
    expect(one, "GITHUB_DETAIL_COMMENTS_PAGE_ONE").toMatchObject({ kind: "detail_page", repository: "odysseus/ithaca", number: 7, part: "comments", next_cursor: "2", total_count: null });
    expect(one.items.map(item => item.id)).toEqual(Array.from({ length: 30 }, (_, index) => 9000 + index));
    expect(one.items[0]).toMatchObject({ author: { login: "eumaeus", is_bot: false, author_association: "CONTRIBUTOR" }, html_url: `${WEB}/issues/7#issuecomment-9000` });
    const second = pageOf((await t.json(detailPath(7, "comments", one.next_cursor!))).body) as Extract<GithubDetailPage, { part: "comments" }>;
    expect(second.items.map(item => item.id), "GITHUB_DETAIL_COMMENTS_PAGE_TWO").toEqual(Array.from({ length: 15 }, (_, index) => 9030 + index));
    expect(second.next_cursor, "GITHUB_DETAIL_LAST_PAGE").toBeNull();
    const asked = t.fake.seen.filter(request => request.path.endsWith("/comments"));
    expect(asked.map(request => request.search), "GITHUB_DETAIL_PAGE_SIZE_ASKED").toEqual(["?per_page=30&page=1", "?per_page=30&page=2"]);
    for (const request of t.fake.seen) expect(request.authorization, "GITHUB_DETAIL_DEDICATED_CREDENTIAL").toBe(`Bearer ${GITHUB_TOOLS_SENTINEL}`);
  });

  test("a pull request's commits page with cursors, and an upstream page larger than asked is cut to the bound", async () => {
    const t = await harness();
    const one = pageOf((await t.json(detailPath(8, "commits"))).body) as Extract<GithubDetailPage, { part: "commits" }>;
    expect(one.items.length, "GITHUB_DETAIL_PAGE_SIZE_BOUND").toBe(30);
    expect(one.next_cursor).toBe("2");
    expect(one.items[0]).toMatchObject({ author: { login: "telemachus" }, author_name: "Telemachus", message: "Wax 00" });
    expect(new Set(one.items.map(item => item.sha)).size).toBe(30);
    const two = pageOf((await t.json(detailPath(8, "commits", "2"))).body) as Extract<GithubDetailPage, { part: "commits" }>;
    expect(two.items.length, "GITHUB_DETAIL_COMMITS_PAGE_TWO").toBe(10);
    expect(two.next_cursor).toBeNull();
  });

  test("reviews, review comments, files and checks each page in their own types; files carry no diff", async () => {
    const t = await harness();
    const reviews = pageOf((await t.json(detailPath(8, "reviews"))).body) as Extract<GithubDetailPage, { part: "reviews" }>;
    expect(reviews.items.map(item => [item.id, item.state])).toEqual([[501, "approved"], [502, "commented"], [503, "changes_requested"], [504, "dismissed"]]);
    const files = (await t.json(detailPath(8, "files"))).body;
    expect(JSON.stringify(files), "GITHUB_DETAIL_FILES_SUMMARY_ONLY").not.toContain("the diff never leaves");
    expect((pageOf(files) as Extract<GithubDetailPage, { part: "files" }>).items).toEqual([
      { filename: "bow/string.ts", previous_filename: null, status: "modified", additions: 100, deletions: 7, changes: 107 },
      { filename: "bow/wax.ts", previous_filename: "bow/tallow.ts", status: "renamed", additions: 20, deletions: 0, changes: 20 }]);
    const runs = pageOf((await t.json(detailPath(8, "checks"))).body) as Extract<GithubDetailPage, { part: "checks" }>;
    expect(runs.items.map(item => item.state), "GITHUB_DETAIL_CHECK_RUNS").toEqual(["passed", "failed", "running", "skipped"]);
    expect(runs.next_cursor).toBe("statuses:1");
    const statuses = pageOf((await t.json(detailPath(8, "checks", "statuses:1"))).body) as Extract<GithubDetailPage, { part: "checks" }>;
    expect(statuses.items, "GITHUB_DETAIL_COMMIT_STATUSES").toEqual([{ source: "status", name: "", state: "passed", conclusion: "success", started_at: null, completed_at: null }]);
    expect(statuses.next_cursor).toBeNull();
  });
});

describe("refusals", () => {
  test("an object no GitHub result in the session returned is 404 and nothing is sent", async () => {
    const t = await harness();
    t.fake.seen.length = 0;
    // #7 is real and readable: only the other session returned it.
    for (const path of [`/sessions/${OTHER}/github/odysseus/ithaca/7/comments`, `/sessions/${SESSION}/github/odysseus/ithaca/9/comments`, `/sessions/${SESSION}/github/circe/aiaia/7/comments`]) {
      const refused = await t.json(path);
      expect(refused.status, `GITHUB_DETAIL_NOT_IN_SESSION ${path}`).toBe(404);
      expect(errorOf(refused.body), `GITHUB_DETAIL_NOT_IN_SESSION_REASON ${path}`).toMatchObject({ code: "not_found", reason: "not_in_session" });
    }
    expect(detailRequests(t.fake), "GITHUB_DETAIL_NOTHING_SENT_OUTSIDE_SESSION").toEqual([]);
  });

  test("a session the caller does not own is 403, and a part outside the fixed set is 400", async () => {
    const t = await harness();
    t.fake.seen.length = 0;
    const foreign = await t.json(detailPath(7, "comments"), stranger);
    expect(foreign.status, "GITHUB_DETAIL_NOT_OWNER").toBe(403);
    expect(errorOf(foreign.body)).toMatchObject({ code: "forbidden", reason: "not_owner" });
    for (const part of ["timeline", "events", "diff", "COMMENTS"]) {
      const refused = await t.json(detailPath(7, part));
      expect(refused.status, `GITHUB_DETAIL_PART_REFUSED ${part}`).toBe(400);
      expect(errorOf(refused.body)).toMatchObject({ code: "invalid_input", reason: "part" });
    }
    for (const cursor of ["0", "abc", "runs:1", "../2"]) expect((await t.get(detailPath(7, "comments", cursor))).status, `GITHUB_DETAIL_CURSOR_REFUSED ${cursor}`).toBe(400);
    expect((await t.get(detailPath(7, "commits"))).status, "GITHUB_DETAIL_ISSUE_HAS_NO_COMMITS").toBe(404);
    expect((await t.get("/sessions/sess-ithaca-details/github/odysseus/ithaca/7/comments", { id: "nobody" } as Principal)).status, "GITHUB_DETAIL_AUTH").toBe(401);
    expect(detailRequests(t.fake)).toEqual([]);
  });

  test("without the credential the route answers unavailable, and a spent rate limit names its reset time", async () => {
    const t = await harness({ details: { token: () => undefined } });
    t.fake.seen.length = 0;
    const missing = await t.json(detailPath(7, "comments"));
    expect(missing.status).toBe(503);
    expect(errorOf(missing.body), "GITHUB_DETAIL_NO_CREDENTIAL").toMatchObject({ code: "unavailable", reason: "no_credential", reset_at: null });
    expect(t.fake.seen).toEqual([]);

    const reset = Math.floor(NOW / 1000) + 600;
    const limited = await harness({ github: { override: path => path.endsWith("/comments")
      ? Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }) : undefined } });
    const response = await limited.get(detailPath(7, "comments"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(errorOf(await response.json()), "GITHUB_DETAIL_RATE_LIMIT_RESET").toEqual({ code: "rate_limited", reason: "github",
      message: "GitHub's rate limit for the host credential is spent; try again later.", reset_at: new Date(reset * 1000).toISOString() });
  });

  test("access revoked upstream and an upstream failure are distinct typed errors", async () => {
    const revoked = await harness({ github: { override: path => path.endsWith("/comments") ? Response.json({ message: "Not Found" }, { status: 404 }) : undefined } });
    const gone = await revoked.json(detailPath(7, "comments"));
    expect([gone.status, errorOf(gone.body).code, errorOf(gone.body).reason], "GITHUB_DETAIL_UPSTREAM_NOT_FOUND").toEqual([404, "not_found", "github"]);
    const broken = await harness({ github: { override: path => path.endsWith("/comments") ? new Response("down", { status: 503 }) : undefined } });
    const failed = await broken.json(detailPath(7, "comments"));
    expect([failed.status, errorOf(failed.body).code, errorOf(failed.body).reason], "GITHUB_DETAIL_UPSTREAM_ERROR").toEqual([502, "upstream_error", "http_503"]);
  });
});

describe("direct links", () => {
  test("a page item whose upstream html_url fails the validator is returned with null, a conforming one unchanged", async () => {
    const t = await harness({ github: { override: path => {
      if (path !== "/repos/odysseus/ithaca/issues/7/comments") return undefined;
      return Response.json([
        comment(1, `${WEB}/issues/7#issuecomment-1`),
        comment(2, "https://github.com.evil.example/odysseus/ithaca/issues/7#issuecomment-2"),
        comment(3, "https://github.com/circe/aiaia/issues/7#issuecomment-3"),
        comment(4, `${WEB}/issues/8#issuecomment-4`),
        comment(5, `${WEB}/issues/7#issuecomment-55`),
        comment(6, "http://github.com/odysseus/ithaca/issues/7#issuecomment-6"),
      ]);
    } } });
    const page = pageOf((await t.json(detailPath(7, "comments"))).body) as Extract<GithubDetailPage, { part: "comments" }>;
    expect(page.items.map(item => [item.id, item.html_url]), "GITHUB_DETAIL_LINKS_VALIDATED").toEqual([
      [1, `${WEB}/issues/7#issuecomment-1`], [2, null], [3, null], [4, null], [5, null], [6, null]]);
    const reviews = pageOf((await t.json(detailPath(8, "reviews"))).body) as Extract<GithubDetailPage, { part: "reviews" }>;
    expect(reviews.items.find(item => item.id === 504)!.html_url, "GITHUB_DETAIL_REVIEW_OTHER_HOST").toBeNull();
    expect(reviews.items.find(item => item.id === 501)!.html_url).toBe(`${WEB}/pull/8#pullrequestreview-501`);
    // A display page counts nothing: its reviews satisfy the shared schema with an unknown count (#4147).
    expect(reviews.items.map(item => item.line_comments), "GITHUB_DETAIL_REVIEW_COUNT_UNKNOWN").toEqual(reviews.items.map(() => null));
    const comments = pageOf((await t.json(detailPath(8, "review-comments"))).body) as Extract<GithubDetailPage, { part: "review-comments" }>;
    expect(comments.items.map(item => [item.id, item.html_url]), "GITHUB_DETAIL_REVIEW_COMMENT_ID_MISMATCH").toEqual([[801, `${WEB}/pull/8#discussion_r801`], [802, null]]);
    expect(comments.items[1]).toMatchObject({ review_id: null, in_reply_to_id: 801, line: null, path: "bow/string.ts" });
  });

  test("a commit whose html_url names another sha is null", async () => {
    const t = await harness({ github: { override: path => path === "/repos/odysseus/ithaca/pulls/8/commits" ? Response.json([
      { sha: COMMIT_SHAS[0], html_url: `${WEB}/commit/${COMMIT_SHAS[0]}`, author: null, commit: { message: "Wax", author: { name: "Telemachus", date: "2026-07-04T09:00:00Z" } } },
      { sha: COMMIT_SHAS[1], html_url: `${WEB}/commit/${COMMIT_SHAS[0]}`, author: null, commit: { message: "Wax", author: { name: "Telemachus", date: "2026-07-04T09:00:00Z" } } },
    ]) : undefined } });
    const page = pageOf((await t.json(detailPath(8, "commits"))).body) as Extract<GithubDetailPage, { part: "commits" }>;
    expect(page.items.map(item => item.html_url), "GITHUB_DETAIL_COMMIT_SHA_MISMATCH").toEqual([`${WEB}/commit/${COMMIT_SHAS[0]}`, null]);
  });
});

describe("the session's GitHub scope", () => {
  test("is read from the tools' own successful results under either backend's name, and nothing else", async () => {
    const fake = github(), results = await toolResults(fake);
    const scope = githubSessionScope(history(results, ["brain_github_issue_read", "mcp__brain-ui__brain_github_issue_read"]));
    expect([...scope.objects.keys()].sort(), "GITHUB_SCOPE_BOTH_NAMES").toEqual(["odysseus/ithaca#7", "odysseus/ithaca#8"]);
    expect(scope.objects.get("odysseus/ithaca#8")!.pullRequest).toBe(true);
    expect([...scope.logins].sort(), "GITHUB_SCOPE_LOGINS").toEqual(["herald[bot]", "penelope", "telemachus"]);
    const refused: GithubToolResult = { ok: false, tool: "brain_github_issue_read", error: { code: "not_found", reason: null, message: "No." } };
    const forged = history(results, ["WebFetch", "mcp__other__brain_github_issue_read"]);
    expect(githubSessionScope([...forged, ...history([refused])]).objects.size, "GITHUB_SCOPE_ONLY_TOOL_RESULTS").toBe(0);
  });
});

describe("the avatar proxy", () => {
  test("serves a login in the session's results from this origin, judged by its bytes, cached, and with no credential upstream", async () => {
    const t = await harness();
    const first = await t.get(`/sessions/${SESSION}/github/avatars/penelope?size=40`);
    expect(first.status, "GITHUB_AVATAR_SERVED").toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("x-content-type-options"), "GITHUB_AVATAR_NOSNIFF").toBe("nosniff");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(png(64, 64));
    expect((await t.get(`/sessions/${SESSION}/github/avatars/Penelope?size=64`)).status, "GITHUB_AVATAR_CACHED").toBe(200);
    expect(t.avatars.seen, "GITHUB_AVATAR_ONE_FETCH").toEqual([{ path: "/penelope", search: "?size=64", authorization: null, cookie: null }]);
    expect((await t.get(`/sessions/${SESSION}/github/avatars/herald[bot]`)).status, "GITHUB_AVATAR_BOT").toBe(200);
    for (const request of t.avatars.seen) expect([request.authorization, request.cookie], "GITHUB_AVATAR_NO_CREDENTIAL").toEqual([null, null]);
  });

  test("a login not in the session's results, another owner and every refused image are 404", async () => {
    const t = await harness();
    for (const login of ["circe", "siren", "cyclops", "polyphemus"]) {
      const response = await t.get(`/sessions/${SESSION}/github/avatars/${login}`);
      expect(response.status, `GITHUB_AVATAR_REFUSED ${login}`).toBe(404);
      expect(await response.text()).toBe("");
    }
    expect(t.details.avatarCache().entries, "GITHUB_AVATAR_REFUSED_NOT_CACHED").toBe(0);
    t.avatars.seen.length = 0;
    expect((await t.get(`/sessions/${SESSION}/github/avatars/athena`)).status, "GITHUB_AVATAR_NOT_IN_SESSION").toBe(404);
    expect((await t.get(`/sessions/${OTHER}/github/avatars/penelope`)).status, "GITHUB_AVATAR_OTHER_SESSION").toBe(404);
    expect((await t.get(`/sessions/${SESSION}/github/avatars/penelope`, stranger)).status, "GITHUB_AVATAR_NOT_OWNER").toBe(404);
    expect(t.avatars.seen, "GITHUB_AVATAR_NOTHING_FETCHED_OUTSIDE_SESSION").toEqual([]);
  });

  test("a login first seen in a served detail page gets its avatar", async () => {
    const t = await harness();
    expect((await t.get(`/sessions/${SESSION}/github/avatars/eumaeus`)).status).toBe(404);
    expect((await t.get(detailPath(7, "comments"))).status).toBe(200);
    expect((await t.get(`/sessions/${SESSION}/github/avatars/eumaeus`)).status, "GITHUB_AVATAR_FROM_DETAIL_PAGE").toBe(200);
  });

  test("a full cache evicts its oldest entry and never grows", async () => {
    const t = await harness({ details: { avatarLimits: { entries: 2 } } });
    for (const login of ["penelope", "telemachus", "herald[bot]"]) expect((await t.get(`/sessions/${SESSION}/github/avatars/${encodeURIComponent(login)}`)).status).toBe(200);
    expect(t.details.avatarCache(), "GITHUB_AVATAR_CACHE_BOUNDED").toEqual({ entries: 2, bytes: 2 * png(64, 64).byteLength });
    t.avatars.seen.length = 0;
    expect((await t.get(`/sessions/${SESSION}/github/avatars/herald%5Bbot%5D`)).status).toBe(200);
    expect(t.avatars.seen, "GITHUB_AVATAR_NEWEST_KEPT").toEqual([]);
    expect((await t.get(`/sessions/${SESSION}/github/avatars/penelope`)).status).toBe(200);
    expect(t.avatars.seen.map(request => request.path), "GITHUB_AVATAR_OLDEST_EVICTED").toEqual(["/penelope"]);
    expect(t.details.avatarCache().entries).toBe(2);
  });

  test("the byte sniffer knows the four allowed formats and nothing else", () => {
    const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 32, 0, 16, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 48, 0, 40, 3, 0, 0, 0, 0]);
    const webp = new Uint8Array(30); webp.set(new TextEncoder().encode("RIFF"), 0); webp.set(new TextEncoder().encode("WEBPVP8X"), 8); webp.set([39, 0, 0, 19, 0, 0], 24);
    expect([sniffImage(png(64, 32)), sniffImage(gif), sniffImage(jpeg), sniffImage(webp)]).toEqual([
      { type: "image/png", width: 64, height: 32 }, { type: "image/gif", width: 32, height: 16 }, { type: "image/jpeg", width: 40, height: 48 }, { type: "image/webp", width: 40, height: 20 }]);
    for (const text of ["<svg/>", "<!doctype html>", "BM6", "%PDF-1.7"]) expect(sniffImage(new TextEncoder().encode(text.padEnd(40, " ")))).toBeNull();
  });
});
