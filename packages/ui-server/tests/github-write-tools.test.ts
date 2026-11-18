/**
 * The host GitHub write tools (#3798) against a loopback stand-in for the
 * GitHub API: the turn's policy allow-list decides before any card, an
 * allowed write raises one card with exactly what will be sent, only an
 * unedited allow sends it, once, and every decision is recorded as an
 * `outward_action`. The stand-in accepts any write, so a refusal is proven
 * by the requests that never arrived.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GITHUB_RESULT_SCHEMAS, type GithubToolCall, type GithubToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { GITHUB_POSTER_RETRY_MS, GITHUB_POSTER_TTL_MS, createGithubToolsHost, type GithubOutwardAction, type GithubToolsHostOptions, type GithubToolsTurn, type GithubWriteTurn } from "../src/github/host.js";
import { GITHUB_TOOLS_POSTER, GITHUB_TOOLS_SENTINEL, fakeGithub, standInFetch, type FakeGithub, type FakeGithubOptions } from "./fixtures/github-host-fixture.js";

const stops: FakeGithub[] = [];
afterEach(() => { for (const fake of stops.splice(0)) fake.stop(); });

const CREATE = { tool: "brain_github_issue_create", input: { repository: "odysseus/ithaca", title: "Bar the hall doors", body: "Before the contest of the bow.", labels: ["household", "urgent"] } } as const satisfies GithubToolCall;
const COMMENT = { tool: "brain_github_issue_comment", input: { repository: "odysseus/ithaca", number: 7, body: "The stores are counted again." } } as const satisfies GithubToolCall;

interface Harness {
  fake: FakeGithub; cards: PermissionRequest[]; recorded: GithubOutwardAction[];
  call(call: GithubToolCall, overrides?: Partial<GithubWriteTurn>, turnOverrides?: Partial<GithubToolsTurn>): Promise<GithubToolResult>;
}

function harness(answer: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision> = () => ({ behavior: "allow" }),
  options: { repositories?: readonly string[] | null; host?: Partial<GithubToolsHostOptions>; github?: FakeGithubOptions; wrap?: (base: typeof fetch) => typeof fetch } = {}): Harness {
  const fake = fakeGithub(options.github); stops.push(fake);
  const cards: PermissionRequest[] = [], recorded: GithubOutwardAction[] = [];
  const base = standInFetch(fake);
  const github = createGithubToolsHost({ token: () => GITHUB_TOOLS_SENTINEL, fetch: options.wrap ? options.wrap(base) : base, now: () => Date.parse("2026-07-12T12:00:00Z"),
    untrusted: async () => {}, ...options.host });
  return { fake, cards, recorded, call: (call, overrides = {}, turnOverrides = {}) => {
    const write: GithubWriteTurn = {
      repositories: () => options.repositories === undefined ? ["odysseus/ithaca"] : options.repositories,
      posture: "interactive", requestPermission: async request => { cards.push(request); return answer(request); },
      toolName: name => `mcp__brain-ui__${name}`, tainted: () => false, isCurrent: () => true,
      govern: event => { recorded.push(event); }, ...overrides,
    };
    return github.call({ turnId: "turn-ithaca", principalId: "principal-penelope", sessionId: () => "sess-ithaca", routing: async () => null, write, ...turnOverrides }, call);
  } };
}
const writes = (fake: FakeGithub) => fake.seen.filter(request => request.method !== "GET");
const parsed = (result: GithubToolResult) => GITHUB_RESULT_SCHEMAS[result.tool].parse(result);

describe("an allowed write", () => {
  test("raises one card with the exact repository, title, body and labels, and Allow files exactly one issue", async () => {
    const h = harness();
    const result = parsed(await h.call(CREATE));
    expect(h.cards.length, "GITHUB_WRITE_ONE_CARD").toBe(1);
    expect(h.cards[0], "GITHUB_WRITE_CARD_EXACT").toMatchObject({ toolName: "mcp__brain-ui__brain_github_issue_create", kind: "command",
      input: { repository: "odysseus/ithaca", title: "Bar the hall doors", body: "Before the contest of the bow.", labels: ["household", "urgent"] } });
    expect(Object.keys(h.cards[0]!.input).sort()).toEqual(["body", "labels", "repository", "title"]);
    expect(writes(h.fake), "GITHUB_WRITE_EXACTLY_ONE_REQUEST").toHaveLength(1);
    const [sent] = writes(h.fake);
    expect(sent).toMatchObject({ method: "POST", path: "/repos/odysseus/ithaca/issues", authorization: `Bearer ${GITHUB_TOOLS_SENTINEL}` });
    // What was sent is what the card showed, the repository aside.
    expect(JSON.parse(sent!.body!), "GITHUB_WRITE_SENT_AS_SHOWN").toEqual({ title: "Bar the hall doors", body: "Before the contest of the bow.", labels: ["household", "urgent"] });
    expect(result).toEqual({ ok: true, tool: "brain_github_issue_create", result: { kind: "issue_created", repository: "odysseus/ithaca", number: 42,
      title: "Bar the hall doors", labels: ["household", "urgent"], created_at: "2026-07-12T09:00:00Z", html_url: "https://github.com/odysseus/ithaca/issues/42" } });
    expect(h.recorded.map(event => event.payload.decision), "GITHUB_WRITE_RECORDED_APPROVED").toEqual(["approved"]);
    expect(h.recorded[0]!.payload).toMatchObject({ tool: "mcp__brain-ui__brain_github_issue_create", action: "gh_write", target: "odysseus/ithaca", historyRewrite: false, tainted: false, rule: null });
    expect(JSON.parse(h.recorded[0]!.payload.input)).toEqual(h.cards[0]!.input);
  });

  test("a trimmed title is shown and sent trimmed, and an absent body or labels is neither shown nor sent", async () => {
    const h = harness();
    await h.call({ tool: "brain_github_issue_create", input: { repository: "odysseus/ithaca", title: "  Count the suitors  " } });
    expect(h.cards[0]!.input).toEqual({ repository: "odysseus/ithaca", title: "Count the suitors" });
    expect(JSON.parse(writes(h.fake)[0]!.body!)).toEqual({ title: "Count the suitors" });
  });

  test("a comment raises one card with the repository, number and body, and Allow posts exactly one comment", async () => {
    const h = harness();
    const result = parsed(await h.call(COMMENT));
    expect(h.cards.map(card => card.input), "GITHUB_COMMENT_CARD_EXACT").toEqual([{ repository: "odysseus/ithaca", number: 7, body: "The stores are counted again." }]);
    expect(writes(h.fake).map(request => [request.path, JSON.parse(request.body!)])).toEqual([["/repos/odysseus/ithaca/issues/7/comments", { body: "The stores are counted again." }]]);
    expect(result).toEqual({ ok: true, tool: "brain_github_issue_comment", result: { kind: "comment_created", repository: "odysseus/ithaca", number: 7,
      comment_id: 77001, created_at: "2026-07-12T09:00:00Z", html_url: "https://github.com/odysseus/ithaca/issues/7#issuecomment-77001" } });
    expect(h.recorded.map(event => [event.payload.target, event.payload.decision])).toEqual([["odysseus/ithaca#7", "approved"]]);
  });

  test("a tainted session's card says so, and its record carries the taint", async () => {
    const h = harness();
    await h.call(CREATE, { tainted: () => true });
    expect(h.cards[0]!.description).toContain("untrusted input");
    expect(h.recorded[0]!.payload.tainted).toBe(true);
    const unknown = harness();
    await unknown.call(CREATE, { tainted: () => { throw new Error("taint store unavailable"); } });
    expect(unknown.recorded[0]!.payload.tainted, "GITHUB_UNKNOWN_TAINT_IS_TAINTED").toBe(true);
  });
});

describe("a write that is not approved as shown sends nothing", () => {
  test("Deny sends nothing and is recorded as declined", async () => {
    const h = harness(() => ({ behavior: "deny", message: "Not today." }));
    const result = await h.call(CREATE);
    expect(result, "GITHUB_DENY_REFUSED").toMatchObject({ ok: false, error: { code: "approval_declined", reason: "declined" } });
    expect(h.cards).toHaveLength(1);
    expect(writes(h.fake), "GITHUB_DENY_SENDS_NOTHING").toEqual([]);
    expect(h.recorded.map(event => event.payload.decision)).toEqual(["declined"]);
  });

  test("an approval that changed the input sends nothing; one that echoes it unchanged sends it", async () => {
    for (const [label, updatedInput] of [
      ["another repository", { ...CREATE.input, repository: "odysseus/argo" }],
      ["another title", { ...CREATE.input, title: "Open the hall doors" }],
      ["an added label", { ...CREATE.input, labels: ["household", "urgent", "contest"] }],
    ] as const) {
      const h = harness(() => ({ behavior: "allow", updatedInput }));
      const result = await h.call(CREATE);
      expect(result, `GITHUB_EDITED_REFUSED ${label}`).toMatchObject({ ok: false, error: { code: "approval_declined", reason: "edited" } });
      expect(writes(h.fake), `GITHUB_EDITED_SENDS_NOTHING ${label}`).toEqual([]);
      expect(h.recorded.map(event => event.payload.decision)).toEqual(["declined"]);
    }
    const echoed = harness(request => ({ behavior: "allow", updatedInput: Object.fromEntries(Object.entries(request.input).reverse()) }));
    expect((await echoed.call(CREATE)).ok, "GITHUB_ECHOED_INPUT_SENDS").toBe(true);
    expect(writes(echoed.fake)).toHaveLength(1);
  });

  test("a turn that ended or lost its authority while the card was open sends nothing", async () => {
    const controller = new AbortController();
    const aborted = harness(() => { controller.abort(); return { behavior: "allow" }; });
    expect(await aborted.call(CREATE, {}, { signal: controller.signal })).toMatchObject({ ok: false, error: { reason: "cancelled" } });
    expect(writes(aborted.fake), "GITHUB_ABORTED_SENDS_NOTHING").toEqual([]);
    let current = true;
    const revoked = harness(() => { current = false; return { behavior: "allow" }; });
    expect(await revoked.call(CREATE, { isCurrent: () => current })).toMatchObject({ ok: false, error: { reason: "cancelled" } });
    expect(writes(revoked.fake), "GITHUB_REVOKED_SENDS_NOTHING").toEqual([]);
    expect(revoked.recorded.map(event => event.payload.decision)).toEqual(["refused"]);
  });

  test("an approval whose record fails sends nothing", async () => {
    const h = harness();
    const result = await h.call(CREATE, { govern: event => { if (event.payload.decision === "approved") throw new Error("governance store unavailable"); } });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", reason: "recording_unavailable" } });
    expect(writes(h.fake), "GITHUB_UNRECORDED_SENDS_NOTHING").toEqual([]);
  });

  test("a failed or redirected write is sent once and never retried or followed", async () => {
    for (const [label, answer, reason] of [
      ["server error", () => Response.json({ message: "The loom is tangled" }, { status: 502 }), "http_502"],
      ["redirect", () => new Response(null, { status: 307, headers: { location: "/repos/odysseus/argo/issues" } }), "http_307"],
    ] as const) {
      const h = harness(undefined, { github: { override: path => path === "/repos/odysseus/ithaca/issues" ? answer() : undefined } });
      expect(await h.call(CREATE), `GITHUB_WRITE_FAILED ${label}`).toMatchObject({ ok: false, error: { code: "upstream_error", reason } });
      expect(writes(h.fake).map(request => request.path), `GITHUB_WRITE_NOT_RETRIED ${label}`).toEqual(["/repos/odysseus/ithaca/issues"]);
    }
  });
});

describe("the repository allow-list", () => {
  test("a write outside the list is refused before any card, names the policy key, sends nothing and is recorded as refused", async () => {
    for (const call of [{ ...CREATE, input: { ...CREATE.input, repository: "circe/aiaia" } }, { ...COMMENT, input: { ...COMMENT.input, repository: "odysseus/argo" } }] as GithubToolCall[]) {
      const h = harness();
      const result = parsed(await h.call(call));
      expect(result, `GITHUB_OUTSIDE_LIST_REFUSED ${call.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "repository_not_allowed" } });
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toContain("outward.github.repositories");
      expect(h.cards, `GITHUB_OUTSIDE_LIST_NO_CARD ${call.tool}`).toEqual([]);
      expect(h.fake.seen, `GITHUB_OUTSIDE_LIST_NOTHING_SENT ${call.tool}`).toEqual([]);
      expect(h.recorded.map(event => event.payload.decision)).toEqual(["refused"]);
    }
  });

  test("the exact and owner/* forms reach the card, the owner and repository compare without case", async () => {
    for (const [repositories, repository] of [
      [["odysseus/ithaca"], "odysseus/ithaca"], [["odysseus/*"], "odysseus/argo"], [["Odysseus/*"], "odysseus/ithaca"],
      [["odysseus/Ithaca"], "ODYSSEUS/ithaca"], [["circe/aiaia", "odysseus/*"], "odysseus/ithaca"],
    ] as const) {
      const h = harness(undefined, { repositories });
      const result = await h.call({ ...CREATE, input: { ...CREATE.input, repository } });
      expect(result.ok, `GITHUB_ALLOWED ${repositories.join(",")} ${repository}`).toBe(true);
      expect(h.cards, `GITHUB_ALLOWED_CARD ${repositories.join(",")} ${repository}`).toHaveLength(1);
    }
    // One owner's wildcard is not another's, and an exact entry is not a prefix.
    for (const [repositories, repository] of [[["odysseus/*"], "circe/aiaia"], [["odysseus/ithaca"], "odysseus/ithaca-archive"], [["odysseus/ithaca"], "odysseu/ithaca"]] as const) {
      const h = harness(undefined, { repositories });
      expect((await h.call({ ...CREATE, input: { ...CREATE.input, repository } })).ok, `GITHUB_NOT_ALLOWED ${repositories.join(",")} ${repository}`).toBe(false);
      expect(h.cards).toEqual([]);
      expect(h.fake.seen).toEqual([]);
    }
  });

  test("an absent or empty list, or no governance policy at all, refuses every write", async () => {
    for (const repositories of [null, []] as const) {
      const h = harness(undefined, { repositories });
      for (const call of [CREATE, COMMENT] as GithubToolCall[]) {
        expect(await h.call(call), `GITHUB_NO_LIST_REFUSED ${JSON.stringify(repositories)} ${call.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "repository_not_allowed" } });
      }
      expect(h.cards).toEqual([]);
      expect(h.fake.seen).toEqual([]);
    }
  });

  test("no credential answers unavailable after the allow-list and before any card", async () => {
    const h = harness(undefined, { host: { token: () => undefined } });
    expect(await h.call(CREATE)).toMatchObject({ ok: false, error: { code: "unavailable", reason: "no_credential" } });
    expect(h.cards).toEqual([]);
    expect(h.fake.seen).toEqual([]);
  });
});

describe("data routing (G2, #4029) does not gate writes", () => {
  test("a write in a turn whose routing refuses github still reaches its card unchanged and is sent once on approval", async () => {
    const plain = harness(), routed = harness();
    const asked: string[] = [];
    const restricted = { routing: async (recipient: string) => { asked.push(recipient); return "recipient_restricted" as const; } };
    for (const call of [CREATE, COMMENT] as GithubToolCall[]) {
      const baseline = await plain.call(call), result = await routed.call(call, {}, restricted);
      expect(result, `GITHUB_WRITE_NOT_ROUTED ${call.tool}`).toEqual(baseline);
      expect(result.ok).toBe(true);
    }
    expect(routed.cards.map(card => [card.toolName, card.input]), "GITHUB_WRITE_CARD_UNCHANGED_UNDER_ROUTING").toEqual(plain.cards.map(card => [card.toolName, card.input]));
    expect(routed.cards).toHaveLength(2);
    expect(writes(routed.fake).map(request => [request.path, request.body]), "GITHUB_WRITE_SENT_UNDER_ROUTING").toEqual(writes(plain.fake).map(request => [request.path, request.body]));
    // The write's gate never asks: only the comment card's display lookup
    // does, before it sends the repository and number (#4154), and a refusal
    // leaves the target's kind unknown and sends GitHub no lookup for it.
    expect(asked, "GITHUB_WRITE_ROUTING_ONLY_FOR_DISPLAY").toEqual(["github"]);
    expect(routed.cards[1]!.display?.github?.target, "GITHUB_ROUTED_TARGET_UNKNOWN").toBeNull();
    expect(routed.fake.seen.filter(request => request.method === "GET" && request.path === "/repos/odysseus/ithaca/issues/7"), "GITHUB_ROUTED_NO_TARGET_LOOKUP").toEqual([]);
    expect(plain.cards[1]!.display?.github?.target, "positive control: an admitted turn verifies the target").toEqual({ kind: "issue", html_url: "https://github.com/odysseus/ithaca/issues/7" });
  });
});

describe("postures that never approve", () => {
  test("voice cannot approve a write: it is refused before any card, even when the surface would allow it", async () => {
    const h = harness(() => ({ behavior: "allow" }));
    for (const call of [CREATE, COMMENT] as GithubToolCall[]) {
      expect(await h.call(call, { posture: "voice" }), `GITHUB_VOICE_REFUSED ${call.tool}`).toMatchObject({ ok: false, error: { code: "approval_declined", reason: "voice_posture" } });
    }
    expect(h.cards, "GITHUB_VOICE_NO_CARD").toEqual([]);
    expect(h.fake.seen, "GITHUB_VOICE_NOTHING_SENT").toEqual([]);
    expect(h.recorded.map(event => event.payload.decision)).toEqual(["refused", "refused"]);
  });

  test("a turn without a write surface, as an autonomous one, cannot dispatch a write", async () => {
    const h = harness();
    for (const call of [CREATE, COMMENT] as GithubToolCall[]) {
      expect(await h.call(call, {}, { write: undefined }), `GITHUB_NO_WRITE_SURFACE ${call.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "no_write_surface" } });
    }
    expect(h.cards).toEqual([]);
    expect(h.fake.seen).toEqual([]);
  });
});

describe("a comment card's display facts (#4154)", () => {
  const PULL = { ...COMMENT, input: { ...COMMENT.input, number: 8 } } as const satisfies GithubToolCall;
  const lookups = (fake: FakeGithub, path: string) => fake.seen.filter(request => request.method === "GET" && request.path === path).length;
  /** A fetch whose answer to `path` is `answer`, given the credential the request carried; everything else reaches the stand-in. */
  const answering = (path: string, answer: (authorization: string | null, init?: RequestInit) => Response | Promise<Response>) => (base: typeof fetch) =>
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname === path ? Promise.resolve(answer(new Headers(init?.headers).get("authorization"), init)) : base(input, init);
    }) as typeof fetch;
  /** Never answers; rejects only when its request is aborted, as fetch does. */
  const silent = (_: string | null, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });

  test("the card names the verified poster and the target's kind, for an issue and for a pull request", async () => {
    const h = harness();
    await h.call(COMMENT);
    await h.call(PULL);
    expect(h.cards.map(card => card.display), "GITHUB_DISPLAY_VERIFIED").toEqual([
      { github: { poster: { login: GITHUB_TOOLS_POSTER, is_bot: false }, target: { kind: "issue", html_url: "https://github.com/odysseus/ithaca/issues/7" } } },
      { github: { poster: { login: GITHUB_TOOLS_POSTER, is_bot: false }, target: { kind: "pull_request", html_url: "https://github.com/odysseus/ithaca/pull/8" } } },
    ]);
    expect(lookups(h.fake, "/user"), "GITHUB_POSTER_CACHED_FOR_ITS_CREDENTIAL").toBe(1);
    expect(h.fake.seen.filter(request => request.path === "/user").every(request => request.authorization === `Bearer ${GITHUB_TOOLS_SENTINEL}`), "looked up with the posting credential").toBe(true);
  });

  test("an issue card carries no display facts and looks nothing up", async () => {
    const h = harness();
    await h.call(CREATE);
    expect(h.cards[0]!.display, "GITHUB_CREATE_NO_DISPLAY").toBeUndefined();
    expect(h.fake.seen.filter(request => request.method === "GET"), "GITHUB_CREATE_NO_LOOKUP").toEqual([]);
  });

  test("display facts change nothing approved, recorded, sent or returned to the model", async () => {
    const h = harness();
    const result = await h.call(PULL);
    const card = h.cards[0]!;
    expect(card.display?.github?.poster?.login, "positive control: the card has the facts").toBe(GITHUB_TOOLS_POSTER);
    expect(Object.keys(card.input).sort(), "GITHUB_DISPLAY_NOT_IN_INPUT").toEqual(["body", "number", "repository"]);
    expect(JSON.parse(h.recorded[0]!.payload.input), "GITHUB_DISPLAY_NOT_RECORDED").toEqual(card.input);
    expect(writes(h.fake).map(request => JSON.parse(request.body!)), "GITHUB_DISPLAY_NOT_SENT").toEqual([{ body: "The stores are counted again." }]);
    const returned = JSON.stringify(result);
    expect(returned.includes(GITHUB_TOOLS_POSTER) || returned.includes("pull_request") || returned.includes("display"), `GITHUB_DISPLAY_NOT_RETURNED ${returned}`).toBe(false);
    expect(parsed(result), "the result envelope is the contract's").toEqual(result);
  });

  test("an approval that echoes the card is compared with its input alone, so display facts never make it 'edited'", async () => {
    const h = harness(request => ({ behavior: "allow", updatedInput: { ...request.input } }));
    expect((await h.call(COMMENT)).ok, "GITHUB_DISPLAY_NOT_COMPARED").toBe(true);
    const smuggled = harness(request => ({ behavior: "allow", updatedInput: { ...request.input, display: request.display } }));
    expect(await smuggled.call(COMMENT), "GITHUB_DISPLAY_IN_ANSWER_IS_AN_EDIT").toMatchObject({ ok: false, error: { reason: "edited" } });
    expect(writes(smuggled.fake)).toEqual([]);
  });

  for (const [label, answer] of [
    ["a rejected credential", () => Response.json({ message: "Bad credentials" }, { status: 401 })],
    ["a credential that may not read its user", () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 })],
    ["a spent rate limit", () => Response.json({ message: "rate limited" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } })],
    ["a server error", () => new Response("no", { status: 502 })],
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["no login", () => Response.json({ type: "User" })],
    ["an invalid login", () => Response.json({ login: "not a login", type: "User" })],
    ["no answer before the deadline", silent],
  ] as const) {
    test(`${label} leaves the poster unknown, and the comment is still approved and sent once`, async () => {
      const h = harness(undefined, { wrap: answering("/user", answer), host: { displayTimeoutMs: 50 } });
      const result = await h.call(COMMENT);
      expect(h.cards[0]!.display?.github, `GITHUB_POSTER_NEUTRAL ${label}`).toEqual({ poster: null, target: { kind: "issue", html_url: "https://github.com/odysseus/ithaca/issues/7" } });
      expect(result.ok, `GITHUB_UNKNOWN_POSTER_STILL_WRITES ${label}`).toBe(true);
      expect(writes(h.fake)).toHaveLength(1);
    });
  }

  for (const [label, answer] of [
    ["no such object", () => Response.json({ message: "Not Found" }, { status: 404 })],
    ["a spent rate limit", () => Response.json({ message: "rate limited" }, { status: 429 })],
    ["an object moved to another repository", () => Response.json({ number: 7, repository_url: "https://api.github.com/repos/circe/aiaia", html_url: "https://github.com/circe/aiaia/issues/7" })],
    ["another number", () => Response.json({ number: 9, repository_url: "https://api.github.com/repos/odysseus/ithaca", html_url: "https://github.com/odysseus/ithaca/issues/9" })],
    ["malformed JSON", () => new Response("[", { status: 200 })],
    ["no answer before the deadline", silent],
  ] as const) {
    test(`${label} leaves the target's kind unknown, and the comment is still approved and sent once`, async () => {
      const h = harness(undefined, { wrap: answering("/repos/odysseus/ithaca/issues/7", answer), host: { displayTimeoutMs: 50 } });
      const result = await h.call(COMMENT);
      expect(h.cards[0]!.display?.github, `GITHUB_TARGET_NEUTRAL ${label}`).toEqual({ poster: { login: GITHUB_TOOLS_POSTER, is_bot: false }, target: null });
      expect(result.ok, `GITHUB_UNKNOWN_TARGET_STILL_WRITES ${label}`).toBe(true);
      expect(writes(h.fake)).toHaveLength(1);
    });
  }

  test("a lookup that never answers holds the card for the display deadline only", async () => {
    const h = harness(undefined, { wrap: base => answering("/repos/odysseus/ithaca/issues/7", silent)(answering("/user", silent)(base)), host: { displayTimeoutMs: 50 } });
    const started = performance.now();
    await h.call(COMMENT);
    expect(h.cards[0]!.display?.github, "GITHUB_SILENT_NEUTRAL").toEqual({ poster: null, target: null });
    // A hang watchdog, not a timing claim: the lookups end at their own deadline, far below one request's 20 s.
    expect(performance.now() - started, "GITHUB_DISPLAY_BOUNDED").toBeLessThan(10_000);
  });

  test("a rotated credential is never shown another credential's poster, and a failure for it reads unknown", async () => {
    let token = "odysseus-credential-one";
    const logins: Record<string, Response | undefined> = {
      "Bearer odysseus-credential-one": Response.json({ login: "penelope", type: "User" }),
      "Bearer odysseus-credential-two": Response.json({ login: "telemachus", type: "User" }),
    };
    const seen: (string | null)[] = [];
    const h = harness(undefined, { host: { token: () => token }, wrap: answering("/user", authorization => {
      seen.push(authorization);
      return logins[authorization ?? ""]?.clone() ?? Response.json({ message: "Bad credentials" }, { status: 401 });
    }) });
    await h.call(COMMENT);
    token = "odysseus-credential-two";
    await h.call(COMMENT);
    token = "odysseus-credential-three";
    await h.call(COMMENT);
    token = "odysseus-credential-one";
    await h.call(COMMENT);
    expect(h.cards.map(card => card.display?.github?.poster?.login ?? null), "GITHUB_POSTER_BOUND_TO_CREDENTIAL").toEqual(["penelope", "telemachus", null, "penelope"]);
    expect(seen, "each credential is looked up with itself, and a replaced entry is looked up again").toEqual([
      "Bearer odysseus-credential-one", "Bearer odysseus-credential-two", "Bearer odysseus-credential-three", "Bearer odysseus-credential-one"]);
    expect(writes(h.fake).map(request => request.authorization), "each comment is posted with the credential its card was resolved for").toEqual([
      "Bearer odysseus-credential-one", "Bearer odysseus-credential-two", "Bearer odysseus-credential-three", "Bearer odysseus-credential-one"]);
  });

  test("a failed lookup is not repeated until its retry time, and a verified poster is reused until its own", async () => {
    let clock = Date.parse("2026-07-12T12:00:00Z");
    let fail = true;
    const h = harness(undefined, { host: { now: () => clock }, wrap: answering("/user", () => fail
      ? Response.json({ message: "rate limited" }, { status: 429 })
      : Response.json({ login: GITHUB_TOOLS_POSTER, type: "User" })) });
    let asked = 0;
    const poster = async () => { await h.call(COMMENT); asked++; return h.cards.at(-1)!.display?.github?.poster?.login ?? null; };
    expect(await poster()).toBeNull();
    fail = false;
    expect(await poster(), "GITHUB_FAILED_LOOKUP_NOT_REPEATED").toBeNull();
    clock += GITHUB_POSTER_RETRY_MS;
    expect(await poster(), "GITHUB_FAILED_LOOKUP_RETRIED_AFTER_ITS_TIME").toBe(GITHUB_TOOLS_POSTER);
    fail = true;
    clock += GITHUB_POSTER_TTL_MS - 1;
    expect(await poster(), "GITHUB_POSTER_REUSED_WITHIN_TTL").toBe(GITHUB_TOOLS_POSTER);
    clock += 1;
    expect(await poster(), "GITHUB_POSTER_EXPIRES").toBeNull();
    expect(asked).toBe(5);
  });

  test("a credential GitHub rejects on the write keeps no identity for the next card", async () => {
    let reject = false;
    const h = harness(undefined, { wrap: base => ((input: RequestInfo | URL, init?: RequestInit) => reject && init?.method === "POST"
      ? Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 })) : base(input, init)) as typeof fetch });
    await h.call(COMMENT);
    reject = true;
    expect(await h.call(COMMENT)).toMatchObject({ ok: false, error: { reason: "credential_rejected" } });
    reject = false;
    await h.call(COMMENT);
    expect(lookups(h.fake, "/user"), "GITHUB_REJECTED_CREDENTIAL_FORGOTTEN").toBe(2);
  });
});
