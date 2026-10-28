import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { WsHost } from "../src/ws/host.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";

test("host admission, tool completion and terminal observation produce scoped retained receipts and authenticated raw routes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-journal-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  await writeFile(resolve(brain, "notes/journal.md"), "Ithaca\r\n");
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), "---\nschema_version: 1\nprofiles: { interactive: governed, voice: governed }\n---\nAthena reviews policy.\n");
  let release: () => void = () => {}, called = 0;
  const history: SessionHistoryMessage[] = [];
  const backend = makeFakeBackend({ id: "journal-fixture", histories: { "sess-ithaca": history }, startTurn: async ({ bridge, prompt }) => {
    called++;
    history.push({ role: "user", content: prompt, toolCalls: [] });
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    await writeFile(resolve(brain, "notes/journal.md"), "Athena\r\n");
    bridge.emit({ type: "tool_result", toolUseId: "loom", output: "Recorded", isError: false });
    // Exact native guard error/frame shape; adapter guard execution is proved
    // separately in its own source tests. The actual host retains it unchanged.
    bridge.emit({type:"tool_use_start",toolUseId:"toolu_ithaca_write",toolName:"Write"});
    bridge.emit({type:"tool_use_complete",toolUseId:"toolu_ithaca_write",toolName:"Write",input:{file_path:resolve(brain,"notes/journal.md"),content:"Odysseus overwrites.\n"}});
    bridge.emit({type:"tool_result",toolUseId:"toolu_ithaca_write",output:"File changed since you read it; read it again before writing. Nothing was written.",isError:true});
    await new Promise<void>(resolve => { release = resolve; });
    await writeFile(resolve(brain, "notes/journal.md"), "Penelope\r\n");
    history.push({ role: "assistant", content: "The return is recorded.", toolCalls: [] });
    bridge.emit({ type: "text_delta", text: "The return is recorded." });
    bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const password = "the bow only Odysseus can string";
  const native = createNativeJournalFixture(brain,root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: "odysseus-journal-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus journal", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Record the return to Ithaca", requestId: "journal-request" }) } as MessageEvent, ws);
    const frames = () => sent.flatMap(text => { const parsed = parseServerMessage(text); if (!parsed.ok) throw new Error(parsed.error); return [parsed.message]; });
    const wait = async (check: () => boolean) => { const until = Date.now() + 5000; while (!check()) { if (Date.now() > until) throw new Error(JSON.stringify(frames())); await Bun.sleep(5); } };
    await wait(() => frames().some(frame => frame?.type === "tool_result"));
    await wait(() => frames().some(frame => frame.type === "turn_journal" && (frame.journal.changedFiles ?? 0) > 0));
    const toolReceipt = frames().findLast(frame => frame.type === "turn_journal");
    expect(toolReceipt?.type === "turn_journal" ? toolReceipt.journal.changedFiles : null, "JOURNAL_TOOL_COMPLETION_RECEIPT").toBeGreaterThan(0);
    expect(called, "JOURNAL_ADMISSION_PRECEDES_BACKEND").toBe(1);
    const first = frames().findIndex(frame => frame?.type === "turn_journal"), identity = frames().findIndex(frame => frame?.type === "session_info");
    expect(first, "JOURNAL_RECEIPT_FOLLOWS_SESSION_IDENTITY").toBeGreaterThan(identity);
    const receipt = frames().find(frame => frame?.type === "turn_journal")!;
    if (receipt.type !== "turn_journal") throw new Error("Missing receipt");
    // A receipt can precede another queued tool observation. Model the real
    // worker observation hold before allowing this fake backend to write again.
    await app.wsHost.journal!.idle();
    release();
    await wait(() => frames().some(frame => frame?.type === "turn_journal" && frame.journal.state === "complete"));
    // Roadblocks are classified after the journal completes; the turn's slot
    // ends only once they have committed (#2850).
    await wait(() => !app.wsHost.coordinator.isTurnActive());
    const details = app.wsHost.journal!.details("sess-ithaca", receipt.turnId)!;
    expect(details.summary.policyHash, "JOURNAL_FROZEN_ADMISSION_POLICY").toMatch(/^[a-f0-9]{64}$/);
    expect(details.changes.filter(change => change.path === "notes/journal.md").map(change => app.wsHost.journal!.version("sess-ithaca", receipt.turnId, change.sequence, "after")!.bytes(1024).toString()), "JOURNAL_TOOL_AND_TERMINAL_VERSIONS").toEqual(["Athena\r\n", "Penelope\r\n"]);
    expect(frames().find(frame=>frame.type==="tool_result"&&frame.toolUseId==="toolu_ithaca_write"),"CONFLICT_NATIVE_DENIAL_RETAINED_FRAME").toMatchObject({isError:true,output:"File changed since you read it; read it again before writing. Nothing was written."});
    const roadblocks=queryGovernanceEvents(app.db,{turnId:receipt.turnId,kinds:["roadblock"],limit:100});
    expect(roadblocks.some(event=>(event.payload.failures as {toolCallId:string}[]).some(failure=>failure.toolCallId==="toolu_ithaca_write")),"CONFLICT_NATIVE_DENIAL_RETAINED_ROADBLOCK").toBe(true);
    const recorded=app.wsHost.activity!.store.snapshotRun(receipt.turnId)!;
    expect(recorded.events.find(event=>event.spanId==="toolu_ithaca_write"&&event.eventType==="tool_input")?.payload,"CONFLICT_NATIVE_DENIAL_ORIGINAL_INPUT").toBe(JSON.stringify({file_path:resolve(brain,"notes/journal.md"),content:"Odysseus overwrites.\n"}));
    const endpoint = `/api/sessions/sess-ithaca/turns/${receipt.turnId}/journal`;
    expect((await app.fetch(new Request(`http://localhost${endpoint}`))).status).toBe(401);
    const login = await app.fetch(new Request("http://localhost/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }));
    expect(login.status).toBe(200);
    const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    expect((await app.fetch(new Request(`http://localhost${endpoint}`, { headers }))).status).toBe(200);
    await wait(() => app.wsHost.prepareHistory("sess-ithaca", history).some(message => message.journal?.state === "complete"));
    const replay = await app.fetch(new Request("http://localhost/api/sessions/sess-ithaca", { headers }));
    expect((await replay.json()).messages.find((message: SessionHistoryMessage) => message.role === "assistant"), "JOURNAL_REPLAY_USES_PROVEN_TURN").toMatchObject({ turnId: receipt.turnId, journal: { state: "complete", policyHash: details.summary.policyHash } });
    expect((await app.fetch(new Request(`http://localhost${endpoint.replace("sess-ithaca", "sess-other")}`, { headers }))).status).toBe(404);
    const note = details.changes.find(change => change.path === "notes/journal.md")!;
    const raw = await app.fetch(new Request(`http://localhost${endpoint}/${note.sequence}/before`, { headers }));
    expect(raw.status).toBe(200); expect(await raw.text()).toBe("Ithaca\r\n");
    expect(await readFile(resolve(brain, "notes/journal.md"), "utf8")).toBe("Penelope\r\n");
  } finally { release(); await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("a real mid-turn journal capacity stop emits the named failure and an error terminal rather than timeout", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-journal-stop-")), brain = resolve(root, "brain"), dbPath = resolve(root, "ui.db");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  const backend = makeFakeBackend({ id: "journal-stop", startTurn: async ({ bridge, signal }) => {
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    await writeFile(resolve(brain, "notes/partial.txt"), Buffer.alloc(2 * 1024 * 1024, 65));
    bridge.emit({ type: "tool_result", toolUseId: "loom", output: "Partial work remains", isError: false });
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } });
  const registry = createStaticBackendRegistry([backend], backend.id);
  const native = createNativeJournalFixture(brain,root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: dbPath, HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry, observability: createRecordingObservability() });
  let host: WsHost;
  const journal = createTurnJournal(app.db, { nativeManager: native.manager, brainPath: brain, dbPath, objectsRoot: resolve(root, "ui.db.journal"), capBytes: 1024 * 1024,
    changed(turnId, sessionId, summary) { host.sendToClients({ type: "turn_journal", sessionId, turnId, journal: summary }); } });
  host = new WsHost({ brainPath: brain, registry, catalog: app.wsHost.catalog, governedTurns: app.wsHost.governedTurns, activity: app.wsHost.activity ?? undefined, journal });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus journal", ttlSeconds: 60 });
    const sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    const handlers = createWsHandlers(host, principal); await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Record the voyage", requestId: "overflow-request" }) } as MessageEvent, ws);
    const frames = () => sent.map(text => JSON.parse(text));
    const deadline = Date.now() + 5000;
    while (!frames().some(frame => frame.type === "turn_journal" && frame.journal.state === "partial") || host.coordinator.isTurnActive()) { if (Date.now() > deadline) throw Error(JSON.stringify(frames())); await Bun.sleep(5); }
    const failure = frames().find(frame => frame.type === "error");
    expect(failure, "JOURNAL_HOST_OVERFLOW_NAMED_FAILURE").toMatchObject({ code: "JOURNAL_CAPACITY", failure: { errorClass: "journal_capacity" } });
    expect(JSON.stringify(frames()), "JOURNAL_OVERFLOW_NOT_TIMEOUT").not.toContain("Turn timed out");
    expect(journal.details("sess-ithaca", failure.turnId)?.summary.state).toBe("partial");
    expect(app.db.query("SELECT outcome FROM activity_run_rollups WHERE run_id=?").get(failure.turnId), "JOURNAL_OVERFLOW_ACTIVITY_ERROR").toEqual({ outcome: "error" });
    expect(Bun.file(resolve(brain, "notes/partial.txt")).size).toBe(2 * 1024 * 1024);
  } finally { host.close(); await journal.close(); await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("the host observes after a tool result unless the backend proved where that read ran (#2834)", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-schedule-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  let app!: Awaited<ReturnType<typeof createApp>>, observations = 0;
  const counts: Record<string, number> = {};
  const backend = makeFakeBackend({ id: "schedule-fixture", startTurn: async ({ bridge, toolExecution }) => {
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    const call = async (id: string, toolName: string, proven?: "worker_read" | "host_bridge") => {
      await app.wsHost.journal!.idle(); const before = observations;
      bridge.emit({ type: "tool_use_start", toolUseId: id, toolName });
      bridge.emit({ type: "tool_use_complete", toolUseId: id, toolName, input: {} });
      if (proven) toolExecution!(id, proven);
      bridge.emit({ type: "tool_result", toolUseId: id, output: "Ithaca", isError: false });
      await app.wsHost.journal!.idle(); counts[id] = observations - before;
    };
    await call("read-proven", "read_file", "worker_read");
    await call("base-proven", "brain_read_base", "host_bridge");
    // The name alone proves nothing, and an unproven call may keep writing in
    // the worker: it and every later result are observed.
    await call("read-unproven", "read_file");
    await call("read-after-unproven", "read_file", "worker_read");
    bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  app.wsHost.journal!.onObservation(() => { observations++; });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus schedule", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Read the return to Ithaca", requestId: "schedule-request" }) } as MessageEvent, ws);
    const until = Date.now() + 10_000;
    while (!sent.some(text => JSON.parse(text).type === "turn_journal" && JSON.parse(text).journal.state === "complete")) { if (Date.now() > until) throw new Error(sent.join("\n")); await Bun.sleep(5); }
    expect(counts, "HOST_SCHEDULE_BY_PROVEN_EXECUTION_PATH").toEqual({ "read-proven": 0, "base-proven": 0, "read-unproven": 1, "read-after-unproven": 1 });
  } finally { await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("an automatically admitted conversation task keeps real effects, receipts and supported revert/undo", async () => {
  const { fakeLiveProvider } = await import("./helpers/live-conversation.js");
  const { createClaudeBackend } = await import("../../ui-backend-claude/src/backend.js");
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-context-revert-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  await writeFile(resolve(brain, "notes/journal.md"), "Ithaca before the voyage.\n");
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), "---\nschema_version: 1\nprofiles: { interactive: governed }\n---\nAthena reviews policy.\n");
  const live = fakeLiveProvider({ contextualTasks: "supported" });
  let calls = 0, effect: unknown;
  const production = createClaudeBackend({ brainPath: brain, allowedTools: ["Read", "mcp__brain-ui__write_file"] });
  const backend = makeFakeBackend({ id: "journal-fixture", startTurn: async req => {
    calls++;
    req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    effect = await req.bridge.applyBrain!({ operation: "write", path: "notes/contextual-effect.md", content: "Eumaeus takes the night watch.\n", expectedBaseHash: null });
    req.bridge.emit({ type: "text_delta", text: "The watch note was written." });
    req.bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  backend.brainApplicationPolicy = production.brainApplicationPolicy;
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), conversationProvider: live.provider, observability: createRecordingObservability() });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus watch", ttlSeconds: 60 });
    const sent: any[] = [], ws = { send: (text: string) => sent.push(JSON.parse(text)), close() {}, readyState: 1 } as WSContext;
    const handlers = createWsHandlers(app.wsHost, principal); await handlers.onOpen(undefined as never, ws);
    const send = (frame: unknown) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
    const wait = async (check: () => boolean) => { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) throw new Error(JSON.stringify(sent)); await Bun.sleep(5); } };
    send({ type: "conversation_start", contextualTasks: true }); await wait(() => sent.some(f => f.type === "conversation_opened"));
    const opened = sent.find(f => f.type === "conversation_opened");
    send({ type: "conversation_audio", conversationId: opened.conversationId, epoch: opened.epoch, utteranceId: "watch-capture", sequence: 0, rate: 16000, pcm: "AAA=" });
    await wait(() => live.sessions[0]!.audio.length === 1);
    live.sessions[0]!.emit({ kind: "unassigned_input_fragment", sequence: 0, text: "Record Eumaeus taking the night watch.", sessionInterval: { startMs: 0, endMs: 500 } });
    live.sessions[0]!.emit({ kind: "work_requested", handle: "watch-effect" });
    await wait(() => sent.some(f => f.type === "conversation_work" && f.state === "completed"));
    await wait(() => !app.wsHost.coordinator.isTurnActive());
    expect(effect).toMatchObject({ ok: true, changes: [{ path: "notes/contextual-effect.md" }] });
    const task = sent.findLast(f => f.type === "conversation_work");
    expect(task).toMatchObject({ provenance: "contextual", nativeHandle: "watch-effect", state: "completed" });
    expect(task).not.toHaveProperty("utteranceId");
    expect(app.wsHost.journal!.details("sess-ithaca", task.turnId)?.summary).toMatchObject({ state: "complete", actor: "interactive" });
    const reverts = app.wsHost.turnReverts!;
    expect(reverts.plan("sess-ithaca", task.turnId).paths.some(p => p.path === "notes/contextual-effect.md" && p.state === "eligible")).toBe(true);
    const reverted = await reverts.start(principal.id, "sess-ithaca", task.turnId, { id: "odysseus_context_revert" });
    await reverts.idle(reverted.id);
    expect(await Bun.file(resolve(brain, "notes/contextual-effect.md")).exists()).toBe(false);
    const undo = await reverts.start(principal.id, "sess-ithaca", reverted.journalTurnId, { id: "odysseus_context_undo" });
    await reverts.idle(undo.id);
    expect(await readFile(resolve(brain, "notes/contextual-effect.md"), "utf8")).toBe("Eumaeus takes the night watch.\n");
    expect(calls).toBe(1);
  } finally { await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
