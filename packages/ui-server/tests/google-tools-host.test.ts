/**
 * The host Gmail tools (#4207; plan docs/plans/google-workspace.md §6, §9)
 * against the fake gog: the decision gate before anything is sent, the two
 * views, provenance before return, `hidden_labels` on results, host cursors
 * and the write tools' refusal.
 *
 * Keyless and offline: the fake gog from packages/common/tests/support only.
 */
import { afterEach, expect, test } from "bun:test";
import { createGogTransport, type GogTransport } from "@schlessera/brain-common/internal/google-gog";
import { resolveGooglePolicy, type GooglePolicy, type GooglePrincipalKind } from "@schlessera/brain-common/internal/google-operations";
import { GOOGLE_RESULT_SCHEMAS, type GoogleToolCall, type GoogleToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createFakeGog, type FakeGog } from "../../common/tests/support/fake-gog.ts";
import { createGoogleToolsHost, googlePrincipalKind, type GoogleCallAudit, type GoogleToolsTurn } from "../src/google/host.js";
import type { Principal } from "../src/db/principals.js";
import type { RecipientRoutingRefusal } from "../src/web-tools/routing.js";
import { DRAFT, HALL, HALL_REPLY, HALL_TEXT, MISSING, SWINE, ithacaMail } from "./fixtures/google-host-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const POLICY = (hidden: string[] = []): GooglePolicy => resolveGooglePolicy({ enabled: true, account: "ithaca", services: ["gmail"], gmail: { hidden_labels: hidden } });

function harness(options: { principal?: GooglePrincipalKind; untrusted?: (event: { tool: string; detail: string }) => Promise<void>; scenario?: Record<string, unknown> } = {}) {
  const fake: FakeGog = createFakeGog({ ...ithacaMail(), ...(options.scenario ?? {}) } as never);
  cleanups.push(() => fake.dispose());
  const transport: GogTransport = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment, retryDelayMs: 1 });
  const taints: { tool: string; detail: string }[] = [];
  const opened: (string | null | undefined)[] = [];
  const audits: (GoogleCallAudit & { scope: unknown })[] = [];
  const host = createGoogleToolsHost({
    audit: (scope, event) => { audits.push({ ...event, scope }); },
    credential: { transport: account => { opened.push(account); return { ok: true, transport }; } },
    principal: () => options.principal ?? "owner",
    untrusted: async (_turn, event) => { if (options.untrusted) await options.untrusted(event); taints.push(event); },
  });
  const turn = (overrides: Partial<{ policy: GooglePolicy | null; routing: RecipientRoutingRefusal | null; session: string; posture: "interactive" | "voice" }> = {}): GoogleToolsTurn => ({
    turnId: "turn-ithaca", principalId: "odysseus", sessionId: () => overrides.session ?? "sess-ithaca", posture: overrides.posture ?? "interactive",
    policy: () => "policy" in overrides ? overrides.policy : POLICY(), routing: async () => overrides.routing ?? null, tainted: () => false,
  });
  const call = (tool: string, input: unknown, at = turn()) => host.call(at, { tool, input } as GoogleToolCall);
  return { fake, host, turn, call, taints, opened, audits, gogCalls: () => fake.calls().map(entry => entry.command) };
}

const valid = (result: GoogleToolResult) => (GOOGLE_RESULT_SCHEMAS[result.tool] as { safeParse(value: unknown): { success: boolean } }).safeParse(result).success;

test("a structured search returns only validated values, taints nothing and sends the query once", async () => {
  const h = harness();
  const result = await h.call("brain_google_gmail_search", { query: "from:penelope", view: "structured" });
  expect(result, "GOOGLE_STRUCTURED_SEARCH").toMatchObject({ ok: true, result: { kind: "search", view: "structured" } });
  expect(valid(result), "GOOGLE_STRUCTURED_SEARCH_VALID").toBe(true);
  const text = JSON.stringify(result);
  for (const word of HALL_TEXT) expect(text, `GOOGLE_STRUCTURED_HOLDS_NO_TEXT ${word}`).not.toContain(word);
  expect(text, "GOOGLE_STRUCTURED_LABEL_NAME").toContain("Ithaca/Household");
  expect(h.taints, "GOOGLE_STRUCTURED_RECORDS_NOTHING").toEqual([]);
  expect(h.fake.callsOf("gmail.search"), "GOOGLE_ONE_SEARCH").toHaveLength(1);
});

test("a content read records google_result before its text returns, and a failed record withholds it", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ untrusted: () => gate });
  let settled = false;
  const pending = h.call("brain_google_gmail_read", { target: "thread", id: HALL }).then(result => { settled = true; return result; });
  // The text is held until the record settles.
  for (let i = 0; i < 200 && h.fake.callsOf("gmail.thread.get").length === 0; i++) await Bun.sleep(10);
  await Bun.sleep(300);
  expect(settled, "GOOGLE_CONTENT_HELD_UNTIL_RECORDED").toBe(false);
  release();
  const result = await pending;
  expect(result, "GOOGLE_CONTENT_READ").toMatchObject({ ok: true, result: { kind: "thread", view: "content", thread_id: HALL } });
  expect(valid(result)).toBe(true);
  expect(JSON.stringify(result), "GOOGLE_CONTENT_CARRIES_TEXT").toContain(HALL_TEXT[0]);
  expect(h.taints, "GOOGLE_CONTENT_TAINTS").toEqual([{ tool: "brain_google_gmail_read", detail: "gmail.thread.get thread" }]);

  const failing = harness({ untrusted: async () => { throw new Error("safety store refused"); } });
  const withheld = await failing.call("brain_google_gmail_read", { target: "thread", id: HALL });
  expect(withheld, "GOOGLE_UNRECORDED_TAINT_WITHHOLDS").toEqual({ ok: false, tool: "brain_google_gmail_read",
    error: { code: "recording_unavailable", reason: "recording_unavailable", message: expect.stringContaining("withheld") } });
  expect(JSON.stringify(withheld), "GOOGLE_WITHHELD_HOLDS_NO_TEXT").not.toContain(HALL_TEXT[0]);
});

test("the label list is structured whatever the view and taints nothing", async () => {
  const h = harness();
  const result = await h.call("brain_google_gmail_read", { target: "labels", view: "content" });
  expect(result, "GOOGLE_LABELS_STRUCTURED").toMatchObject({ ok: true, result: { kind: "labels", view: "structured" } });
  expect(h.taints, "GOOGLE_LABELS_NO_TAINT").toEqual([]);
});

test("the gate refuses before anything is sent: not the owner, no policy, routing, voice is still a read", async () => {
  for (const [principal, reason] of [["not_owner", "not_owner"], ["none", "no_principal"]] as const) {
    const h = harness({ principal });
    const result = await h.call("brain_google_gmail_search", { query: "from:penelope" });
    expect(result, `GOOGLE_NOT_OWNER_REFUSED ${principal}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason } });
    expect(h.gogCalls(), `GOOGLE_NOT_OWNER_SENDS_NOTHING ${principal}`).toEqual([]);
    expect(h.opened, `GOOGLE_NOT_OWNER_OPENS_NO_TRANSPORT ${principal}`).toEqual([]);
  }
  const h = harness();
  expect(await h.call("brain_google_gmail_search", { query: "from:penelope" }, h.turn({ policy: null })), "GOOGLE_NO_POLICY_UNAVAILABLE")
    .toMatchObject({ ok: false, error: { code: "unavailable", reason: "not_enabled" } });
  for (const routing of ["recipient_restricted", "recipient_unproven"] as const) {
    const result = await h.call("brain_google_gmail_read", { target: "thread", id: HALL }, h.turn({ routing }));
    expect(result, `GOOGLE_ROUTING_REFUSED ${routing}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: routing } });
  }
  expect(h.gogCalls(), "GOOGLE_GATE_SENDS_NOTHING").toEqual([]);
  expect(h.taints).toEqual([]);
  // Ruling 6: a read needs no grant, so a voice turn reads.
  expect(await h.call("brain_google_gmail_search", { query: "from:penelope", view: "structured" }, h.turn({ posture: "voice" })), "GOOGLE_VOICE_READS")
    .toMatchObject({ ok: true });
});

test("a hidden label keeps its threads out of every search and every get, as a miss reads", async () => {
  const h = harness();
  const hidden = h.turn({ policy: POLICY(["Label_12"]) });
  const search = await h.call("brain_google_gmail_search", { query: "in:inbox", view: "structured" }, hidden);
  expect(search.ok && search.result.kind === "search" && search.result.threads.map(hit => hit.thread_id), "GOOGLE_HIDDEN_ABSENT_FROM_SEARCH").toEqual([SWINE]);
  const miss = await h.call("brain_google_gmail_read", { target: "thread", id: MISSING }, hidden);
  expect(miss, "GOOGLE_REAL_MISS").toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  for (const [target, id] of [["thread", HALL], ["message", HALL_REPLY], ["draft", DRAFT]] as const) {
    const result = await h.call("brain_google_gmail_read", { target, id }, hidden);
    expect(result, `GOOGLE_HIDDEN_NOT_FOUND ${target}`).toEqual(miss);
  }
  // A message whose own labels are clean is hidden when another message of its thread carries the label.
  const sibling = await h.call("brain_google_gmail_read", { target: "message", id: HALL_REPLY }, h.turn({ policy: POLICY(["CATEGORY_PERSONAL"]) }));
  expect(sibling, "GOOGLE_HIDDEN_BY_THREAD").toEqual(miss);
  const labels = await h.call("brain_google_gmail_read", { target: "labels" }, hidden);
  expect(labels.ok && labels.result.kind === "labels" && labels.result.labels.map(label => label.id), "GOOGLE_HIDDEN_LABEL_NOT_LISTED").not.toContain("Label_12");
  expect(h.taints, "GOOGLE_HIDDEN_NOTHING_TAINTED").toEqual([]);
  // Without the label the same reads return.
  expect(await h.call("brain_google_gmail_read", { target: "message", id: HALL_REPLY, view: "structured" }), "GOOGLE_UNHIDDEN_READS").toMatchObject({ ok: true });
});

test("while a label is hidden, a target whose labels cannot be established reads as a miss, and a failure that says nothing about it keeps its code", async () => {
  // Ids no fixture message carries, so only the failure decides the answer: Label_99 hides nothing here.
  const [ELSEWHERE, REFUSED, FAILED, THROTTLED, UNAUTHORIZED, MISUSED, ASTRAY] =
    ["19a0c3d2e4f50a01", "19a0c3d2e4f50a02", "19a0c3d2e4f50a03", "19a0c3d2e4f50a04", "19a0c3d2e4f50a05", "19a0c3d2e4f50a06", "19a0c3d2e4f50a07"];
  const [OTHER_THREAD, WANDERING_THREAD] = ["19a0c3d2e4f50b01", "19a0c3d2e4f50b02"];
  const [DRAFT_REFUSED, DRAFT_ELSEWHERE] = ["r-1234567890123456780", "r-1234567890123456781"];
  const mail = ithacaMail();
  const reply = mail[`gmail.get ${HALL_REPLY}`] as { stdout: { message: Record<string, unknown> } };
  // A message of its own whose thread answers for another thread.
  const astray = { stdout: { ...reply.stdout, message: { ...reply.stdout.message, id: ASTRAY, threadId: WANDERING_THREAD } } };
  const h = harness({ scenario: {
    // A refusal from Google may be the thread's own.
    [`gmail.thread.get ${HALL}`]: { exit: 6 },
    // Answers for another id.
    [`gmail.thread.get ${OTHER_THREAD}`]: mail[`gmail.thread.get ${HALL}`],
    [`gmail.thread.get ${WANDERING_THREAD}`]: mail[`gmail.thread.get ${SWINE}`],
    [`gmail.get ${ELSEWHERE}`]: reply,
    [`gmail.get ${ASTRAY}`]: astray,
    [`gmail.get ${REFUSED}`]: { exit: 6 },
    [`gmail.get ${FAILED}`]: { exit: 1 },
    [`gmail.get ${THROTTLED}`]: { exit: 7 },
    [`gmail.get ${UNAUTHORIZED}`]: { exit: 4 },
    [`gmail.get ${MISUSED}`]: { exit: 2 },
    [`gmail.drafts.get ${DRAFT}`]: { stdout: { draft: { id: DRAFT } } },
    [`gmail.drafts.get ${DRAFT_REFUSED}`]: { exit: 6 },
    [`gmail.drafts.get ${DRAFT_ELSEWHERE}`]: mail[`gmail.drafts.get ${DRAFT}`],
  } });
  const hidden = h.turn({ policy: POLICY(["Label_99"]) });
  const miss = await h.call("brain_google_gmail_read", { target: "thread", id: MISSING }, hidden);
  expect(miss, "GOOGLE_UNKNOWN_REAL_MISS").toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  const cases = [
    ["thread refused by Google", { target: "thread", id: HALL }, { code: "forbidden" }],
    ["thread answered for another id", { target: "thread", id: OTHER_THREAD }, { code: "transport_incompatible", reason: "unexpected_shape" }],
    ["message whose thread cannot be read", { target: "message", id: HALL_REPLY }, { ok: true }],
    ["message whose thread answers for another thread", { target: "message", id: ASTRAY }, { ok: true }],
    ["message answered for another id", { target: "message", id: ELSEWHERE }, { code: "transport_incompatible", reason: "unexpected_shape" }],
    ["message refused by Google", { target: "message", id: REFUSED }, { code: "forbidden" }],
    ["message whose read failed", { target: "message", id: FAILED }, { code: "upstream_error" }],
    ["draft with no message", { target: "draft", id: DRAFT }, { ok: true }],
    ["draft refused by Google", { target: "draft", id: DRAFT_REFUSED }, { code: "forbidden" }],
    ["draft answered for another id", { target: "draft", id: DRAFT_ELSEWHERE }, { code: "transport_incompatible", reason: "unexpected_shape" }],
  ] as const;
  for (const [name, input, open] of cases) {
    expect(await h.call("brain_google_gmail_read", { ...input, view: "structured" }, hidden), `GOOGLE_UNKNOWN_VISIBILITY_IS_A_MISS ${name}`).toEqual(miss);
    // With nothing hidden, the same failure keeps its own answer.
    const shown = await h.call("brain_google_gmail_read", { ...input, view: "structured" });
    expect(shown, `GOOGLE_NOTHING_HIDDEN_KEEPS_ANSWER ${name}`).toMatchObject("ok" in open ? open : { ok: false, error: open });
  }
  // A failure that says nothing about the target keeps its code while a label is hidden.
  for (const [id, error] of [[THROTTLED, { code: "rate_limited" }], [UNAUTHORIZED, { code: "unavailable", reason: "auth_required" }],
    [MISUSED, { code: "transport_incompatible", reason: "usage" }]] as const) {
    expect(await h.call("brain_google_gmail_read", { target: "message", id }, hidden), `GOOGLE_TARGET_INDEPENDENT_KEEPS_CODE ${error.code}`)
      .toMatchObject({ ok: false, error });
  }
  // The owner's full-body route follows the same rule.
  expect(await h.host.messageBody("odysseus", POLICY(["Label_99"]), REFUSED), "GOOGLE_BODY_UNKNOWN_IS_A_MISS")
    .toEqual({ ok: false, error: { code: "not_found", reason: null, message: (miss as { error: { message: string } }).error.message } });
  expect(await h.host.messageBody("odysseus", POLICY(), REFUSED), "GOOGLE_BODY_NOTHING_HIDDEN_KEEPS_CODE").toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await h.host.messageBody("odysseus", POLICY(["Label_99"]), HALL_REPLY), "GOOGLE_BODY_UNREADABLE_THREAD_IS_A_MISS")
    .toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  expect(await h.host.messageBody("odysseus", POLICY(["Label_99"]), ELSEWHERE), "GOOGLE_BODY_OTHER_ID_IS_A_MISS")
    .toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  expect(await h.host.messageBody("odysseus", POLICY(), ELSEWHERE), "GOOGLE_BODY_OTHER_ID_NOTHING_HIDDEN_IS_A_SHAPE")
    .toMatchObject({ ok: false, error: { code: "transport_incompatible", reason: "unexpected_shape" } });
  expect(h.taints, "GOOGLE_UNKNOWN_NOTHING_TAINTED").toEqual([]);
});

/** Every `{ id, name }` a result's `labels` arrays carry, at any depth. */
function labelsIn(value: unknown): { id: string; name: string | null }[] {
  if (Array.isArray(value)) return value.flatMap(labelsIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    key === "labels" && Array.isArray(inner) && inner.every(item => item && typeof item === "object" && "id" in item) ? inner as { id: string; name: string | null }[] : labelsIn(inner));
}

test("label names come from the label list, so a result names labels only where the policy admits reading it", async () => {
  const h = harness();
  // Admitted first, so the account's list is cached when the denied reads run.
  const admitted = await h.call("brain_google_gmail_read", { target: "thread", id: HALL, view: "structured" });
  expect(labelsIn(admitted), "GOOGLE_NAMES_ADMITTED").toContainEqual({ id: "Label_12", name: "Ithaca/Household" });
  const listed = h.fake.callsOf("gmail.labels.list").length;
  expect(listed, "GOOGLE_NAMES_ADMITTED_READ_THE_LIST").toBe(1);
  const denied = h.turn({ policy: resolveGooglePolicy({ enabled: true, account: "ithaca", services: ["gmail"], operations: { "gmail.labels.list": "deny" } }) });
  const reads = [
    ["search", "brain_google_gmail_search", { query: "in:inbox" }],
    ["thread", "brain_google_gmail_read", { target: "thread", id: HALL }],
    ["message", "brain_google_gmail_read", { target: "message", id: HALL_REPLY }],
    ["draft", "brain_google_gmail_read", { target: "draft", id: DRAFT }],
  ] as const;
  for (const view of ["structured", "content"] as const) {
    for (const [name, tool, input] of reads) {
      const result = await h.call(tool, { ...input, view }, denied);
      expect(result, `GOOGLE_NAMES_DENIED_STILL_READS ${name} ${view}`).toMatchObject({ ok: true });
      const labels = labelsIn(result);
      expect(labels.length, `GOOGLE_NAMES_DENIED_KEEPS_LABELS ${name} ${view}`).toBeGreaterThan(0);
      expect(labels.filter(label => label.name !== null), `GOOGLE_NAMES_DENIED_NAMES_NOTHING ${name} ${view}`).toEqual([]);
      if (name !== "draft") expect(labels.map(label => label.id), `GOOGLE_NAMES_DENIED_KEEPS_IDS ${name} ${view}`).toContain("Label_12");
    }
  }
  expect(h.fake.callsOf("gmail.labels.list").length, "GOOGLE_NAMES_DENIED_LIST_NEVER_READ").toBe(listed);
  expect(await h.call("brain_google_gmail_read", { target: "labels" }, denied), "GOOGLE_LABEL_LIST_DENIED")
    .toMatchObject({ ok: false, error: { code: "policy_denied", reason: "operation_denied" } });
});

test("a search cursor is the host's, bound to its conversation and query, and maps to Google's token", async () => {
  const h = harness();
  const first = await h.call("brain_google_gmail_search", { query: "in:inbox", view: "structured" });
  const cursor = first.ok && first.result.kind === "search" ? first.result.next_cursor : null;
  expect(cursor, "GOOGLE_HOST_CURSOR").toMatch(/^gc_[A-Za-z0-9_-]{16,64}$/);
  expect(JSON.stringify(first), "GOOGLE_PAGE_TOKEN_NEVER_RETURNED").not.toContain("09876543210987654321");
  const refused = [
    await h.call("brain_google_gmail_search", { query: "in:inbox", cursor }, h.turn({ session: "sess-aiaia" })),
    await h.call("brain_google_gmail_search", { query: "in:spam", cursor }),
    await h.call("brain_google_gmail_search", { query: "in:inbox", cursor: "gc_not-a-cursor-this-host-made" }),
  ];
  for (const result of refused) expect(result, "GOOGLE_CURSOR_REFUSED").toMatchObject({ ok: false, error: { code: "invalid_input", reason: "cursor" } });
  expect(await h.call("brain_google_gmail_search", { query: "in:inbox", cursor, view: "structured" }), "GOOGLE_CURSOR_ADMITTED").toMatchObject({ ok: true });
  const pages = h.fake.callsOf("gmail.search").map(entry => entry.argv.find(arg => arg.startsWith("--page=")) ?? null);
  expect(pages, "GOOGLE_CURSOR_SENDS_THE_TOKEN").toEqual([null, "--page=09876543210987654321"]);
});

test("the four write tools are listed and answer unavailable, sending nothing", async () => {
  const h = harness();
  const calls: [string, unknown][] = [
    ["brain_google_gmail_modify", { message_ids: [HALL_REPLY], remove_label_ids: ["INBOX"] }],
    ["brain_google_gmail_trash", { thread_ids: [SWINE] }],
    ["brain_google_gmail_draft", { action: "delete", draft_id: DRAFT }],
    ["brain_google_gmail_send", { draft_id: DRAFT }],
  ];
  for (const [tool, input] of calls) {
    const result = await h.call(tool, input);
    expect(result, `GOOGLE_WRITE_UNAVAILABLE ${tool}`).toMatchObject({ ok: false, tool, error: { code: "unavailable", reason: "writes_unavailable" } });
    expect(valid(result)).toBe(true);
  }
  expect(h.gogCalls(), "GOOGLE_WRITES_SEND_NOTHING").toEqual([]);
});

test("the display body reads a message for the owner under the current policy, hidden threads included", async () => {
  const h = harness();
  const body = await h.host.messageBody("odysseus", POLICY(), HALL_REPLY);
  expect(body, "GOOGLE_DETAIL_BODY").toMatchObject({ ok: true, body: { message_id: HALL_REPLY, body_truncated: false } });
  expect(await h.host.messageBody("odysseus", POLICY(["Label_12"]), HALL_REPLY), "GOOGLE_DETAIL_HIDDEN").toMatchObject({ ok: false, error: { code: "not_found", reason: null } });
  expect(h.taints, "GOOGLE_DETAIL_NEVER_TAINTS").toEqual([]);
  const stranger = harness({ principal: "not_owner" });
  expect(await stranger.host.messageBody("circe", POLICY(), HALL_REPLY), "GOOGLE_DETAIL_OWNER_ONLY").toMatchObject({ ok: false, error: { code: "policy_denied", reason: "not_owner" } });
  expect(stranger.gogCalls()).toEqual([]);
});

test("the owner is the owner account the auth mode names: an owner login, or the ambient principal outside proxy mode", () => {
  const at = 1_800_000_000_000;
  const principal = (kind: Principal["kind"], extra: Partial<Principal> = {}): Principal => ({ id: `ithaca-${kind}`, kind, authMethod: kind === "owner" ? "password" : kind === "agent" ? "delegated" : "ambient",
    label: "Ithaca", credentialId: null, createdBy: null, createdAt: at - 1000, expiresAt: at + 60_000, lastSeenAt: null, revokedAt: null, ...extra });
  const rows: [string, Principal | null, "password" | "tailscale" | "proxy" | "none", GooglePrincipalKind][] = [
    ["owner login", principal("owner"), "password", "owner"],
    ["ambient, no auth", principal("ambient"), "none", "owner"],
    ["ambient, tailnet", principal("ambient"), "tailscale", "owner"],
    ["ambient, a proxy's upstream user", principal("ambient"), "proxy", "not_owner"],
    ["delegated agent", principal("agent"), "password", "not_owner"],
    ["system", principal("system"), "password", "not_owner"],
    ["revoked owner", principal("owner", { revokedAt: at - 1 }), "password", "none"],
    ["expired owner", principal("owner", { expiresAt: at - 1 }), "password", "none"],
    ["missing", null, "password", "none"],
  ];
  for (const [label, value, mode, expected] of rows) expect(googlePrincipalKind(value, mode, at), `GOOGLE_PRINCIPAL ${label}`).toBe(expected);
});

test("a target whose thread went away between the two reads reads as a miss", async () => {
  const h = harness({ scenario: { [`gmail.thread.get ${HALL}`]: { exit: 5 } } });
  const miss = await h.call("brain_google_gmail_read", { target: "thread", id: MISSING });
  for (const target of ["message", "draft"] as const) {
    const result = await h.call("brain_google_gmail_read", { target, id: target === "message" ? HALL_REPLY : DRAFT }, h.turn({ policy: POLICY(["Label_99"]) }));
    expect(result, `GOOGLE_AUXILIARY_MISS_READS_AS_A_MISS ${target}`).toEqual(miss);
  }
});

test("every call records one audit line with its operation, view and outcome, and nothing Google returned", async () => {
  const h = harness();
  await h.call("brain_google_gmail_search", { query: "in:inbox", view: "structured" });
  await h.call("brain_google_gmail_read", { target: "thread", id: HALL });
  await h.call("brain_google_gmail_send", { draft_id: DRAFT });
  await h.call("brain_google_gmail_read", { target: "thread", id: "Penelope" });
  const stranger = harness({ principal: "not_owner" });
  await stranger.call("brain_google_gmail_search", { query: "in:inbox" });
  await stranger.host.messageBody("circe", POLICY(), HALL_REPLY, "sess-ithaca");
  const lines = [...h.audits, ...stranger.audits].map(({ scope, ...event }) => ({ ...event, scope }));
  expect(lines, "GOOGLE_AUDIT_EVERY_CALL").toEqual([
    { tool: "brain_google_gmail_search", operation: "gmail.search", view: "structured", outcome: "returned", code: null, reason: null, scope: { turnId: "turn-ithaca", sessionId: "sess-ithaca", actor: "interactive" } },
    { tool: "brain_google_gmail_read", operation: "gmail.thread.get", view: "content", outcome: "returned", code: null, reason: null, scope: { turnId: "turn-ithaca", sessionId: "sess-ithaca", actor: "interactive" } },
    { tool: "brain_google_gmail_send", operation: "gmail.draft.send", view: null, outcome: "refused", code: "unavailable", reason: "writes_unavailable", scope: { turnId: "turn-ithaca", sessionId: "sess-ithaca", actor: "interactive" } },
    { tool: "brain_google_gmail_read", operation: null, view: null, outcome: "refused", code: "invalid_input", reason: "schema", scope: { turnId: "turn-ithaca", sessionId: "sess-ithaca", actor: "interactive" } },
    { tool: "brain_google_gmail_search", operation: "gmail.search", view: null, outcome: "refused", code: "policy_denied", reason: "not_owner", scope: { turnId: "turn-ithaca", sessionId: "sess-ithaca", actor: "interactive" } },
    { tool: "gmail_message_body", operation: "gmail.message.get", view: null, outcome: "refused", code: "policy_denied", reason: "not_owner", scope: { turnId: null, sessionId: "sess-ithaca", actor: "user" } },
  ]);
  for (const word of HALL_TEXT) expect(JSON.stringify(lines), `GOOGLE_AUDIT_HOLDS_NO_CONTENT ${word}`).not.toContain(word);
});

test("an audit that fails and a log that throws change no answer", async () => {
  const fake = createFakeGog(ithacaMail());
  cleanups.push(() => fake.dispose());
  const transport = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment, retryDelayMs: 1 });
  const host = createGoogleToolsHost({ credential: { transport: () => ({ ok: true, transport }) }, principal: () => "owner",
    // A rejection that cannot even be shown as text.
    untrusted: async () => {}, audit: async () => { throw Object.create(null); },
    report: () => { throw new Error("the log is gone"); } });
  const turn: GoogleToolsTurn = { turnId: "turn-ithaca", principalId: "odysseus", sessionId: () => "sess-ithaca", posture: "interactive",
    policy: () => POLICY(), routing: async () => null, tainted: () => false };
  expect(await host.call(turn, { tool: "brain_google_gmail_search", input: { query: "in:inbox", view: "structured" } } as GoogleToolCall), "GOOGLE_AUDIT_FAILURE_KEEPS_ANSWER")
    .toMatchObject({ ok: true, result: { kind: "search" } });
  const broken = { ...turn, policy: () => { throw new Error("policy store gone"); }, routing: async () => { throw new Error("exposures gone"); } };
  expect(await host.call(broken, { tool: "brain_google_gmail_read", input: { target: "labels" } } as GoogleToolCall), "GOOGLE_BROKEN_TURN_STILL_ANSWERS")
    .toMatchObject({ ok: false, error: { code: "unavailable", reason: "policy_invalid" } });
  expect(await host.messageBody("odysseus", POLICY(), HALL_REPLY, "sess-ithaca"), "GOOGLE_AUDIT_FAILURE_KEEPS_BODY").toMatchObject({ ok: true });
  // An input whose reading throws still gets an answer, never a rejection.
  const hostile = { get query(): string { throw Object.create(null); } };
  expect(await host.call(turn, { tool: "brain_google_gmail_search", input: hostile } as unknown as GoogleToolCall).then(answer => answer, () => "rejected"), "GOOGLE_HOSTILE_INPUT_ANSWERS")
    .toMatchObject({ ok: false, tool: "brain_google_gmail_search", error: { code: "upstream_error" } });
  // A turn whose identity cannot be read keeps the answer the call already has.
  const faceless = { ...turn, get turnId(): string { throw Object.create(null); } } as GoogleToolsTurn;
  expect(await host.call(faceless, { tool: "brain_google_gmail_read", input: { target: "labels" } } as GoogleToolCall).then(answer => answer, () => "rejected"), "GOOGLE_FACELESS_TURN_ANSWERS")
    .toMatchObject({ ok: true, result: { kind: "labels" } });
});
