/** Real primary WebSocket transport redirected to a loopback fixture, no keys/network. */
import { afterEach, expect, test } from "bun:test";
import type { SessionStartEvent, SessionStartedEvent, InputTranscriptDeltaEvent, DelegationCreatedEvent } from "openai/resources/live/live";
import type { StartTurnRequest, LiveConversationEvent, LiveConversationSession } from "@schlessera/brain-ui-sdk/server";
import { createGptLiveConversationProvider } from "../src/voice/gpt-live-conversation";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
const NativeWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; Object.defineProperty(globalThis, "WebSocket", descriptor); });
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error("transport condition timed out"); await Bun.sleep(1); }
}
async function fixture(ack = true, consume = true) {
  const sent: any[] = [];
  const received: LiveConversationEvent[] = [];
  let remote: Bun.ServerWebSocket<undefined> | undefined;
  let url = ""; let authorization: string | null = null;
  const server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { authorization = req.headers.get("authorization"); if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { remote = ws; },
      message(ws, frame) {
        const m = JSON.parse(String(frame)); sent.push(m);
        if (m.type === "session.start" && ack) {
          const started: SessionStartedEvent = { type: "session.started", event_id: "started", session: {
            id: "live-ithaca", model: "gpt-live-1", status: "active", expires_at: Date.UTC(2026, 6, 12) / 1000 + 300,
            store: false, delegation: { type: "client" },
          } };
          ws.send(JSON.stringify(started));
        }
        if (m.type === "session.close") ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested" }));
      },
    },
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
    static OPEN = 1;
    constructor(target: string, options?: Bun.WebSocketOptions) { url = target; super(`ws://127.0.0.1:${server.port}`, options); }
  } });
  const abort = new AbortController();
  cleanup = () => { abort.abort(); remote?.close(); server.stop(true); };
  const provider = createGptLiveConversationProvider("keyless-odyssey-placeholder");
  const opening = provider.open({ conversationId: "ithaca", epoch: 1 }, { signal: abort.signal, resync: { work: [] } });
  await until(() => sent.some((m) => m.type === "session.start"));
  let session: LiveConversationSession | undefined;
  if (ack) {
    session = await opening;
    if (consume) {
      void (async () => { for await (const e of session!.events) received.push(e); })();
      await until(() => received.some((e) => e.kind === "ready"));
    }
  }
  return { provider, session: session!, opening, sent, received, abort,
    url: () => url, authorization: () => authorization,
    emit: (frame: unknown) => remote!.send(JSON.stringify(frame)), remoteClosed: () => remote!.readyState !== 1,
    closeRemote: () => remote!.close(),
    async audio(utteranceId = "u1", sequence = 0) {
      session!.appendAudio({ utteranceId, sequence, rate: 24000, pcm: new Uint8Array([0, 0]) });
      await until(() => sent.filter((m) => m.type === "session.input_audio.append").length > sequence);
      return sent.filter((m) => m.type === "session.input_audio.append").at(-1).event_id as string;
    },
  };
}
const ref = (nativeHandle = "delegation-1") => ({ conversationId: "ithaca", epoch: 1, utteranceId: "u1", turnId: "t1", requestId: "r1", nativeHandle });
const result = { outcome: "completed" as const, facts: "The Ithaca note was captured.", delivery: "when-idle" as const };
const input = (delta: string, event_id: string, client_event_id?: string) => ({ type: "session.input_transcript.delta", event_id, delta, start_ms: 0, end_ms: 20, ...(client_event_id ? { client_event_id } : {}) } satisfies InputTranscriptDeltaEvent);
const delegation = (id = "delegation-1", client_event_id?: string) => ({ type: "session.delegation.created", event_id: `event-${id}`, offset_ms: 20, delegation: { id, type: "delegation", target: "client" }, ...(client_event_id ? { client_event_id } : {}) } satisfies DelegationCreatedEvent);

test("GPT-Live starts the exact selected typed configuration with server Bearer auth", async () => {
  const f = await fixture();
  const expected: SessionStartEvent = { type: "session.start", session: { model: "gpt-live-1", audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } }, delegation: { type: "client" }, store: false, input: [] } };
  expect(f.sent[0]).toMatchObject(expected);
  expect(f.url()).toBe("wss://api.openai.com/v1/live/sessions");
  expect(f.authorization()).toBe("Bearer keyless-odyssey-placeholder");
  expect(JSON.stringify(f.provider)).not.toContain("keyless-odyssey-placeholder");
  expect(f.provider.capabilities).toMatchObject({ nonblockingWork: "supported", finalTranscript: "unsupported", exactPermissionSpeech: "unsupported", echoIsolatedInput: "unproven", remoteOutputCancelAck: "unproven" });
  expect(() => createGptLiveConversationProvider(" ")).toThrow("server API key");
});

test("async delegation permits a second input and audio output before the first host result", async () => {
  const f = await fixture(); const first = await f.audio(); f.session.markEndpoint("u1");
  f.emit(input("Capture the Ithaca note.", "in-1", first)); f.emit(delegation("delegation-1", first));
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  let release!: () => void;
  const returning = new Promise<void>((resolve) => { release = resolve; }).then(() => f.session.returnWork(ref(), result));
  const second = await f.audio("u2", 1);
  f.emit(input("Also check the harbour fees.", "in-2", second));
  f.emit({ type: "session.output_audio.delta", delta: "AAA=" });
  await until(() => f.received.some((e) => e.kind === "input_fragment" && e.utteranceId === "u2") && f.received.some((e) => e.kind === "audio"));
  expect(f.sent.some((m) => m.type === "session.commentary.append")).toBe(false);
  release(); await returning;
  await until(() => f.sent.some((m) => m.type === "session.commentary.append"));
  expect(f.sent.find((m) => m.type === "session.commentary.append")).toMatchObject({ delegation_id: "delegation-1", content: result.facts });
  await expect(f.session.returnWork(ref(), result)).rejects.toThrow("correlation");
  expect(f.received.find((e) => e.kind === "input_fragment")).toMatchObject({ finalization: "unknown", certainty: "unknown", origin: "unknown" });
  expect(f.sent.some((m) => /response\.cancel|audio.*commit/.test(m.type))).toBe(false);
});

test("delayed original input retains its audio command identity after another utterance starts", async () => {
  const f = await fixture(); const first = await f.audio(); f.session.markEndpoint("u1");
  const second = await f.audio("u2", 1);
  f.emit(input("Harbour fees.", "in-2", second)); f.emit(input("The Ithaca note.", "in-1", first));
  await until(() => f.received.filter((e) => e.kind === "input_fragment").length === 2);
  expect(f.received.filter((e) => e.kind === "input_fragment").map((e) => e.kind === "input_fragment" ? [e.utteranceId, e.text] : [])).toEqual([["u2", "Harbour fees."], ["u1", "The Ithaca note."]]);
});

test("uncorrelated input after multiple utterances closes rather than borrowing the newest identity", async () => {
  const f = await fixture(); await f.audio(); f.session.markEndpoint("u1"); await f.audio("u2", 1);
  f.emit(input("Uncertain attribution.", "ambiguous"));
  await until(() => f.received.some((e) => e.kind === "error"));
  expect(f.received.some((e) => e.kind === "input_fragment")).toBe(false);
});

for (const mode of ["abort", "close", "epoch", "conversation", "unknown-handle", "utterance"] as const) {
  test(`stale delegation result rejects after ${mode}`, async () => {
    const f = await fixture(); const command = await f.audio(); f.emit(delegation("delegation-1", command));
    await until(() => f.received.some((e) => e.kind === "work_requested"));
    if (mode === "abort") f.abort.abort();
    if (mode === "close") await f.session.close();
    await expect(f.session.returnWork({ ...ref(mode === "unknown-handle" ? "missing" : "delegation-1"),
      ...(mode === "epoch" ? { epoch: 2 } : {}), ...(mode === "conversation" ? { conversationId: "troy" } : {}),
      ...(mode === "utterance" ? { utteranceId: "u2" } : {}),
    }, result)).rejects.toThrow("correlation");
    expect(f.sent.filter((m) => m.type === "session.commentary.append")).toHaveLength(0);
  });
}

test("large host facts use bounded quiet chunks then one commentary with the original delegation", async () => {
  const f = await fixture(); await f.audio(); f.emit(delegation());
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  const facts = "Ithaca harbour. ".repeat(150);
  await f.session.returnWork(ref(), { ...result, facts });
  await until(() => f.sent.some((m) => m.type === "session.commentary.append"));
  const updates = f.sent.filter((m) => /session\.(thinking|commentary)\.append/.test(m.type));
  expect(updates.map((m) => m.content).join("")).toBe(facts);
  expect(updates.every((m) => m.delegation_id === "delegation-1" && Buffer.byteLength(m.content) <= 500)).toBe(true);
  expect(updates.filter((m) => m.type === "session.commentary.append")).toHaveLength(1);
  expect(updates.at(-1).type).toBe("session.commentary.append");
});

test("quiet host results never request commentary", async () => {
  const f = await fixture(); await f.audio(); f.emit(delegation());
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  await f.session.returnWork(ref(), { ...result, delivery: "quiet" });
  await until(() => f.sent.some((m) => m.type === "session.thinking.append"));
  expect(f.sent.filter((m) => m.type === "session.commentary.append")).toHaveLength(0);
});

test("a session.closed receipt acknowledges whole-session close without claiming output cancellation", async () => {
  const f = await fixture();
  expect(await f.session.close()).toEqual({ remote: "acknowledged" });
  expect(f.provider.capabilities.remoteOutputCancelAck).toBe("unproven");
});

test("remote connection loss reports unknown finalization and denies more capture", async () => {
  const f = await fixture(); f.closeRemote();
  await until(() => f.received.some((e) => e.kind === "closed"));
  expect(f.received.at(-1)).toMatchObject({ kind: "closed", remote: "unknown" });
  expect(() => f.session.appendAudio({ utteranceId: "u1", sequence: 0, rate: 24000, pcm: new Uint8Array([0, 0]) })).toThrow("ended");
});

test("handshake errors redact remote credential-bearing diagnostics", async () => {
  const f = await fixture(false);
  f.emit({ type: "error", error: { message: "Bearer keyless-odyssey-placeholder" } });
  await expect(f.opening).rejects.toThrow("GPT-Live provider error.");
});

test("no pre-ready provider output is admitted", async () => {
  const f = await fixture(false); f.emit({ type: "session.output_audio.delta", delta: "AAA=" });
  await expect(f.opening).rejects.toThrow("invalid");
});

test("unconsumed output overflow ends the epoch with a visible error", async () => {
  const f = await fixture(true, false);
  for (let i = 0; i < 260; i++) f.emit({ type: "session.output_audio.delta", delta: "AAA=" });
  await until(f.remoteClosed);
  const events = f.session.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ kind: "error", message: "GPT-Live event queue overflow." });
  expect((await events.next()).done).toBe(true);
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
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "u1", sequence: 0, rate: 24000, pcm: "AAA=" });
  await until(() => f.sent.some((m) => m.type === "session.input_audio.append"));
  send({ type: "conversation_endpoint", conversationId, epoch, utteranceId: "u1" });
  f.emit(input("Check the Ithaca note.", "host-input-1"));
  f.emit(delegation("host-1"));
  await until(() => frames.some((m) => m.event?.kind === "input_fragment"));
  expect(turns).toHaveLength(0);
  send({ type: "conversation_commit", conversationId, epoch, utteranceId: "u1", requestId: "request-1", text: "Check the Ithaca note." });
  await until(() => frames.some((m) => m.type === "ask_user_request"));
  expect(frames.some((m) => m.type === "text_delta" && m.text === "Checking the harbour notes.")).toBe(true);
  expect(f.sent.some((m) => m.type === "session.commentary.append")).toBe(false);
  expect(frames.some((m) => m.type === "tool_use_start" && m.toolUseId === "lookup-1")).toBe(true);
  expect(turns[0]!.noGrantSurface).toBe(true);
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "u2", sequence: 1, rate: 24000, pcm: "AAA=" });
  await until(() => f.sent.filter((m) => m.type === "session.input_audio.append").length === 2);
  f.emit(input("Also check the harbour fees.", "host-input-2", f.sent.filter((m) => m.type === "session.input_audio.append").at(-1).event_id));
  await until(() => frames.some((m) => m.event?.kind === "input_fragment" && m.event.utteranceId === "u2"));
  const card = frames.find((m) => m.type === "ask_user_request");
  send({ type: "ask_user_response", submissionId: "answer-1", sessionId: "sess-ithaca", turnId: card.turnId, requestId: "q1", answers: { "Which watch?": "Morning" } });
  release();
  await until(() => f.sent.some((m) => m.type === "session.commentary.append"));
  expect(f.sent.find((m) => m.type === "session.commentary.append")).toMatchObject({ delegation_id: "host-1" });
  expect(frames.some((m) => m.type === "result")).toBe(true);
});




test("replacement epoch seeds host outcomes as history without replaying audio or delegated effects", async () => {
  const f = await fixture(); await f.audio(); f.emit(delegation());
  await until(() => f.received.some((e) => e.kind === "work_requested"));
  await f.session.close();
  const abort = new AbortController(); const oldCleanup = cleanup!;
  cleanup = () => { abort.abort(); oldCleanup(); };
  const next = await f.provider.open({ conversationId: "ithaca", epoch: 2 }, { signal: abort.signal, resync: { work: [{
    conversationId: "ithaca", epoch: 1, utteranceId: "u1", requestId: "r1", turnId: "t1", state: "completed", delivery: "discarded", recognized: "Capture the Ithaca note.", submitted: "Capture the Ithaca note.",
  }] } });
  expect(f.sent.filter((m) => m.type === "session.start").at(-1).session.input[0]).toMatchObject({ role: "user", content: [{ type: "input_text" }] });
  expect(f.sent.filter((m) => m.type === "session.input_audio.append")).toHaveLength(1);
  await expect(next.returnWork(ref(), result)).rejects.toThrow("correlation");
  await next.close();
  expect(f.sent.some((m) => m.type === "session.commentary.append")).toBe(false);
});


test("historical zero-duration transcript text is never relabeled as a fresh microphone utterance", async () => {
  const f = await fixture(); await f.audio();
  f.emit({ ...input("Historical context.", "context-1"), end_ms: 0 });
  f.emit(input("The new Ithaca note.", "actual-1"));
  await until(() => f.received.some((e) => e.kind === "input_fragment" && e.text === "The new Ithaca note."));
  expect(f.received.filter((e) => e.kind === "input_fragment").map((e) => e.kind === "input_fragment" ? e.text : "")).toEqual(["The new Ithaca note."]);
});


test("a delegation with an unknown explicit audio command identity is not rebound implicitly", async () => {
  const f = await fixture(); await f.audio(); f.emit(delegation("foreign", "unknown-command"));
  await until(() => f.received.some((e) => e.kind === "error" || e.kind === "work_requested"));
  expect(f.received.some((e) => e.kind === "work_requested")).toBe(false);
  expect(f.received.some((e) => e.kind === "error")).toBe(true);
});


test("the native primary socket refuses redirects instead of forwarding Bearer credentials", async () => {
  let redirectedRequests = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { redirectedRequests++; return new Response(null, { status: 400 }); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}` } }); } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
    static OPEN = 1;
    constructor(_url: string, options?: Bun.WebSocketOptions) { super(`ws://127.0.0.1:${source.port}`, options); }
  } });
  const abort = new AbortController();
  cleanup = () => { abort.abort(); source.stop(true); target.stop(true); };
  await expect(createGptLiveConversationProvider("keyless-odyssey-placeholder").open({ conversationId: "ithaca", epoch: 1 }, { signal: abort.signal, resync: { work: [] } })).rejects.toThrow("GPT-Live connection failed.");
  expect(redirectedRequests).toBe(0);
});


test("completed input identities do not consume the host active-utterance capacity", async () => {
  const f = await fixture();
  for (let i = 0; i < 17; i++) {
    const utteranceId = `u${i}`; const nativeHandle = `delegation-${i}`;
    const audio = f.audio(utteranceId, i);
    await expect(audio).resolves.toEqual(expect.any(String));
    const command = await audio;
    f.session.markEndpoint(utteranceId);
    f.emit(input("Capture the Ithaca note.", `input-${i}`, command));
    f.emit(delegation(nativeHandle, command));
    await until(() => f.received.some((e) => e.kind === "work_requested" && e.handle === nativeHandle));
    await f.session.returnWork({ ...ref(nativeHandle), utteranceId, turnId: `t${i}`, requestId: `r${i}` }, { ...result, delivery: "quiet" });
  }
  await until(() => f.sent.filter((m) => m.type === "session.thinking.append").length === 17);
  expect(f.received.some((e) => e.kind === "error")).toBe(false);
});
