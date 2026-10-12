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
  const app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: "odysseus-journal-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  try {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus journal", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Record the return to Ithaca", requestId: "journal-request" }) } as MessageEvent, ws);
    const frames = () => sent.flatMap(text => { const parsed = parseServerMessage(text); if (!parsed.ok) throw new Error(parsed.error); return [parsed.message]; });
    const wait = async (check: () => boolean) => { const until = Date.now() + 5000; while (!check()) { if (Date.now() > until) throw new Error(JSON.stringify(frames())); await Bun.sleep(5); } };
    await wait(() => frames().some(frame => frame?.type === "tool_result"));
    const toolReceipt = frames().findLast(frame => frame.type === "turn_journal");
    expect(toolReceipt?.type === "turn_journal" ? toolReceipt.journal.changedFiles : null, "JOURNAL_TOOL_COMPLETION_RECEIPT").toBeGreaterThan(0);
    expect(called, "JOURNAL_ADMISSION_PRECEDES_BACKEND").toBe(1);
    const first = frames().findIndex(frame => frame?.type === "turn_journal"), identity = frames().findIndex(frame => frame?.type === "session_info");
    expect(first, "JOURNAL_RECEIPT_FOLLOWS_SESSION_IDENTITY").toBeGreaterThan(identity);
    const receipt = frames().find(frame => frame?.type === "turn_journal")!;
    if (receipt.type !== "turn_journal") throw new Error("Missing receipt");
    release();
    await wait(() => frames().some(frame => frame?.type === "turn_journal" && frame.journal.state === "complete"));
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
  } finally { release(); await app.close(); await rm(root, { recursive: true, force: true }); }
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
  const app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: dbPath, HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry, observability: createRecordingObservability() });
  let host: WsHost;
  const journal = createTurnJournal(app.db, { brainPath: brain, dbPath, objectsRoot: resolve(root, "ui.db.journal"), capBytes: 1024 * 1024,
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
  } finally { host.close(); journal.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
