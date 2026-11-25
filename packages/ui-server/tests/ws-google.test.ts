/**
 * The server's own Gmail tools wiring (#4207; plan docs/plans/google-workspace.md
 * §6, §11 "End to end"): createApp builds the host Gmail tools over the host's
 * Google credential, and a first-party backend's turn reaches them through
 * the bridge with the shared toolkit handler, over the real WebSocket
 * handlers. A structured search taints nothing and the session's safety
 * projection stays normal with the call's collector obligation discharged; a
 * content read records `google_result` before its text returns, and a failed
 * record withholds it; a routing refusal sends gog nothing; a principal other
 * than the owner is refused; a hidden-label thread is absent from search and
 * `not_found` on a read.
 *
 * Keyless and offline: the fake gog from packages/common/tests/support only,
 * handed to createApp's internal test seam; the credential home is a fresh
 * directory outside every temp area; the keyring password is a sentinel.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import * as sdk from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFakeGog, type FakeGog } from "../../common/tests/support/fake-gog.ts";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { GOVERNANCE_EVENT_SCHEMAS, queryGovernanceEvents } from "../src/governance/events.js";
import { safetyProjection } from "../src/governance/safety-store.js";
import { HALL, HALL_TEXT, SWINE, ithacaMail, ithacaPolicy } from "./fixtures/google-host-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const SESSION = "sess-ithaca-gmail";
const PASSWORD = "penelope-weaves-by-day-and-unweaves-by-night";
type Result = { ok: boolean; tool: string; result?: Record<string, unknown>; error?: { code: string; reason: string | null; message: string } };
type Call = (tool: string, input: unknown) => Promise<Result>;
// The toolkit handler both backends call, read from the namespace so its absence fails an assertion, not the module load.
const handleGoogleTool = (sdk as Record<string, unknown>).handleGoogleTool as ((name: string, input: unknown, bridge: Pick<BackendBridge, "google">) => Promise<{ text: string; isError: boolean }>) | undefined;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A gog home outside every temp area (the repository's own tmp directory), mode 0700. */
function gogHome(): string {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = realpathSync(mkdtempSync(join(ROOT, "tmp/odysseus-gmail-home-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "gog-home");
  mkdirSync(home, { mode: 0o700 }); chmodSync(home, 0o700);
  return home;
}

async function hostedTurn(backendId: "pi" | "claude", script: (call: Call, bridge: BackendBridge) => Promise<void>,
  options: { policy?: string; principal?: "owner" | "agent"; exposure?: { visible: string; hidden: string };
    inspect?: (app: Awaited<ReturnType<typeof createApp>>) => void | Promise<void>; prepare?: (app: Awaited<ReturnType<typeof createApp>>) => void } = {}) {
  const root = await mkdtemp(), brain = resolve(root, "brain");
  await createFixtureBrain(ROOT, brain);
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), `---\nschema_version: 1\n${options.policy ?? ithacaPolicy()}\n---\nIthaca's Gmail rules.\n`);
  const fake: FakeGog = createFakeGog(ithacaMail());
  cleanups.push(() => fake.dispose());
  const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { BRAIN_UI_GOOGLE_HOME: gogHome(), BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD });
  let finished = false, scriptError: unknown, sequence = 0;
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge }) => {
    await bridge.inputSafety!.ready(backendId, 1);
    bridge.emit({ type: "session_info", sessionId: SESSION, isNew: true });
    try {
      // As a backend runs a tool: admitted and owed before it runs, its result recorded after.
      const call: Call = async (tool, input) => {
        const id = `toolu_ithaca_${sequence++}`, visible = backendId === "claude" ? `mcp__brain-ui__${tool}` : tool;
        const safety = bridge.inputSafety!;
        safety.admitting?.(id, visible);
        await safety.begin(id, visible, input as Readonly<Record<string, unknown>>);
        await safety.allowed?.(id);
        const answer = handleGoogleTool ? await handleGoogleTool(tool, input, bridge)
          : { isError: true, text: JSON.stringify({ ok: false, tool, error: { code: "unavailable", reason: "no_toolkit_handler", message: "" } }) };
        await safety.result(id, visible, answer.text, true);
        return JSON.parse(answer.text) as Result;
      };
      await script(call, bridge);
    } catch (error) { scriptError = error; throw error; }
    finally {
      bridge.emit({ type: "result", sessionId: SESSION, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
      finished = true;
    }
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: "odysseus-gmail-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), googleBinary: fake.binary } as Parameters<typeof createApp>[0]);
  const sent: string[] = [];
  try {
    if (options.exposure) app.db.query("INSERT INTO session_provider_exposure (turn_id, session_id, recipient, visible, hidden, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("turn-earlier", SESSION, "anthropic", options.exposure.visible, options.exposure.hidden, Date.now());
    options.prepare?.(app);
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Odysseus Gmail", ttlSeconds: 60 });
    const principal = options.principal === "agent"
      ? createPrincipal(app.db, { authMethod: "delegated", label: "Eurylochus agent", ttlSeconds: 60, createdBy: owner.id }) : owner;
    const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => { sent.push(text); }, close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Find what Penelope wrote about the suitors", requestId: "gmail-request" }) } as MessageEvent, ws);
    const until = Date.now() + 45_000;
    while (!finished || app.isTurnActive()) {
      if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`);
      await Bun.sleep(10);
    }
    if (scriptError) throw scriptError;
    await options.inspect?.(app);
    const taint = queryGovernanceEvents(app.db, { kinds: ["taint"], limit: 20 }).sort((a, b) => a.id - b.id);
    const audit = queryGovernanceEvents(app.db, { kinds: ["google_call"], limit: 20 }).sort((a, b) => a.id - b.id);
    return { fake, sent, taint, audit, gog: () => fake.calls().map(entry => entry.command) };
  } finally {
    await app.close(); broker.close(); await native.close();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(root, { recursive: true, force: true });
  }
}

async function mkdtemp(): Promise<string> {
  return realpathSync(mkdtempSync(join(tmpdir(), "odysseus-host-gmail-")));
}

const googleTaints = (db: Awaited<ReturnType<typeof createApp>>["db"]) =>
  queryGovernanceEvents(db, { kinds: ["taint"], limit: 20 }).filter(event => event.payload.source === "google_result");

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} structured search taints nothing, keeps the session normal and discharges its obligation`, async () => {
  const results: Result[] = [];
  let owed = -1, projection: ReturnType<typeof safetyProjection> | undefined;
  const outcome = await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_search", { query: "in:inbox", view: "structured" }));
    results.push(await call("brain_google_gmail_read", { target: "thread", id: SWINE, view: "structured" }));
  }, { inspect: app => {
    owed = (app.db.query("SELECT COUNT(*) n FROM safety_obligations").get() as { n: number }).n;
    projection = safetyProjection(app.db, null, SESSION);
  } });
  expect(results.map(result => result.ok ? `${result.result!.kind}:${result.result!.view}` : result.error!.reason), "GMAIL_APP_STRUCTURED_RESULTS")
    .toEqual(["search:structured", "thread:structured"]);
  for (const word of HALL_TEXT) expect(JSON.stringify(results), `GMAIL_APP_STRUCTURED_NO_TEXT ${word}`).not.toContain(word);
  expect(outcome.taint, "GMAIL_APP_STRUCTURED_TAINTS_NOTHING").toEqual([]);
  expect(owed, "GMAIL_APP_OBLIGATION_DISCHARGED").toBe(0);
  expect(projection, "GMAIL_APP_PROJECTION_NORMAL").toMatchObject({ restriction: "normal", unresolvedCount: 0, coverage: { state: "complete" } });
  expect(outcome.gog(), "GMAIL_APP_REACHED_GOG").toContain("gmail.search");
  expect(outcome.audit.map(event => ({ session: event.sessionId, actor: event.actor, ...(event.payload as Record<string, unknown>) }) as Record<string, unknown>), "GMAIL_APP_AUDIT_LINES").toEqual([
    { session: SESSION, actor: "interactive", tool: "brain_google_gmail_search", operation: "gmail.search", view: "structured", outcome: "returned", code: null, reason: null },
    { session: SESSION, actor: "interactive", tool: "brain_google_gmail_read", operation: "gmail.thread.get", view: "structured", outcome: "returned", code: null, reason: null }]);
  expect(outcome.sent.join("\n"), "GMAIL_APP_PASSWORD_NEVER_TO_CLIENT").not.toContain(PASSWORD);
}, 60_000);

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} content read records google_result before its text returns`, async () => {
  const results: Result[] = [];
  const recordedFirst: boolean[] = [];
  let db: Awaited<ReturnType<typeof createApp>>["db"] | undefined;
  const outcome = await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_read", { target: "thread", id: HALL }));
    // Read as the text arrives: the record is already there.
    recordedFirst.push(googleTaints(db!).length === 1);
  }, { prepare: app => {
    db = app.db;
    // A slow record: a host that returned before it settled would be seen here.
    const writes = app.wsHost.activity!.governanceWrites!, original = writes.firstTaint.bind(writes);
    const spy = spyOn(writes, "firstTaint").mockImplementation(async (...args: Parameters<typeof original>) => { await Bun.sleep(150); return original(...args); });
    cleanups.push(() => spy.mockRestore());
  } });
  expect(results[0], "GMAIL_APP_CONTENT_READ").toMatchObject({ ok: true, result: { kind: "thread", view: "content", thread_id: HALL } });
  expect(JSON.stringify(results[0]), "GMAIL_APP_CONTENT_TEXT").toContain(HALL_TEXT[0]);
  expect(recordedFirst, "GMAIL_APP_TAINT_BEFORE_TEXT").toEqual([true]);
  const google = outcome.taint.filter(event => event.payload.source === "google_result");
  expect(google.map(event => ({ session: event.sessionId, tool: event.payload.tool })), "GMAIL_APP_CONTENT_TAINTS_SESSION")
    .toEqual([{ session: SESSION, tool: "brain_google_gmail_read" }]);
  for (const event of google) expect(GOVERNANCE_EVENT_SCHEMAS.taint.payload.parse(event.payload).occurrence).toMatchObject({ exposure: "finalized", admission: { trusted: false } });
}, 60_000);

for (const backendId of ["pi", "claude"] as const) for (const failure of ["rejects", "resolves unrecorded"] as const) test(`a ${backendId} content read whose taint record ${failure} withholds its text`, async () => {
  const results: Result[] = [];
  await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_read", { target: "thread", id: HALL }));
  }, { prepare: app => {
    const writes = app.wsHost.activity!.governanceWrites!, original = writes.firstTaint.bind(writes);
    const spy = spyOn(writes, "firstTaint").mockImplementation(async (...args: Parameters<typeof original>) => {
      if ((args[0] as { payload: { source: string } }).payload.source !== "google_result") return original(...args);
      // The store's answer for a restricted turn whose record was lost: nothing kept, nothing thrown.
      if (failure === "resolves unrecorded") return false;
      throw new Error("safety store refused the Gmail record");
    });
    cleanups.push(() => spy.mockRestore());
  } });
  expect(results[0], "GMAIL_APP_UNRECORDED_WITHHELD").toMatchObject({ ok: false, error: { code: "recording_unavailable" } });
  expect(JSON.stringify(results), "GMAIL_APP_WITHHELD_NO_TEXT").not.toContain(HALL_TEXT[0]);
}, 60_000);

// G2: journal is kept from google; an earlier turn of this conversation showed it.
const ROUTED = `${ithacaPolicy()}\nproviders: [{ paths: [journal/**], allow: [anthropic] }]`;

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} conversation shown a folder kept from google is refused every read, and gog is sent nothing`, async () => {
  const results: Result[] = [];
  const outcome = await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_search", { query: "from:penelope", view: "structured" }));
    results.push(await call("brain_google_gmail_read", { target: "thread", id: HALL }));
  }, { policy: ROUTED, exposure: { visible: '["journal"]', hidden: "[]" } });
  for (const result of results) expect(result, `GMAIL_APP_ROUTING_RESTRICTED ${result.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "recipient_restricted" } });
  expect(outcome.gog(), "GMAIL_APP_ROUTING_SENDS_NOTHING").toEqual([]);
  expect(outcome.taint, "GMAIL_APP_ROUTING_NOTHING_TAINTED").toEqual([]);
}, 60_000);

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} principal other than the owner is refused before anything is sent`, async () => {
  const results: Result[] = [];
  const outcome = await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_search", { query: "from:penelope", view: "structured" }));
    results.push(await call("brain_google_gmail_read", { target: "labels" }));
  }, { principal: "agent" });
  for (const result of results) expect(result, `GMAIL_APP_NOT_OWNER ${result.tool}`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "not_owner" } });
  expect(outcome.gog(), "GMAIL_APP_NOT_OWNER_SENDS_NOTHING").toEqual([]);
  expect(outcome.audit.map(event => [event.payload.outcome, event.payload.reason]), "GMAIL_APP_NOT_OWNER_AUDITED").toEqual([["refused", "not_owner"], ["refused", "not_owner"]]);
}, 60_000);

for (const backendId of ["pi", "claude"] as const) test(`a ${backendId} hidden-label thread is absent from search and not_found on a read, as a real miss reads`, async () => {
  const results: Result[] = [];
  const outcome = await hostedTurn(backendId, async call => {
    results.push(await call("brain_google_gmail_search", { query: "in:inbox", view: "structured" }));
    results.push(await call("brain_google_gmail_read", { target: "thread", id: HALL }));
    results.push(await call("brain_google_gmail_read", { target: "thread", id: "19a0c3d2e4f5ffff" }));
  }, { policy: ithacaPolicy({ hidden: ["Label_12"] }) });
  const threads = (results[0]!.result as { threads: { thread_id: string }[] } | undefined)?.threads.map(hit => hit.thread_id);
  expect(threads, "GMAIL_APP_HIDDEN_ABSENT_FROM_SEARCH").toEqual([SWINE]);
  expect(results[1], "GMAIL_APP_HIDDEN_NOT_FOUND").toEqual({ ok: false, tool: "brain_google_gmail_read",
    error: { code: "not_found", reason: null, message: "No such Gmail thread, message or draft was found." } });
  expect(results[1], "GMAIL_APP_HIDDEN_READS_AS_A_MISS").toEqual(results[2]);
  expect(outcome.taint, "GMAIL_APP_HIDDEN_NOTHING_TAINTED").toEqual([]);
}, 60_000);
