/**
 * The server's own GitHub tools wiring (#3797): createApp builds the host
 * GitHub tools from `BRAIN_UI_GITHUB_TOOLS_TOKEN` alone, and a first-party
 * backend's turn reaches them through the bridge. The loopback stand-in
 * receives the dedicated credential; the session's taint is recorded as
 * `github_result`; no client frame and no subprocess environment carries
 * the credential; with only `GITHUB_TOKEN` set the tools answer
 * `unavailable` and send nothing.
 *
 * Keyless and offline: the fixed API origin is routed to a loopback fake
 * after the network preload; the tokens are synthetic sentinels.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { GENERIC_GITHUB_SENTINEL, GITHUB_TOOLS_SENTINEL, fakeGithub, routeGithubApi } from "./fixtures/github-host-fixture.js";

const SESSION = "sess-ithaca-github";

async function hostedTurn(backendId: "pi" | "claude", env: Record<string, string>, script: (github: (tool: string, input: unknown) => Promise<GithubToolResult>) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-github-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
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
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus GitHub", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => { sent.push(text); }, close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Look up the suitors issue", requestId: "github-request" }) } as MessageEvent, ws);
    const until = Date.now() + 45_000;
    while (!finished || app.isTurnActive()) { if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`); await Bun.sleep(10); }
    if (scriptError) throw scriptError;
    const taint = queryGovernanceEvents(app.db, { kinds: ["taint"], limit: 10 }).sort((a, b) => a.id - b.id);
    return { root, fake, sent, taint, workerEnvs };
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
