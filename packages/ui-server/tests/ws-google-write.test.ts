import { existsSync } from "node:fs";
import { generateSignedCookie } from "hono/cookie";
import { runCli } from "../../core/tests/cli-harness.js";
import { googleBrainId } from "@schlessera/brain-common/internal/google-ledger";
import { createFakeGog } from "../../common/tests/support/fake-gog.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
/** Both first-party simulated backends through the real WebSocket bridge. No
 * executable Google transport, credentials, network or ambient Google homes. */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { handleGoogleTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { GoogleToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createApp } from "../src/app.js";
import { createUiDb } from "../src/db/client.js";
import { resolveServerConfig } from "../src/config/env.js";
import * as home from "../src/google/home.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { handleChatMessage } from "../src/ws/run-session.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { createGoogleStateWrites } from "../src/google/state-writes.js";
import { GOOGLE_CARD, GOOGLE_MODIFY, googleModifyPrepared } from "./helpers/google-write-fixture.js";

const SESSION = "sess-ithaca-google-write";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
type App = Awaited<ReturnType<typeof createApp>>;
interface Options {
  answer?: "allow" | "edit" | "decline" | "stop" | "always" | "voice-grant";
  principal?: "agent";
  voice?: boolean;
  prepare?: (app: App) => void;
  seed?: (db: Database) => Promise<void>;
  script?: (bridge: BackendBridge) => Promise<GoogleToolResult>;
  startupFailure?: boolean;
  linkedBrain?: boolean;
  explicitLedger?: boolean;
}
async function hosted(backendId: "pi" | "claude", options: Options = {}) {
  await mkdir(resolve("tmp"), { recursive: true });
  const root = await mkdtemp(resolve("tmp/google-ws-")), brain = resolve(root, "brain");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), `---\nschema_version: 1\ngoogle:\n  enabled: true\n  account: ithaca\n  services: [gmail]\n  modes: { reversible: ask }\n---\nIthaca's mail rules.\n`);
  const fake = createFakeGog({ "auth.alias.list": { stdout: { aliases: { ithaca: "odysseus@example.com" } } } });
  fake.environment.home = resolve(root, "google-home");
  await mkdir(fake.environment.home, { mode: 0o700 });
  cleanups.push(() => fake.dispose());
  // The fake resolves identity; no real credential is ever opened.
  const layout = spyOn(home, "googleHostLayout").mockImplementation(input => ({ brainPath: input.brainPath, dbPath: input.dbPath, workerMounts: [], transportReads: [] }));
  cleanups.push(() => layout.mockRestore());
  const previous = process.env.BRAIN_UI_GOOGLE_HOME;
  process.env.BRAIN_UI_GOOGLE_HOME = fake.environment.home;
  const password = process.env.BRAIN_UI_GOOGLE_KEYRING_PASSWORD;
  process.env.BRAIN_UI_GOOGLE_KEYRING_PASSWORD = fake.environment.keyringPassword;
  cleanups.push(() => { if (password === undefined) delete process.env.BRAIN_UI_GOOGLE_KEYRING_PASSWORD; else process.env.BRAIN_UI_GOOGLE_KEYRING_PASSWORD = password; });
  cleanups.push(() => { if (previous === undefined) delete process.env.BRAIN_UI_GOOGLE_HOME; else process.env.BRAIN_UI_GOOGLE_HOME = previous; });
  await mkdir(resolve(root, "data"), { mode: 0o700 });
  const dbPath = resolve(root, "data/ui.db");
  const savedLedger = process.env.BRAIN_GOOGLE_LEDGER;
  const ledgerPath = options.explicitLedger ? resolve(root, "shared-ledger.sqlite") : dbPath + ".google-ledger.sqlite";
  if (options.explicitLedger) process.env.BRAIN_GOOGLE_LEDGER = ledgerPath; else delete process.env.BRAIN_GOOGLE_LEDGER;
  cleanups.push(() => { if (savedLedger === undefined) delete process.env.BRAIN_GOOGLE_LEDGER; else process.env.BRAIN_GOOGLE_LEDGER = savedLedger; });
  if (options.linkedBrain) await symlink(brain, resolve(root, "brain-link"));
  const brainPath = options.linkedBrain ? resolve(root, "brain-link") + "/" : brain;
  if (options.seed || options.startupFailure) {
    const db = createUiDb(dbPath);
    try {
      await options.seed?.(db);
      if (options.startupFailure) db.exec("CREATE TRIGGER google_startup_failure BEFORE DELETE ON google_send_locks BEGIN SELECT RAISE(ABORT,'google startup injected'); END");
    } finally { db.close(); }
  }
  let result: GoogleToolResult | undefined, scriptError: unknown, finished = false, dispatches = 0, prepares = 0;
  let app!: App;
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge }) => {
    await bridge.inputSafety!.ready(backendId, 1);
    bridge.emit({ type: "session_info", sessionId: SESSION, isNew: true });
    try {
      if (options.script) result = await options.script(bridge);
      else {
        const safety = bridge.inputSafety!, tool = GOOGLE_MODIFY.tool, id = "toolu_google_modify";
        safety.admitting?.(id, tool); await safety.begin(id, tool, GOOGLE_MODIFY.input); await safety.allowed?.(id);
        const answer = await handleGoogleTool(tool, GOOGLE_MODIFY.input, bridge);
        result = JSON.parse(answer.text);
        await safety.result(id, tool, answer.text, true);
      }
    } catch (cause) { scriptError = cause; }
    finally { bridge.emit({ type: "result", sessionId: SESSION, outcome: "success", durationMs: 1, numTurns: 1, isError: false }); finished = true; }
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brainPath, DB_PATH: dbPath,
    HOST: "127.0.0.1", AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("Odysseus strings the bow"),
    COOKIE_SECRET: "odysseus-google-write-cookie-secret", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    googleBinary: fake.binary, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(),
    googlePreparedWrites: { "gmail.modify": async (_, call) => {
      prepares++;
      return googleModifyPrepared(call, () => {
        // T5: inspect committed storage at the actual transport boundary.
        expect(app.db.query("SELECT state FROM google_inverses WHERE session_id=?").get(SESSION), "GOOGLE_WS_INVERSE_BEFORE_DISPATCH").toEqual({ state: "prepared" });
        expect(queryGovernanceEvents(app.db, { kinds: ["google_reversible_action"], limit: 10 }).some(e => e.sessionId === SESSION && e.payload.decision === "approved"), "GOOGLE_WS_DECISION_BEFORE_DISPATCH").toBe(true);
        dispatches++;
      });
    } } });
  cleanups.push(async () => { await app.close(); broker.close(); await native.close(); });
  options.prepare?.(app);
  const owner = createPrincipal(app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 });
  const principal = options.principal === "agent" ? createPrincipal(app.db, { authMethod: "delegated", label: "Eurylochus", ttlSeconds: 60, createdBy: owner.id }) : owner;
  const sent: Array<Record<string, unknown>> = [], cards: Array<Record<string, unknown>> = [], answered = new Set<unknown>();
  const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => sent.push(JSON.parse(text)), close() {}, readyState: 1 } as unknown as WSContext;
  await handlers.onOpen(undefined as never, ws);
  const send = (frame: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  if (options.voice) {
    const authorization = app.wsHost.coordinator.openAuthorization({ principalId: principal.id, expiresAt: principal.expiresAt, valid: app.wsHost.isPrincipalValid(principal) });
    void handleChatMessage(app.wsHost, ws, { authorization, text: "Archive the message about the hall", attachments: [], requestId: "voice-google",
      work: { posture: "voice", started() {}, observe() {}, settle() {} } }).finally(() => { authorization.release(); finished = true; });
  } else send({ type: "chat_message", text: "Archive the message about the hall", requestId: "google-write" });
  const until = Date.now() + watchdogMs(45_000);
  while (!finished || app.isTurnActive()) {
    if (Date.now() > until) throw new Error(`google write turn timed out: ${JSON.stringify(sent)}`);
    for (const frame of sent) {
      if (frame.type !== "tool_approval_request" || answered.has(frame.toolUseId)) continue;
      answered.add(frame.toolUseId); cards.push(frame);
      const ending = options.answer ?? "allow";
      if (ending === "voice-grant") {
        send({ type: "tool_approval", toolUseId: frame.toolUseId, turnId: frame.turnId, channel: "voice", always: true });
        await Bun.sleep(20);
        expect(dispatches, "GOOGLE_VOICE_CANNOT_GRANT").toBe(0);
        expect(app.wsHost.coordinator.pendingApprovals.has(String(frame.toolUseId)), "GOOGLE_VOICE_LEAVES_CARD_PENDING").toBe(true);
        send({ type: "tool_denial", toolUseId: frame.toolUseId, turnId: frame.turnId, channel: "card", message: "Keep the message" });
      } else if (ending === "stop") send({ type: "cancel", sessionId: SESSION });
      else send({ toolUseId: frame.toolUseId, turnId: frame.turnId, channel: "card", type: ending === "decline" ? "tool_denial" : "tool_approval",
        ...(ending === "always" ? { always: true } : {}),
        ...(ending === "decline" ? { message: "Keep it in the inbox" } : {}),
        ...(ending === "edit" ? { updatedInput: { ...(frame.input as object), payload: { ...GOOGLE_CARD.payload, message_ids: ["19a0c3d2e4f50602"] } } } : {}) });
    }
    await Bun.sleep(10);
  }
  if (options.answer === "stop" && cards[0]) {
    send({ type: "tool_approval", toolUseId: cards[0].toolUseId, turnId: cards[0].turnId, channel: "card" });
    await Bun.sleep(20);
    expect(dispatches, "GOOGLE_LATE_APPROVAL_AFTER_STOP_CANNOT_DISPATCH").toBe(0);
  }
  if (scriptError) throw scriptError;
  return { app, result, cards, dispatches, prepares, sent, brain, brainPath, dbPath, ledgerPath, owner };
}
for (const backend of ["claude", "pi"] as const) {
  test(`google ${backend} WebSocket exact card commits decision and inverse before one invocation`, async () => {
    const f = await hosted(backend, { prepare: app => {
      const state = app.wsHost.googleState!, original = state.commitGoogleDecision;
      state.commitGoogleDecision = async (...args) => { await Bun.sleep(50); return original(...args); };
    } });
    expect(f.result, "GOOGLE_WS_SUCCESS").toMatchObject({ ok: true, operation: "gmail.modify", admission: "card", result: GOOGLE_CARD.payload });
    expect(f.cards, "GOOGLE_WS_ONE_CARD").toHaveLength(1);
    expect(f.cards[0]).toMatchObject({ kind: "google", input: { ...GOOGLE_CARD, offers: { allow_always: true, allow_for_session: false } } });
    expect(f.dispatches, "GOOGLE_WS_SINGLE_DISPATCH").toBe(1);
  }, 60_000);
  test(`google ${backend} WebSocket voice shows no needed card and dispatches nothing`, async () => {
    const f = await hosted(backend, { voice: true });
    if (backend === "pi") expect(f.sent.some(frame => frame.type === "error" && String(frame.message).includes("no voice tool posture")), "GOOGLE_PI_VOICE_ADMISSION_REFUSAL").toBe(true);
    else expect(f.result, "GOOGLE_WS_VOICE_REFUSAL").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
    expect(f.cards, "GOOGLE_WS_VOICE_NO_CARD").toHaveLength(0); expect(f.dispatches).toBe(0);
  }, 60_000);
  for (const answer of ["edit", "decline", "stop"] as const) test(`google ${backend} WebSocket ${answer} refuses without dispatch`, async () => {
    const f = await hosted(backend, { answer });
    expect(f.result, "GOOGLE_WS_DECLINED").toMatchObject({ ok: false });
    expect(f.dispatches, "GOOGLE_WS_DECLINED_NO_DISPATCH").toBe(0); expect(f.cards).toHaveLength(1);
  }, 60_000);
  for (const table of ["governance_events", "google_inverses"]) test(`google ${backend} WebSocket failing ${table} commit refuses dispatch`, async () => {
    const f = await hosted(backend, { prepare: app => app.db.exec(`CREATE TRIGGER fail_google BEFORE INSERT ON ${table}
      ${table === "governance_events" ? "WHEN NEW.kind='google_reversible_action'" : ""} BEGIN SELECT RAISE(ABORT,'google record injected'); END`) });
    expect(f.result, "GOOGLE_WS_RECORD_FAILURE").toMatchObject({ ok: false, error: { reason: "recording_unavailable" } });
    expect(f.dispatches).toBe(0);
  }, 60_000);
  test(`google ${backend} WebSocket non-owner refuses before preparation and card`, async () => {
    const f = await hosted(backend, { principal: "agent" });
    expect(f.result).toMatchObject({ ok: false, error: { reason: "not_owner" } });
    expect(f.prepares).toBe(0); expect(f.cards).toHaveLength(0); expect(f.dispatches).toBe(0);
  }, 60_000);
}
const seedLock = async (db: Database) => {
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('old-google',1,1)").run();
  const at = Date.now();
  await createGoogleStateWrites(db).acquireSendLock({ sessionId: "old-google", turnId: "old-turn", principalId: "odysseus", brainId: "brain", account: "ithaca",
    draftId: "r123", cardId: "old-card", hostEpoch: "old-host", createdAt: at, expiresAt: at + 60_000 });
};
test("google real app startup clears abandoned send locks before admitting a write", async () => {
  const f = await hosted("pi", { seed: seedLock, prepare: app => {
    expect(app.db.query("SELECT COUNT(*) n FROM google_send_locks").get(), "GOOGLE_APP_STARTUP_CLEARS_LOCKS").toEqual({ n: 0 });
  } });
  expect(f.result).toMatchObject({ ok: true });
}, 60_000);
test("google real app startup failure contains writes, leaves reads usable, and retries cleanup", async () => {
  const f = await hosted("pi", { seed: seedLock, startupFailure: true, prepare: app => {
    const transport = spyOn(app.wsHost.google!, "transport").mockReturnValue({ ok: true, transport: { execute: async () => ({ ok: true, value: [] }) } } as never);
    cleanups.push(() => transport.mockRestore());
  }, script: async bridge => {
    expect(await bridge.google!({ tool: "brain_google_gmail_read", input: { target: "labels", view: "structured" } }), "GOOGLE_STARTUP_FAILURE_READS_WORK").toMatchObject({ ok: true });
    return bridge.google!(GOOGLE_MODIFY);
  } });
  expect(f.result).toMatchObject({ ok: false, error: { reason: "state_unavailable" } });
  expect(f.cards).toHaveLength(0); expect(f.dispatches).toBe(0);
  f.app.db.exec("DROP TRIGGER google_startup_failure");
  const until = Date.now() + watchdogMs(5_000);
  while ((f.app.db.query("SELECT COUNT(*) n FROM google_send_locks").get() as { n: number }).n > 0) {
    if (Date.now() > until) throw new Error("Google startup did not recover");
    await Bun.sleep(20);
  }
}, 60_000);

for (const backend of ["pi", "claude"] as const) test(`google ${backend} voice-attributed standing choice never grants`, async () => {
  const f = await hosted(backend, { answer: "voice-grant" });
  expect(f.result).toMatchObject({ ok: false, error: { reason: "declined" } });
});

test("google symlinked host grant is listed and revoked by the CLI", async () => {
  const f = await hosted("pi", { answer: "always", linkedBrain: true, explicitLedger: true });
  expect(f.result).toMatchObject({ ok: true, admission: "card" });
  expect(existsSync(f.ledgerPath), "GOOGLE_CONFIGURED_LEDGER_USED").toBe(true);
  const env = { HOME: process.env.HOME!, BRAIN_GOOGLE_LEDGER: f.ledgerPath };
  const listed = await runCli(f.brain, ["google", "approvals", "--json"], env);
  expect(listed.code, listed.stderr).toBe(0);
  const approvals = JSON.parse(listed.stdout).data.approvals;
  expect(approvals, "GOOGLE_HOST_CLI_CANONICAL_ID").toHaveLength(1);
  expect(approvals[0].brain_id).toBe(googleBrainId(f.brain));
  const revoked = await runCli(f.brain, ["google", "revoke", approvals[0].id, "--json"], env);
  expect(revoked.code, revoked.stderr).toBe(0);
  expect(JSON.parse(revoked.stdout).data.revoked, "GOOGLE_HOST_CLI_REVOKE").toBe(true);
  const cookie = (await generateSignedCookie("brain_ui_session", f.owner.id, "odysseus-google-write-cookie-secret")).split(";")[0]!;
  const response = await f.app.fetch(new Request("http://localhost/api/google/approvals", { headers: { cookie } }));
  expect(await response.json()).toEqual({ approvals: [] });
});
test("google real app HTTP ownership refuses agents and other session owners", async () => {
  const f = await hosted("pi");
  const other = createPrincipal(f.app.db, { authMethod: "password", label: "Penelope", ttlSeconds: 60 });
  const agent = createPrincipal(f.app.db, { authMethod: "delegated", label: "Eurylochus", ttlSeconds: 60, createdBy: f.owner.id });
  f.app.db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES('aeaea-agent',1,1)").run();
  f.app.db.query("INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES('aeaea-agent',?,1)").run(agent.id);
  const get = async (id: string, path: string) => {
    const cookie = (await generateSignedCookie("brain_ui_session", id, "odysseus-google-write-cookie-secret")).split(";")[0]!;
    return f.app.fetch(new Request("http://localhost" + path, { headers: { cookie } }));
  };
  expect((await get(agent.id, "/api/google/approvals")).status, "GOOGLE_REAL_HTTP_NON_OWNER").toBe(403);
  expect((await get(other.id, "/api/sessions/aeaea-agent/google/allowances")).status, "GOOGLE_REAL_HTTP_OTHER_SESSION").toBe(404);
  expect((await get(f.owner.id, `/api/sessions/${SESSION}/google/allowances`)).status).toBe(200);
});
