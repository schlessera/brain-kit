/** Real Bun WebSocket transport, loopback only. No vendor session or key. */
import { afterEach, expect, test } from "bun:test";
import { createGeminiConversationProvider } from "../src/voice/gemini-conversation";
import type { StartTurnRequest, LiveConversationEvent, LiveConversationSession } from "@schlessera/brain-ui-sdk/server";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
const NativeWebSocket = WebSocket;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; Object.defineProperty(globalThis, "WebSocket", original); });
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error("transport condition timed out"); await Bun.sleep(1); }
}
async function fixture(ack = true, consume = true) {
  const sent: any[] = [];
  const received: LiveConversationEvent[] = [];
  let remote: Bun.ServerWebSocket<undefined> | undefined;
  let connectedUrl = "";
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { remote = ws; },
      message(ws, frame) {
        const m = JSON.parse(String(frame)); sent.push(m);
        if (m.setup && ack) ws.send(JSON.stringify({ setupComplete: {} }));
      },
    },
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
    constructor(url: string | URL) { connectedUrl = String(url); super(`ws://127.0.0.1:${server.port}`); }
  } });
  const abort = new AbortController();
  let session: LiveConversationSession | undefined;
  cleanup = () => { abort.abort(); remote?.close(); server.stop(true); };
  const provider = createGeminiConversationProvider("keyless-odyssey-placeholder");
  const opening = provider.open({ conversationId: "ithaca", epoch: 1 }, { signal: abort.signal, resync: { work: [] } });
  await until(() => !!remote);
  await until(() => sent.some((m) => m.setup));
  if (ack) {
    session = await opening;
    if (consume) {
      void (async () => { for await (const e of session!.events) received.push(e); })();
      await until(() => received.some((e) => e.kind === "ready"));
    }
  }
  return { provider, opening, session: session!, abort, sent, received,
    url: () => connectedUrl,
    emit: (m: unknown) => remote!.send(JSON.stringify(m)),
    closeRemote: () => remote!.close(),
    remoteClosed: () => remote!.readyState !== 1,
    async audio(utteranceId = "u1", sequence = 0) {
      session!.appendAudio({ utteranceId, sequence, rate: 16000, pcm: new Uint8Array([0, 0]) });
      await until(() => sent.some((m) => m.realtimeInput?.audio));
    },
  };
}
const ref = (nativeHandle = "native-1") => ({ conversationId: "ithaca", epoch: 1, utteranceId: "u1", turnId: "t1", requestId: "r1", nativeHandle });
const result = { outcome: "completed" as const, facts: "The Ithaca note was captured.", delivery: "when-idle" as const };

test("Gemini setup uses canonical endpoint, server-only auth, manual activity and explicit NON_BLOCKING", async () => {
  const f = await fixture();
  expect(f.url()).toBe("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=keyless-odyssey-placeholder");
  expect(f.sent[0].setup).toMatchObject({ model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
    tools: [{ functionDeclarations: [{ name: "host_task", behavior: "NON_BLOCKING" }] }],
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, inputAudioTranscription: {}, outputAudioTranscription: {} });
  expect(JSON.stringify(f.provider)).not.toContain("keyless-odyssey-placeholder");
  expect(f.provider.capabilities.exactPermissionSpeech).toBe("unproven");
  expect(f.provider.capabilities.echoIsolatedInput).toBe("unproven");
  expect(f.provider.capabilities.outputWordAlignment).toBe("unproven");
  expect(() => createGeminiConversationProvider(" ")).toThrow("server API key");
});

test("async native work accepts another utterance before a correlated result, with final scheduling once", async () => {
  const f = await fixture();
  await f.audio(); f.session.markEndpoint("u1");
  f.emit({ serverContent: { inputTranscription: { text: "Capture the Ithaca note.", finished: true } } });
  f.emit({ toolCall: { functionCalls: [{ id: "native-1", name: "host_task", args: { task: "Untrusted replacement" } }] } });
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  expect(f.received.find((e) => e.kind === "work_requested")).not.toHaveProperty("utteranceId");
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; }).then(() => f.session.returnWork(ref(), result));
  await f.audio("u2", 1);
  f.emit({ serverContent: { inputTranscription: { text: "Also check the harbour fees.", finished: true }, outputTranscription: { text: "I am still listening." }, modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] } } });
  await until(() => f.received.some((e) => e.kind === "input_fragment" && e.utteranceId === "u2"));
  expect(f.sent.filter((m) => m.toolResponse)).toHaveLength(0);
  expect(f.received.some((e) => e.kind === "audio")).toBe(true);
  release(); await deferred;
  await until(() => f.sent.some((m) => m.toolResponse));
  expect(f.sent.find((m) => m.toolResponse).toolResponse.functionResponses).toEqual([{ id: "native-1", name: "host_task", response: { outcome: "completed", output: result.facts }, scheduling: "WHEN_IDLE", willContinue: false }]);
  await expect(f.session.returnWork(ref(), result)).rejects.toThrow("correlation");
  f.session.markEndpoint("u2");
  await until(() => f.sent.filter((m) => m.realtimeInput?.activityEnd).length === 2);
  await f.session.close();
  expect(f.sent.filter((m) => m.toolResponse)).toHaveLength(1);
});

test("mixed input/audio/interruption retains every part and model completion cannot finalize input", async () => {
  const f = await fixture(); await f.audio(); f.session.markEndpoint("u1");
  f.emit({ serverContent: { inputTranscription: { text: "Do not archive the note." }, outputTranscription: { text: "Acknowledged." },
    modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] }, interrupted: true, turnComplete: true } });
  await until(() => f.received.some((e) => e.kind === "interrupted"));
  expect(f.received.filter((e) => e.kind !== "ready").map((e) => e.kind)).toEqual(["input_fragment", "output_transcript", "audio", "interrupted"]);
  expect(f.received.find((e) => e.kind === "input_fragment")).toMatchObject({ finalization: "unknown", certainty: "unknown", origin: "unknown" });
  expect(() => f.session.appendAudio({ utteranceId: "u2", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("correlation");
  await until(() => f.received.some((e) => e.kind === "error"));
});

for (const mode of ["withdrawal", "abort", "close", "epoch", "conversation", "unknown-handle"] as const) {
  test(`late host result is discarded after ${mode}`, async () => {
    const f = await fixture(); await f.audio();
    f.emit({ toolCall: { functionCalls: [{ id: "native-1", name: "host_task" }] } });
    await until(() => f.received.some((e) => e.kind === "work_requested"));
    if (mode === "withdrawal") {
      f.emit({ toolCallCancellation: { ids: ["native-1"] } });
      await until(() => f.received.some((e) => e.kind === "work_withdrawn"));
    }
    if (mode === "abort") f.abort.abort();
    if (mode === "close") await f.session.close();
    await expect(f.session.returnWork({ ...ref(mode === "unknown-handle" ? "unknown" : "native-1"),
      ...(mode === "epoch" ? { epoch: 2 } : {}), ...(mode === "conversation" ? { conversationId: "troy" } : {}) }, result)).rejects.toThrow("correlation");
    if (mode !== "abort" && mode !== "close") {
      f.session.markEndpoint("u1");
      await until(() => f.sent.some((m) => m.realtimeInput?.activityEnd));
    }
    expect(f.sent.filter((m) => m.toolResponse)).toHaveLength(0);
    await f.session.close();
  });
}

test("quiet host result uses top-level SILENT, never nested scheduling", async () => {
  const f = await fixture(); await f.audio();
  f.emit({ toolCall: { functionCalls: [{ id: "native-1", name: "host_task" }] } });
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  await f.session.returnWork(ref(), { ...result, delivery: "quiet" });
  await until(() => f.sent.some((m) => m.toolResponse));
  const response = f.sent.find((m) => m.toolResponse).toolResponse.functionResponses[0];
  expect(response.scheduling).toBe("SILENT"); expect(response.willContinue).toBe(false);
  expect(response.response.scheduling).toBeUndefined();
});

for (const frame of ["not-json", { toolCall: { functionCalls: [{ id: "x", name: "Bash" }] } }, { serverContent: { modelTurn: { parts: [{ inlineData: { data: "bad", mimeType: "audio/pcm;rate=24000" } }] } } }]) {
  test("malformed provider data closes capture without leaking remote diagnostics", async () => {
    const f = await fixture(); await f.audio();
    f.emit(frame);
    await until(() => f.received.some((e) => e.kind === "error"));
    expect(() => f.session.appendAudio({ utteranceId: "u1", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("ended");
    expect(JSON.stringify(f.received)).not.toContain("keyless-odyssey-placeholder");
  });
}

test("provider errors redact authentication details and handshake failure rejects visibly", async () => {
  const f = await fixture(false);
  f.emit({ error: { message: f.url() } });
  await expect(f.opening).rejects.toThrow("provider error");
});

test("disconnect produces a closed event with unknown remote cancellation", async () => {
  const f = await fixture(); f.closeRemote();
  await until(() => f.received.some((e) => e.kind === "closed"));
  expect(f.received.at(-1)).toMatchObject({ kind: "closed", remote: "unknown" });
});


test("real adapter and host keep chat progress and a question interactive while async work awaits", async () => {
  const f = await fixture();
  await f.session.close();
  const db = createUiDb(":memory:");
  const turns: StartTurnRequest[] = [];
  let release!: () => void;
  const work = new Promise<void>((resolve) => { release = resolve; });
  const backend = makeFakeBackend({ id: "fake", capabilities: { askUser: true }, startTurn: async (req) => {
    turns.push(req);
    req.bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    req.bridge.emit({ type: "text_delta", text: "Checking the harbour notes." });
    req.bridge.emit({ type: "tool_use_start", toolUseId: "lookup-1", toolName: "brain_search" });
    const question = req.bridge.askUser!("q1", [{ question: "Which watch?", header: "Watch", options: [{ label: "Morning", description: "First watch" }, { label: "Evening", description: "Last watch" }], multiSelect: false }]);
    await work;
    await question;
    req.bridge.emit({ type: "text_delta", text: "The Ithaca note is ready." });
    req.bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db), conversationProvider: f.provider });
  const oldCleanup = cleanup!;
  cleanup = () => { release(); host.coordinator.reset(); host.close(); db.close(); oldCleanup(); };
  const handlers = createWsHandlers(host, testPrincipal());
  const frames: any[] = [];
  const ws = { send: (data: string) => frames.push(JSON.parse(data)) } as WSContext;
  await handlers.onOpen(undefined as never, ws);
  const send = (frame: unknown) => handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  send({ type: "conversation_start" });
  await until(() => frames.some((m) => m.type === "conversation_opened"));
  const { conversationId, epoch } = frames.find((m) => m.type === "conversation_opened");
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "u1", sequence: 0, rate: 16000, pcm: "AAA=" });
  await until(() => f.sent.some((m) => m.realtimeInput?.audio));
  send({ type: "conversation_endpoint", conversationId, epoch, utteranceId: "u1" });
  f.emit({ serverContent: { inputTranscription: { text: "Check the Ithaca note.", finished: true } } });
  f.emit({ toolCall: { functionCalls: [{ id: "host-1", name: "host_task" }] } });
  await until(() => frames.some((m) => m.event?.kind === "input_fragment"));
  expect(turns).toHaveLength(0);
  send({ type: "conversation_commit", conversationId, epoch, utteranceId: "u1", requestId: "request-1", text: "Check the Ithaca note." });
  await until(() => frames.some((m) => m.type === "ask_user_request"));
  expect(frames.some((m) => m.type === "text_delta" && m.text === "Checking the harbour notes.")).toBe(true);
  expect(f.sent.some((m) => m.toolResponse)).toBe(false);
  expect(frames.some((m) => m.type === "tool_use_start" && m.toolUseId === "lookup-1")).toBe(true);
  expect(turns[0]!.noGrantSurface).toBe(true);
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "u2", sequence: 1, rate: 16000, pcm: "AAA=" });
  await until(() => f.sent.filter((m) => m.realtimeInput?.audio).length === 2);
  f.emit({ serverContent: { inputTranscription: { text: "Also check the harbour fees.", finished: true } } });
  await until(() => frames.some((m) => m.event?.kind === "input_fragment" && m.event.utteranceId === "u2"));
  const card = frames.find((m) => m.type === "ask_user_request");
  send({ type: "ask_user_response", submissionId: "answer-1", sessionId: "sess-ithaca", turnId: card.turnId, requestId: "q1", answers: { "Which watch?": "Morning" } });
  release();
  await until(() => f.sent.some((m) => m.toolResponse));
  expect(f.sent.find((m) => m.toolResponse).toolResponse.functionResponses[0]).toMatchObject({ id: "host-1", scheduling: "WHEN_IDLE", willContinue: false });
  expect(frames.some((m) => m.type === "result")).toBe(true);
});


test("unconsumed event overflow closes capture and replaces stale audio with a visible error", async () => {
  const f = await fixture(true, false);
  for (let i = 0; i < 260; i++) f.emit({ serverContent: { outputTranscription: { text: "The Ithaca reply." } } });
  await until(f.remoteClosed);
  const events = f.session.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ kind: "error", message: "Gemini Live event queue overflow." });
  expect((await events.next()).done).toBe(true);
  expect(() => f.session.appendAudio({ utteranceId: "u1", sequence: 0, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("ended");
});
