/**
 * The server's own GitHub tools wiring (#3797): createApp builds the host
 * GitHub tools from `BRAIN_UI_GITHUB_TOOLS_TOKEN` alone, and a first-party
 * backend's turn reaches them through the bridge. The loopback stand-in
 * receives the dedicated credential; the session's taint is recorded as
 * `github_result`; no client frame and no subprocess environment carries
 * the credential; with only `GITHUB_TOKEN` set the tools answer
 * `unavailable` and send nothing. Writes (#3798) take their allow-list from
 * the turn's admitted governance policy and their card from the turn's own
 * approval surface, and are recorded as `outward_action`. Reads and searches
 * are routed (G2, #4029) under the turn's policy and the conversation's
 * recorded exposures; writes are not, their card is the gate.
 *
 * Keyless and offline: the fixed API origin is routed to a loopback fake
 * after the network preload; the tokens are synthetic sentinels.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GithubToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig, subprocessEnv } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { GOVERNANCE_EVENT_SCHEMAS, queryGovernanceEvents } from "../src/governance/events.js";
import { GENERIC_GITHUB_SENTINEL, GITHUB_TOOLS_POSTER, GITHUB_TOOLS_SENTINEL, fakeGithub, routeGithubApi } from "./fixtures/github-host-fixture.js";

const SESSION = "sess-ithaca-github";

async function hostedTurn(backendId: "pi" | "claude", env: Record<string, string>, script: (github: (tool: string, input: unknown) => Promise<GithubToolResult>) => Promise<void>,
  options: { policy?: string; answer?: (request: Record<string, unknown>) => Record<string, unknown>; exposure?: { visible: string; hidden: string } } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-github-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  if (options.policy !== undefined) {
    await mkdir(resolve(brain, "context/policies"), { recursive: true });
    await writeFile(resolve(brain, "context/policies/governance.md"), `---\nschema_version: 1\n${options.policy}\n---\nIthaca's outward rules.\n`);
  }
  const fake = fakeGithub(), restore = routeGithubApi(fake);
  const names = ["BRAIN_UI_GITHUB_TOOLS_TOKEN", "GITHUB_TOKEN"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, env);
  let finished = false, scriptError: unknown;
  const workerEnvs: Array<Record<string, string | undefined>> = [];
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge }) => {
    await bridge.inputSafety!.ready(backendId, 1);
    bridge.emit({ type: "session_info", sessionId: SESSION, isNew: true });
    try {
      await script(async (tool, input) => bridge.github!({ tool: tool as never, input: input as never }));
      // Every subprocess audience, and the operator escape hatch naming the credential.
      process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA = "BRAIN_UI_GITHUB_TOOLS_TOKEN";
      for (const audience of ["agent", "cron", "brainCli"] as const) workerEnvs.push(subprocessEnv(audience, {}, ["BRAIN_UI_GITHUB_TOOLS_TOKEN"]));
      delete process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA;
    } catch (error) { scriptError = error; throw error; }
    finally {
      bridge.emit({ type: "result", sessionId: SESSION, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      finished = true;
    }
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: "odysseus-github-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  const sent: string[] = [];
  try {
    // What an earlier turn of this conversation showed its recipient, as the governed turn records it.
    if (options.exposure) app.db.query("INSERT INTO session_provider_exposure (turn_id, session_id, recipient, visible, hidden, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("turn-earlier", SESSION, "anthropic", options.exposure.visible, options.exposure.hidden, Date.now());
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus GitHub", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => { sent.push(text); }, close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Look up the suitors issue", requestId: "github-request" }) } as MessageEvent, ws);
    const until = Date.now() + 45_000, answered = new Set<string>(), cards: Array<Record<string, unknown>> = [];
    while (!finished || app.isTurnActive()) {
      if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`);
      // Answer each approval card the client is shown, as the user would.
      for (const frame of sent.map(text => JSON.parse(text) as Record<string, unknown>)) {
        if (frame.type !== "tool_approval_request" || answered.has(String(frame.toolUseId))) continue;
        answered.add(String(frame.toolUseId)); cards.push(frame);
        const answer = options.answer?.(frame) ?? { type: "tool_denial", message: "No card was expected." };
        handlers.onMessage({ data: JSON.stringify({ toolUseId: frame.toolUseId, turnId: frame.turnId, channel: "card", ...answer }) } as MessageEvent, ws);
      }
      await Bun.sleep(10);
    }
    if (scriptError) throw scriptError;
    const taint = queryGovernanceEvents(app.db, { kinds: ["taint"], limit: 10 }).sort((a, b) => a.id - b.id);
    const outward = queryGovernanceEvents(app.db, { kinds: ["outward_action"], limit: 10 }).sort((a, b) => a.id - b.id);
    return { root, fake, sent, taint, outward, cards, workerEnvs };
  } finally {
    await app.close(); broker.close(); await native.close();
    restore(); fake.stop();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
}

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} turn reads through the host with the dedicated credential, and the session is tainted`, async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn(backendId, { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL, GITHUB_TOKEN: GENERIC_GITHUB_SENTINEL }, async github => {
    results.push(await github("brain_github_issue_read", { repository: "odysseus/ithaca", number: 7 }));
    results.push(await github("brain_github_issue_read", { repository: "odysseus/ithaca", number: 8 }));
    results.push(await github("brain_github_issue_search", { repository: "odysseus/ithaca", query: "stores", kind: "any", state: "any", limit: 10 }));
  });
  try {
    expect(results.map(result => result.ok ? (result.result as { kind: string }).kind : result.error.code), "GITHUB_APP_WIRING").toEqual(["issue", "pull_request", "search"]);
    expect(outcome.fake.seen.length).toBeGreaterThan(5);
    expect(new Set(outcome.fake.seen.map(request => request.authorization)), "GITHUB_STAND_IN_RECEIVED_DEDICATED_CREDENTIAL").toEqual(new Set([`Bearer ${GITHUB_TOOLS_SENTINEL}`]));
    expect(outcome.taint.map(event => ({ session: event.sessionId, source: event.payload.source, tool: event.payload.tool })), "GITHUB_READ_TAINTS_SESSION").toEqual([
      { session: SESSION, source: "github_result", tool: "brain_github_issue_read" }, { session: SESSION, source: "github_result", tool: "brain_github_issue_read" },
      { session: SESSION, source: "github_result", tool: "brain_github_issue_search" }]);
    for (const event of outcome.taint) expect(GOVERNANCE_EVENT_SCHEMAS.taint.payload.parse(event.payload).occurrence).toMatchObject({ exposure: "finalized", admission: { trusted: false } });
    for (const env of outcome.workerEnvs) expect(Object.values(env), "GITHUB_TOOLS_TOKEN_IN_NO_SUBPROCESS_ENV").not.toContain(GITHUB_TOOLS_SENTINEL);
    expect(outcome.sent.join("\n"), "GITHUB_SENTINEL_NEVER_SENT_TO_CLIENT").not.toContain(GITHUB_TOOLS_SENTINEL);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

test("with only GITHUB_TOKEN set the read tools answer unavailable, send nothing and taint nothing", async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn("claude", { GITHUB_TOKEN: GENERIC_GITHUB_SENTINEL }, async github => {
    results.push(await github("brain_github_issue_read", { repository: "odysseus/ithaca", number: 7 }));
    results.push(await github("brain_github_issue_search", { repository: "odysseus/ithaca", query: "stores", kind: "any", state: "any", limit: 10 }));
  });
  try {
    for (const result of results) expect(result, "GITHUB_NO_FALLBACK_TO_GITHUB_TOKEN").toMatchObject({ ok: false, error: { code: "unavailable", reason: "no_credential" } });
    expect(outcome.fake.seen).toEqual([]);
    expect(outcome.taint).toEqual([]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

const POLICY = 'outward: { github: { repositories: ["odysseus/ithaca"] } }';
const ISSUE = { repository: "odysseus/ithaca", title: "Bar the hall doors", body: "Before the contest of the bow.", labels: ["household"] };

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} turn files an allowed issue after one card from the turn's policy, and is refused outside it before any card`, async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn(backendId, { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    results.push(await github("brain_github_issue_create", { ...ISSUE, repository: "circe/aiaia" }));
    results.push(await github("brain_github_issue_create", ISSUE));
  }, { policy: POLICY, answer: () => ({ type: "tool_approval" }) });
  try {
    expect(results[0], "GITHUB_APP_OUTSIDE_LIST_REFUSED").toMatchObject({ ok: false, error: { code: "policy_denied", reason: "repository_not_allowed" } });
    expect(results[1], "GITHUB_APP_ALLOWED_WRITE").toMatchObject({ ok: true, result: { kind: "issue_created", repository: "odysseus/ithaca", number: 42 } });
    expect(outcome.cards.length, "GITHUB_APP_ONE_CARD").toBe(1);
    expect(outcome.cards[0], "GITHUB_APP_CARD_EXACT").toMatchObject({ input: ISSUE });
    expect(outcome.fake.seen.map(request => [request.method, request.path]), "GITHUB_APP_ONE_REQUEST").toEqual([["POST", "/repos/odysseus/ithaca/issues"]]);
    expect(outcome.outward.map(event => ({ session: event.sessionId, action: event.payload.action, target: event.payload.target, decision: event.payload.decision })), "GITHUB_APP_OUTWARD_RECORDED").toEqual([
      { session: SESSION, action: "gh_write", target: "circe/aiaia", decision: "refused" }, { session: SESSION, action: "gh_write", target: "odysseus/ithaca", decision: "approved" }]);
    for (const event of outcome.outward) GOVERNANCE_EVENT_SCHEMAS.outward_action.payload.parse(event.payload);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} comment card carries the host's verified poster and target kind, and nothing the model receives does (#4154)`, async () => {
  const results: GithubToolResult[] = [];
  const comment = { repository: "odysseus/ithaca", number: 8, body: "The bow is strung." };
  const outcome = await hostedTurn(backendId, { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    results.push(await github("brain_github_issue_comment", comment));
  }, { policy: POLICY, answer: () => ({ type: "tool_approval" }) });
  try {
    expect(results[0], "GITHUB_APP_COMMENT_POSTED").toMatchObject({ ok: true, result: { kind: "comment_created", number: 8 } });
    expect(outcome.cards.map(card => [card.input, card.display]), "GITHUB_APP_COMMENT_DISPLAY").toEqual([[comment,
      { github: { poster: { login: GITHUB_TOOLS_POSTER, is_bot: false }, target: { kind: "pull_request", html_url: "https://github.com/odysseus/ithaca/pull/8" } } }]]);
    expect(JSON.stringify(results), "GITHUB_APP_DISPLAY_NOT_RETURNED").not.toContain(GITHUB_TOOLS_POSTER);
    const elsewhere = outcome.sent.filter(text => (JSON.parse(text) as { type: string }).type !== "tool_approval_request");
    expect(elsewhere.filter(text => text.includes(GITHUB_TOOLS_POSTER)), "GITHUB_APP_DISPLAY_ONLY_ON_THE_CARD").toEqual([]);
    expect(outcome.outward.map(event => JSON.parse(String(event.payload.input))), "GITHUB_APP_DISPLAY_NOT_RECORDED").toEqual([comment]);
    // The two lookups run together, so their order is not a fact; the one write follows both.
    const requests = outcome.fake.seen.map(request => `${request.method} ${request.path}`);
    expect([...requests.slice(0, 2)].sort(), "GITHUB_APP_DISPLAY_LOOKUPS").toEqual(["GET /repos/odysseus/ithaca/issues/8", "GET /user"]);
    expect(requests.slice(2), "GITHUB_APP_THEN_ONE_WRITE").toEqual(["POST /repos/odysseus/ithaca/issues/8/comments"]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

test("without a governance policy entry a write is refused before any card and sends nothing", async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn("claude", { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    results.push(await github("brain_github_issue_create", ISSUE));
    results.push(await github("brain_github_issue_comment", { repository: "odysseus/ithaca", number: 7, body: "Counted." }));
  }, { answer: () => ({ type: "tool_approval" }) });
  try {
    for (const result of results) expect(result, "GITHUB_APP_NO_LIST_REFUSED").toMatchObject({ ok: false, error: { code: "policy_denied", reason: "repository_not_allowed" } });
    expect(outcome.cards).toEqual([]);
    expect(outcome.fake.seen).toEqual([]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

// G2 (#4029): journal is kept from github; an earlier turn of this conversation showed it.
const ROUTED_POLICY = `${POLICY}\nproviders: [{ paths: [journal/**], allow: [anthropic] }]`;
const READS = [["brain_github_issue_read", { repository: "odysseus/ithaca", number: 7 }],
  ["brain_github_issue_search", { repository: "odysseus/ithaca", query: "the suitors' feast", kind: "any", state: "any", limit: 10 }]] as const;

test("a conversation shown a folder kept from github is refused every read and search, sends nothing, and still files a write through its card", async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn("claude", { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    for (const [tool, input] of READS) results.push(await github(tool, input));
    results.push(await github("brain_github_issue_create", ISSUE));
  }, { policy: ROUTED_POLICY, exposure: { visible: '["journal"]', hidden: "[]" }, answer: () => ({ type: "tool_approval" }) });
  try {
    for (const result of results.slice(0, 2)) expect(result, `GITHUB_APP_ROUTING_RESTRICTED ${result.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "recipient_restricted" } });
    expect(outcome.taint, "GITHUB_APP_ROUTING_NOTHING_TAINTED").toEqual([]);
    // The write is not routed: its card shows exactly what is sent, and only it reaches GitHub.
    expect(results[2], "GITHUB_APP_WRITE_NOT_ROUTED").toMatchObject({ ok: true, result: { kind: "issue_created", repository: "odysseus/ithaca" } });
    expect(outcome.cards.map(card => card.input), "GITHUB_APP_WRITE_CARD_UNDER_ROUTING").toEqual([ISSUE]);
    expect(outcome.fake.seen.map(request => [request.method, request.path]), "GITHUB_APP_ROUTING_ONLY_THE_WRITE_SENT").toEqual([["POST", "/repos/odysseus/ithaca/issues"]]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

test("a conversation whose exposure cannot be judged under a policy restricting github is refused, and sends nothing", async () => {
  const results: GithubToolResult[] = [];
  // A record the server cannot read says nothing it could trust about what was shown.
  const outcome = await hostedTurn("claude", { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    for (const [tool, input] of READS) results.push(await github(tool, input));
  }, { policy: ROUTED_POLICY, exposure: { visible: "journal", hidden: "[]" } });
  try {
    for (const result of results) expect(result, `GITHUB_APP_ROUTING_UNPROVEN ${result.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "recipient_unproven" } });
    expect(outcome.fake.seen, "GITHUB_APP_ROUTING_UNPROVEN_NOTHING_SENT").toEqual([]);
    expect(outcome.taint).toEqual([]);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);

test("a conversation that showed github no restricted folder reads as before under the same policy", async () => {
  const results: GithubToolResult[] = [];
  const outcome = await hostedTurn("claude", { BRAIN_UI_GITHUB_TOOLS_TOKEN: GITHUB_TOOLS_SENTINEL }, async github => {
    for (const [tool, input] of READS) results.push(await github(tool, input));
  }, { policy: ROUTED_POLICY, exposure: { visible: '["journal"]', hidden: '["journal"]' } });
  try {
    expect(results.map(result => result.ok ? (result.result as { kind: string }).kind : result.error.reason), "GITHUB_APP_ROUTING_ADMITTED").toEqual(["issue", "search"]);
    expect(outcome.fake.seen.length).toBeGreaterThan(1);
  } finally { await rm(outcome.root, { recursive: true, force: true }); }
}, 60_000);
