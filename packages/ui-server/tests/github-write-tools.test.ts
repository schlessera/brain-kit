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
import { createGithubToolsHost, type GithubOutwardAction, type GithubToolsHostOptions, type GithubToolsTurn, type GithubWriteTurn } from "../src/github/host.js";
import { GITHUB_TOOLS_SENTINEL, fakeGithub, standInFetch, type FakeGithub, type FakeGithubOptions } from "./fixtures/github-host-fixture.js";

const stops: FakeGithub[] = [];
afterEach(() => { for (const fake of stops.splice(0)) fake.stop(); });

const CREATE = { tool: "brain_github_issue_create", input: { repository: "odysseus/ithaca", title: "Bar the hall doors", body: "Before the contest of the bow.", labels: ["household", "urgent"] } } as const satisfies GithubToolCall;
const COMMENT = { tool: "brain_github_issue_comment", input: { repository: "odysseus/ithaca", number: 7, body: "The stores are counted again." } } as const satisfies GithubToolCall;

interface Harness {
  fake: FakeGithub; cards: PermissionRequest[]; recorded: GithubOutwardAction[];
  call(call: GithubToolCall, overrides?: Partial<GithubWriteTurn>, turnOverrides?: Partial<GithubToolsTurn>): Promise<GithubToolResult>;
}

function harness(answer: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision> = () => ({ behavior: "allow" }),
  options: { repositories?: readonly string[] | null; host?: Partial<GithubToolsHostOptions>; github?: FakeGithubOptions } = {}): Harness {
  const fake = fakeGithub(options.github); stops.push(fake);
  const cards: PermissionRequest[] = [], recorded: GithubOutwardAction[] = [];
  const github = createGithubToolsHost({ token: () => GITHUB_TOOLS_SENTINEL, fetch: standInFetch(fake), now: () => Date.parse("2026-07-12T12:00:00Z"),
    untrusted: async () => {}, ...options.host });
  return { fake, cards, recorded, call: (call, overrides = {}, turnOverrides = {}) => {
    const write: GithubWriteTurn = {
      repositories: () => options.repositories === undefined ? ["odysseus/ithaca"] : options.repositories,
      posture: "interactive", requestPermission: async request => { cards.push(request); return answer(request); },
      toolName: name => `mcp__brain-ui__${name}`, tainted: () => false, isCurrent: () => true,
      govern: event => { recorded.push(event); }, ...overrides,
    };
    return github.call({ turnId: "turn-ithaca", principalId: "principal-penelope", sessionId: () => "sess-ithaca", write, ...turnOverrides }, call);
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
