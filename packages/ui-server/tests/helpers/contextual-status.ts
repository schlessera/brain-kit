/** Actual adapters + actual host admission; scripted provider, no semantic or acoustic claim. */
import { expect, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import type { LiveConversationProvider, LiveConversationSession, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { projectConversationGuidance } from "@schlessera/brain-ui-sdk/internal";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { createUiDb } from "../../src/db/client";
import { createSessionCatalog } from "../../src/ws/session-catalog";
import { createWsHandlers } from "../../src/ws/connection";
import type { WSContext } from "../../src/ws/clients";
import { WsHost } from "../../src/ws/host";
import { makeFakeBackend } from "./fake-backend";
import { testPrincipal } from "./principal";
import * as walker from "../../src/files/walker";

export async function contextualStatus(engine: "gemini" | "gpt", mode: "complete" | "storage" | "replace" | "withdraw" | "status-error", f: {
  provider: LiveConversationProvider; emit: (frame: any) => void; sent: any[];
}, registerCleanup: (cleanup: () => Promise<void>) => void) {
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2000;
    while (!check()) { if (Date.now() > end) throw Error("status transport barrier timed out"); await Bun.sleep(1); }
  };
  const root = mkdtempSync(join(tmpdir(), "odyssey-live-status-"));
  mkdirSync(join(root, "me")); mkdirSync(join(root, "context"));
  mkdirSync(join(root, "voyages"));
  writeFileSync(join(root, "brain.config.ts"), 'throw Error("STARTUP_MUST_NOT_EXECUTE_CONFIG");\n');
  writeFileSync(join(root, "voyages/_index.md"), "---\nsummary: Routes and raft decisions for Ithaca.\n---\n## Registry\nHOST_ONLY_REGISTRY\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Personal Rules\nUse short plain answers for Odysseus.\n# Capture policy\nAsk before capturing a new preference.\n## Exceptions\nNever capture private watch details without an explicit request.\n# Response surface\nHOST_ONLY_RENDERING\n");
  writeFileSync(join(root, "me/identity.md"), "---\nsummary: Odysseus returns to Ithaca.\n---\nHe commands the raft.\n\n## More\nHOST_ONLY_IDENTITY_DETAIL\n");
  writeFileSync(join(root, "context/current-focus.md"), "Repair the mast on 2026-07-12.\n");
  const db = createUiDb(":memory:");
  const turns: StartTurnRequest[] = [], releaseTurns: (() => void)[] = [];
  let admissionDone = false, finishAdmission!: (fail?: boolean) => void;
  const observed: Array<{ state: string; durable: boolean; ref: unknown }> = [];
  let native: LiveConversationSession | undefined;
  const backend = makeFakeBackend({ id: "fake", startTurn: async req => {
    turns.push(req); req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: false });
    await new Promise<void>(resolve => releaseTurns.push(resolve));
    req.bridge.emit({ type: "text_delta", text: "The mast decision requires ash timber." });
    req.bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  backend.conversationGuidance = projectConversationGuidance("# Personal Rules\nBe concise.\n# Turn lifecycle\nHOST_ONLY_EXECUTION\n", "configured systemPromptAppend");
  const configured = backend.conversationGuidance;
  let guidanceReads = 0;
  Object.defineProperty(backend, "conversationGuidance", { get() { guidanceReads++; return configured; } });
  const provider = { ...f.provider, async open(...args: Parameters<LiveConversationProvider["open"]>) {
    const session = await f.provider.open(...args); native = session;
    const report = session.reportWorkStatus!.bind(session);
    session.reportWorkStatus = (ref, status) => {
      observed.push({ ref: { ...ref }, state: status.state, durable: admissionDone });
      if (mode === "status-error") throw Error("Fixture status transport unavailable");
      report(ref, status);
    };
    return session;
  } };
  const catalog = createSessionCatalog(() => db), save = catalog.saveConversationTask!.bind(catalog);
  let held = false;
  catalog.saveConversationTask = (principal, receipt, facts) => {
    if (!held && receipt.state === "queued") {
      held = true;
      return new Promise<void>((resolve, reject) => { finishAdmission = fail => {
        if (fail) reject(Error("Fixture task persistence unavailable"));
        else void save(principal, receipt, facts).then(() => { admissionDone = true; resolve(); }, reject);
      }; });
    }
    return save(principal, receipt, facts);
  };
  const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], "fake"), catalog, conversationProvider: provider });
  const sourceReads = spyOn(walker, "readAnchoredSnapshot"), enumerations = spyOn(fsPromises, "opendir");
  registerCleanup(async () => { finishAdmission?.(); for (const release of releaseTurns) release(); await host.close(); db.close(); sourceReads.mockRestore(); enumerations.mockRestore(); rmSync(root, { recursive: true, force: true }); });
  const frames: any[] = [], ws = { send: (raw: string) => frames.push(JSON.parse(raw)) } as WSContext;
  const handlers = createWsHandlers(host, testPrincipal()); await handlers.onOpen(undefined as never, ws);
  expect(sourceReads, "HELLO_PERFORMS_NO_ORIENTATION_SOURCE_READS").not.toHaveBeenCalled();
  expect(enumerations, "HELLO_PERFORMS_NO_MAP_ENUMERATION").not.toHaveBeenCalled();
  expect(f.provider.disclosure.destinations.join(" ")).toContain("observed partial content map");
  const send = (frame: unknown) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  const start = () => send({ type: "conversation_start", contextualTasks: true, disclosed: host.conversations!.profile(true) });
  // Stale disclosure refuses before reading configured guidance or opening another socket.
  const beforeStarts = f.sent.filter(frame => frame.setup || frame.type === "session.start").length;
  send({ type: "conversation_start", contextualTasks: true, disclosed: { ...host.conversations!.profile(true), disclosure: { voiceService: "stale", destinations: ["Earlier disclosure."] } } });
  await until(() => frames.some(frame => frame.code === "CONVERSATION_DISCLOSURE"));
  expect(f.sent.filter(frame => frame.setup || frame.type === "session.start")).toHaveLength(beforeStarts);
  expect(guidanceReads, "START_DISCLOSURE_PRECEDES_CONFIGURED_GUIDANCE_READ").toBe(0);
  expect(sourceReads, "START_DISCLOSURE_PRECEDES_SOURCE_READS").not.toHaveBeenCalled();
  expect(enumerations, "START_DISCLOSURE_PRECEDES_MAP_ENUMERATION").not.toHaveBeenCalled();
  start(); await until(() => frames.some(frame => frame.type === "conversation_opened"));
  const { conversationId, epoch } = frames.find(frame => frame.type === "conversation_opened");
  await until(() => f.sent.some(frame => JSON.stringify(frame).includes("Odysseus returns to Ithaca.")));
  const startup = JSON.stringify(f.sent.filter(frame => frame.clientContent || frame.type === "session.start"));
  expect(startup, "HOST_READS_SELECTED_GUIDANCE_INTO_ACTUAL_PROVIDER_STARTUP").toContain("Use short plain answers for Odysseus.");
  expect(startup, "COMPLETE_NESTED_CAPTURE_POLICY_REACHES_PROVIDER").toContain("Never capture private watch details without an explicit request.");
  expect(startup).toContain("Repair the mast on 2026-07-12."); expect(startup).toContain("Be concise.");
  expect(startup, "OBSERVED_MAP_REACHES_ACTUAL_HOST_AND_PROVIDER_STARTUP").toContain("Routes and raft decisions for Ithaca.");
  expect(startup).toContain("voyages/_index.md"); expect(startup).toContain("OBSERVED partial");
  expect(startup).toContain("not runtime taxonomy"); expect(turns, "STARTUP_DOES_NOT_BOOTSTRAP_HOST_WORK").toHaveLength(0);
  expect(startup).not.toContain("HOST_ONLY");
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "capture", sequence: 0, rate: engine === "gemini" ? 16000 : 24000, pcm: "AAA=" });
  await until(() => f.sent.some(frame => frame.realtimeInput?.audio || frame.type === "session.input_audio.append"));
  const recognize = async (text: string, i: number) => {
    f.emit(engine === "gemini" ? { serverContent: { inputTranscription: { text } } } : { type: "session.input_transcript.delta", event_id: `recognition-${i}`, delta: text, start_ms: i * 100 + 1, end_ms: i * 100 + 50 });
    await until(() => frames.some(frame => frame.event?.text === text));
  };
  const request = (id: string) => f.emit(engine === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: `event-${id}`, offset_ms: 20, delegation: { id, type: "delegation", target: "client" } });
  const statuses = () => f.sent.flatMap(frame => engine === "gemini" ? (frame.toolResponse?.functionResponses ?? []).filter((r: any) => r.response.status).map((r: any) => ({ id: r.id, state: r.response.status, content: r.response.output, frame: r }))
    : frame.delegation_id && frame.content?.startsWith('{"hostTaskStatus"') ? [{ id: frame.delegation_id, state: JSON.parse(frame.content).hostTaskStatus, content: frame.content, frame }] : []);
  await recognize("Find the mast decision.", 0); request("mast-native");
  await until(() => !!finishAdmission);
  // Persistence is held, so durable admission never completes here. One
  // macrotask runs every host continuation that does not wait for it. A status
  // any of them sent travels the same ordered provider socket as the audio
  // frame the host forwards after it: once that frame has arrived, every
  // earlier status would have too.
  await new Promise(resolve => setTimeout(resolve, 0));
  const audioFrames = () => f.sent.filter(frame => frame.realtimeInput?.audio || frame.type === "session.input_audio.append").length;
  const forwarded = audioFrames();
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "capture", sequence: 1, rate: engine === "gemini" ? 16000 : 24000, pcm: "AAA=" });
  await until(() => audioFrames() > forwarded);
  expect(statuses(), "NO_PROVIDER_ACCEPTANCE_BEFORE_DURABLE_ADMISSION").toEqual([]);
  expect(turns).toHaveLength(0);
  if (mode === "replace") {
    writeFileSync(join(root, "voyages/_index.md"), "Athena's updated route registry on 2026-07-12.\n");
    send({ type: "conversation_start", conversationId, contextualTasks: true, disclosed: host.conversations!.profile(true) });
    await until(() => frames.filter(frame => frame.type === "conversation_opened").length === 2);
    await until(() => f.sent.some(frame => JSON.stringify(frame).includes("Athena's updated route registry")));
    expect(startup, "EARLIER_MAP_SNAPSHOT_IS_IMMUTABLE").not.toContain("Athena's updated route registry");
  } else if (mode === "withdraw") {
    // GPT Live v1 has no withdrawal event; exercise host withdrawal with the
    // already opened real adapter while retaining its actual native binding.
    if (engine === "gemini") f.emit({ toolCallCancellation: { ids: ["mast-native"] } });
    else {
      send({ type: "conversation_stop", conversationId, epoch });
    }
    await until(() => frames.some(frame => frame.nativeHandle === "mast-native" && frame.state === "cancelled"));
  }
  finishAdmission(mode === "storage");
  if (mode !== "complete") {
    if (mode === "storage") await until(() => frames.some(frame => frame.nativeHandle === "mast-native" && frame.state === "refused"));
    else if (mode === "status-error") await until(() => frames.some(frame => frame.type === "conversation_closed"));
    else await host.catalog.settled!();
    // Negative window, kept real time: a wrong acceptance would cross the real
    // provider socket after this outcome. Status-error and GPT withdrawal have
    // closed that socket, so no later frame can follow it and mark its arrival.
    // 10 ms gives a frame already sent on loopback its chance to arrive.
    await Bun.sleep(10);
    expect(statuses(), "FAILED_OR_STALE_ADMISSION_NEVER_CLAIMS_ACCEPTED").toEqual([]);
    expect(turns).toHaveLength(0);
    return;
  }
  await until(() => statuses().length === 2 && turns.length === 1);
  expect(statuses().map(status => [status.id, status.state])).toEqual([["mast-native", "queued"], ["mast-native", "running"]]);
  expect(observed.every(item => item.durable), "STATUS_REQUIRES_COMMITTED_IDENTITY").toBe(true);
  const receipt = frames.find(frame => frame.nativeHandle === "mast-native" && frame.state === "running");
  expect(observed[0]!.ref).toEqual({ conversationId, epoch, taskId: receipt.taskId, requestId: receipt.requestId, nativeHandle: "mast-native" });
  expect(JSON.parse(statuses()[0]!.content).guidance).toContain("one brief spoken acknowledgement");
  expect(JSON.parse(statuses()[0]!.content).guidance).toContain("only once after exact acceptance");
  expect(JSON.parse(statuses()[1]!.content).guidance).toContain("backend/tools may not have started");
  expect(JSON.parse(statuses()[1]!.content).guidance).toContain("Do not repeat this task's acknowledgement");
  for (const status of statuses()) expect(status.content.toLowerCase()).not.toContain("keep talking");
  for (const status of statuses()) {
    expect(Buffer.byteLength(status.content)).toBeLessThanOrEqual(500);
    expect(status.content).not.toContain(receipt.taskId); expect(status.content).not.toContain(receipt.turnId);
    expect(JSON.parse(status.content)).toMatchObject({ pending: true });
  }
  if (engine === "gemini") {
    expect(statuses()[0]!.frame).toMatchObject({ scheduling: "WHEN_IDLE", willContinue: true });
    expect(statuses()[1]!.frame).toMatchObject({ scheduling: "SILENT", willContinue: true });
  } else {
    expect(statuses()[0]!.frame.type).toBe("session.commentary.append");
    expect(statuses()[1]!.frame.type).toBe("session.thinking.append");
  }
  // New dialogue continues while the first task genuinely waits in the backend.
  await recognize("Also check the oars.", 1); request("oars-native");
  await until(() => statuses().length === 3);
  expect(statuses()[2]).toMatchObject({ id: "oars-native", state: "queued" });
  expect(turns).toHaveLength(1);
  request("mast-native"); await recognize("We can keep talking while that runs.", 2);
  expect(statuses()).toHaveLength(3);
  expect(f.sent.some(frame => JSON.stringify(frame).includes("requires ash timber"))).toBe(false);
  releaseTurns[0]!();
  await until(() => turns.length === 2 && statuses().length === 4);
  releaseTurns[1]!();
  await until(() => f.sent.filter(frame => JSON.stringify(frame).includes("requires ash timber")).length === 2);
  expect(statuses().map(status => [status.id, status.state])).toEqual([["mast-native", "queued"], ["mast-native", "running"], ["oars-native", "queued"], ["oars-native", "running"]]);
  const count = statuses().length;
  expect(() => native!.reportWorkStatus!({ conversationId, epoch, taskId: receipt.taskId, requestId: receipt.requestId, nativeHandle: "mast-native" }, { state: "running", intent: "Replay" })).toThrow();
  expect(statuses()).toHaveLength(count);
}
