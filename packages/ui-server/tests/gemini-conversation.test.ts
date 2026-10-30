/** Real Bun WebSocket transport, loopback only. No vendor session or key. */
import { afterEach, expect, test } from "bun:test";
import { contextualRefusals } from "./helpers/contextual-refusals";
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
type Wire = "text" | "binary" | "arraybuffer";
async function fixture(ack = true, consume = true, parameterless = false, wire: Wire = "text", contextualTasks = false) {
  const sent: any[] = [];
  const received: LiveConversationEvent[] = [];
  const frameTypes: string[] = [];
  let dispatch: ((data: unknown) => boolean) | undefined;
  let remote: Bun.ServerWebSocket<undefined> | undefined;
  let connectedUrl = "";
  const encode = (m: unknown) => wire === "text" ? JSON.stringify(m) : Buffer.from(JSON.stringify(m));
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { remote = ws; },
      message(ws, frame) {
        const m = JSON.parse(String(frame)); sent.push(m);
        // The fixed host_task takes no vendor arguments. Model its accepted
        // parameterless declaration at the real transport boundary (#2356),
        // rather than acknowledging any setup shape unconditionally.
        if (m.setup && parameterless && m.setup.tools.some((tool: any) => tool.functionDeclarations.some((declaration: any) =>
          declaration.parameters !== undefined || declaration.parametersJsonSchema !== undefined))) {
          ws.close(1007, "Parameterless host_task must omit its parameter schema");
          return;
        }
        if (m.setup && ack) ws.send(encode({ setupComplete: {} }));
      },
    },
  });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
    constructor(url: string | URL) {
      connectedUrl = String(url); super(`ws://127.0.0.1:${server.port}`);
      dispatch = (data) => this.dispatchEvent(new MessageEvent("message", { data }));
      if (wire === "arraybuffer") this.binaryType = "arraybuffer";
      this.addEventListener("message", (event) => frameTypes.push(
        typeof event.data === "string" ? "text" : event.data instanceof Uint8Array ? "binary" : event.data instanceof ArrayBuffer ? "arraybuffer" : "unsupported"
      ));
    }
  } });
  const abort = new AbortController();
  let session: LiveConversationSession | undefined;
  cleanup = () => { abort.abort(); remote?.close(); server.stop(true); };
  const provider = createGeminiConversationProvider("keyless-odyssey-placeholder");
  const opening = provider.open({ conversationId: "ithaca", epoch: 1 }, { signal: abort.signal, contextualTasks, resync: { work: [] } });
  await until(() => !!remote);
  await until(() => sent.some((m) => m.setup));
  if (ack) {
    session = await opening;
    if (consume) {
      void (async () => { for await (const e of session!.events) received.push(e); })();
      await until(() => received.some((e) => e.kind === "ready"));
    }
  }
  return { provider, opening, session: session!, abort, sent, received, frameTypes,
    url: () => connectedUrl,
    emit: (m: unknown) => remote!.send(encode(m)),
    emitRaw: (frame: string | Uint8Array | ArrayBuffer) => remote!.send(frame),
    dispatch: dispatch!,
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

test("Gemini parameterless host_task completes a schema-checking peer handshake", async () => {
  await expect(fixture(true, true, true)).resolves.toMatchObject({ provider: { id: "gemini-live" } });
});

// Empty envelopes carry no meaning; check raw keys before schema stripping.
for (const wire of ["text", "binary", "arraybuffer"] as const) {
  test(`Gemini ${wire} literal empty envelope permits later transcript and audio without authority`, async () => {
    const f = await fixture(true, true, false, wire);
    await f.audio(); f.session.markEndpoint("u1");
    f.emit({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "1s" } });
    f.emit({});
    f.emit({ serverContent: {
      inputTranscription: { text: "Check the Ithaca note." },
      outputTranscription: { text: "The ship is ready for Ithaca." },
      modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] },
    } });
    await until(() => f.received.length > 1);
    expect(f.received.map((e) => e.kind)).toEqual(["ready", "input_fragment", "output_transcript", "audio"]);
    expect(f.frameTypes).toEqual([wire, wire, wire, wire]);
    expect(f.received[1]).toMatchObject({ utteranceId: "u1", sequence: 0,
      finalization: "unknown", certainty: "unknown", origin: "unknown" });
    const output = f.received[2] as Extract<LiveConversationEvent, { kind: "output_transcript" }>;
    expect(output).toMatchObject({ sequence: 0, text: "The ship is ready for Ithaca." });
    expect(f.received[3]).toMatchObject({ outputId: output.outputId, sequence: 1, pcm: new Uint8Array([0, 0]) });
    expect(f.provider.capabilities).toMatchObject({ finalTranscript: "unproven", remoteOutputCancelAck: "unproven",
      exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" });
    await until(() => f.sent.some((m) => m.realtimeInput?.activityEnd));
    expect(f.sent.length).toBe(4); // setup, activityStart, audio, activityEnd only
    expect(() => f.session.appendAudio({ utteranceId: "u2", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("correlation");
  });

  test(`Gemini ${wire} empty envelope cannot replace setupComplete`, async () => {
    const f = await fixture(false, false, false, wire);
    f.emit({});
    f.emit({ setupComplete: {} });
    await expect(f.opening).rejects.toThrow("invalid or uncorrelatable frame");
  });

  for (const [label, frame] of [
    ["null JSON", "null"], ["empty array", "[]"], ["string JSON", '\"\"'],
    ["number JSON", "0"], ["boolean JSON", "false"], ["malformed JSON", "{"],
    ["unknown-only nonempty", '{"futureProviderField":{}}'],
    ["malformed recognized", '{"serverContent":false}'],
    ["oversized empty envelope", " ".repeat(262143) + "{}"],
  ]) {
    test(`Gemini ${wire} ${label} remains rejected after empty envelope`, async () => {
      const f = await fixture(true, true, false, wire);
      f.emit({});
      f.emitRaw(wire === "text" ? frame! : Buffer.from(frame!));
      f.emit({ serverContent: { outputTranscription: { text: "Must not be delivered." } } });
      await until(() => f.received.length > 1);
      expect(f.received.map((e) => e.kind)).toEqual(["ready", "error"]);
      expect(f.frameTypes.length).toBeGreaterThanOrEqual(3); // rejection reached the second frame
      expect(f.received[1]).toMatchObject({ message: "Gemini Live returned an invalid or uncorrelatable frame." });
    });
  }
}

// Provider VAD metadata is transport bookkeeping, never acoustic attribution.
for (const wire of ["text", "binary", "arraybuffer"] as const) {
  test(`Gemini ${wire} voiceActivity metadata preserves subsequent audio and unknown input attribution`, async () => {
    const f = await fixture(true, true, false, wire);
    await f.audio();
    for (const voiceActivity of [
      {}, { type: "TYPE_UNSPECIFIED" },
      { type: "ACTIVITY_START", audioOffset: "0s" },
      { type: "ACTIVITY_END", audioOffset: "1.250s" },
    ]) f.emit({ voiceActivity });
    f.emit({
      voiceActivity: { type: "ACTIVITY_START", audioOffset: "2s" },
      serverContent: {
        inputTranscription: { text: "brain, stop", finished: true },
        modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    await until(() => f.received.length > 1);
    expect(f.received.map((event) => event.kind)).toEqual(["ready", "input_fragment", "audio"]);
    expect(f.received[1]).toMatchObject({ text: "brain, stop", origin: "unknown", certainty: "unknown", utteranceId: "u1" });
    expect(f.provider.capabilities.echoIsolatedInput).toBe("unproven");
    expect(f.provider.capabilities.finalTranscript).toBe("unproven");
    f.session.markEndpoint("u1");
    await f.audio("u2", 1);
    expect(f.sent.some((frame) => frame.toolResponse)).toBe(false);
  });
}

for (const [label, voiceActivity] of [
  ["null", null], ["non-object", "ACTIVITY_START"],
  ["unknown type", { type: "USER_IDENTIFIED" }],
  ["non-string type", { type: 1 }],
  ["non-string offset", { audioOffset: 0 }],
  ["malformed duration", { audioOffset: "not-a-duration" }],
  ["excess precision", { audioOffset: "1.1234567890s" }],
  ["missing seconds suffix", { audioOffset: "1.250" }],
  ["oversized offset", { audioOffset: "1".repeat(65) + "s" }],
] as const) {
  test(`Gemini malformed voiceActivity ${label} fails closed`, async () => {
    const f = await fixture();
    f.emit({ voiceActivity });
    f.emit({ serverContent: { outputTranscription: { text: "Must not be delivered." } } });
    await until(() => f.received.length > 1);
    expect(f.received.map((event) => event.kind)).toEqual(["ready", "error"]);
    expect(f.received.at(-1)).toMatchObject({ message: "Gemini Live returned an invalid or uncorrelatable frame." });
  });
}

test("Gemini voiceActivity cannot hide malformed tools", async () => {
  const f = await fixture();
  f.emit({ voiceActivity: { type: "ACTIVITY_START" }, toolCall: { functionCalls: [{ id: "x", name: "Bash" }] } });
  await until(() => f.received.length > 1);
  expect(f.received.map((event) => event.kind)).toEqual(["ready", "error"]);
});

test("Gemini standalone metadata before input accepts defaults without emitting authority", async () => {
  const f = await fixture();
  for (const voiceActivity of [{}, { audioOffset: "0s" }, { type: "TYPE_UNSPECIFIED" },
    { type: "ACTIVITY_START", audioOffset: "-0.123456789s" }]) f.emit({ voiceActivity });
  f.emit({ serverContent: { outputTranscription: { text: "The Ithaca view." } } });
  await until(() => f.received.length > 1);
  expect(f.received.map((e) => e.kind)).toEqual(["ready", "output_transcript"]);
  f.emit({ voiceActivity: { type: "ACTIVITY_START" }, serverContent: { inputTranscription: { text: "brain, stop" } } });
  await until(() => f.received.length > 2);
  expect(f.received.map((e) => e.kind)).toEqual(["ready", "output_transcript", "error"]);
});

test("Gemini activity end cannot finalize an input or release correlation", async () => {
  const f = await fixture();
  await f.audio(); f.session.markEndpoint("u1");
  f.emit({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "1s" },
    serverContent: { inputTranscription: { text: "Check the Ithaca note." } } });
  await until(() => f.received.length > 1);
  expect(f.received[1]).toMatchObject({ finalization: "unknown", certainty: "unknown", origin: "unknown" });
  expect(() => f.session.appendAudio({ utteranceId: "u2", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("correlation");
});

for (const [label, frame] of [
  ["unknown-only", { futureProviderField: {} }],
  ["mixed invalid audio", { voiceActivity: {}, serverContent: { modelTurn: { parts: [
    { inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=16000" } },
  ] } } }],
] as const) {
  test(`Gemini ${label} frame still fails closed`, async () => {
    const f = await fixture();
    f.emit(frame);
    await until(() => f.received.length > 1);
    expect(f.received.map((e) => e.kind)).toEqual(["ready", "error"]);
    expect(f.received[1]).toMatchObject({ message: "Gemini Live returned an invalid or uncorrelatable frame." });
  });
}

for (const wire of ["binary", "arraybuffer"] as const) {
  test(`Gemini ${wire} UTF-8 JSON completes the real Bun handshake`, async () => {
    await expect(fixture(true, true, false, wire)).resolves.toMatchObject({
      frameTypes: [wire], received: [{ kind: "ready", conversationId: "ithaca", epoch: 1 }],
    });
  });

  test(`Gemini ${wire} frames preserve input, audio, interruption and advisory tool order`, async () => {
    const f = await fixture(true, true, false, wire);
    await f.audio(); f.session.markEndpoint("u1");
    f.emit({ serverContent: {
      inputTranscription: { text: "Capture the Ithaca note \u2014 safely.", finished: true },
      outputTranscription: { text: "Checking the harbour." },
      modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] },
      interrupted: true,
    } });
    f.emit({ toolCall: { functionCalls: [{ id: "native-1", name: "host_task", args: { utteranceId: "untrusted", task: "Untrusted replacement" } }] } });
    f.emit({ toolCallCancellation: { ids: ["native-1"] } });
    // Interleave text with binary on the same socket, without waiting between messages.
    f.emitRaw(JSON.stringify({ serverContent: { outputTranscription: { text: "The Ithaca reply." } } }));
    await until(() => f.received.length >= 8);
    expect(f.received.map((event) => event.kind)).toEqual([
      "ready", "input_fragment", "output_transcript", "audio", "interrupted", "work_requested", "work_withdrawn", "output_transcript",
    ]);
    expect(f.received[1]).toMatchObject({ utteranceId: "u1", sequence: 0, text: "Capture the Ithaca note \u2014 safely.", finalization: "final", certainty: "unknown", origin: "unknown" });
    const output = f.received[2] as Extract<LiveConversationEvent, { kind: "output_transcript" }>;
    expect(output.sequence).toBe(0);
    expect(f.received[3]).toMatchObject({ outputId: output.outputId, sequence: 1, format: { encoding: "pcm16", sampleRate: 24000, channels: 1 }, pcm: new Uint8Array([0, 0]) });
    expect(f.received[4]).toMatchObject({ outputId: output.outputId });
    expect(f.received[5]).toEqual({ conversationId: "ithaca", epoch: 1, kind: "work_requested", handle: "native-1" });
    expect(f.received[6]).toEqual({ conversationId: "ithaca", epoch: 1, kind: "work_withdrawn", handle: "native-1" });
    expect(f.received[7]).toMatchObject({ kind: "output_transcript", sequence: 0, text: "The Ithaca reply." });
    expect(f.received[7]).not.toMatchObject({ outputId: output.outputId });
    await expect(f.session.returnWork(ref(), result)).rejects.toThrow("correlation");
    expect(f.sent.some((m) => m.toolResponse)).toBe(false);
  });

  for (const mode of ["abort", "close", "replacement"] as const) {
    test(`Gemini late ${wire} callbacks cannot revive an epoch after ${mode}`, async () => {
      const f = await fixture(true, false, false, wire);
      if (mode === "close") await f.session.close();
      else f.abort.abort();
      const replacement = mode === "replacement" ? await f.provider.open(
        { conversationId: "ithaca", epoch: 2 }, { signal: new AbortController().signal, resync: { work: [] } }
      ) : undefined;
      try {
        const lateFrame = (frame: unknown) => {
          const bytes = new TextEncoder().encode(JSON.stringify(frame));
          f.dispatch(wire === "arraybuffer" ? bytes.buffer : bytes);
        };
        lateFrame({});
        lateFrame({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "1s" } });
        lateFrame({ setupComplete: {} });
        lateFrame({ toolCall: { functionCalls: [{ id: "late", name: "host_task" }] } });
        const events = [];
        for await (const event of f.session.events) events.push(event);
        expect(events.map((event) => event.kind)).toEqual(mode === "close" ? [] : ["error"]);
        await expect(f.session.returnWork(ref("late"), result)).rejects.toThrow("correlation");
        if (replacement) {
          const current = replacement.events[Symbol.asyncIterator]();
          expect((await current.next()).value).toMatchObject({ kind: "ready", epoch: 2 });
          f.emit({ serverContent: { outputTranscription: { text: "A fresh Ithaca reply." } } });
          expect((await current.next()).value).toMatchObject({ kind: "output_transcript", epoch: 2, text: "A fresh Ithaca reply." });
        }
      } finally { await replacement?.close(); }
    });
  }
}

for (const wire of ["text", "binary", "arraybuffer"] as const) {
  test(`Gemini ${wire} JSON accepts exactly the 256 KiB frame limit`, async () => {
    const f = await fixture(true, true, false, wire);
    const overhead = JSON.stringify({ usageMetadata: { padding: "" } }).length;
    const frame = JSON.stringify({ usageMetadata: { padding: " ".repeat(262144 - overhead) } });
    expect(Buffer.byteLength(frame)).toBe(262144);
    f.emitRaw(wire === "text" ? frame : Buffer.from(frame));
    f.emit({ serverContent: { outputTranscription: { text: "The bounded Ithaca reply." } } });
    await until(() => f.received.length > 1);
    expect(f.received.at(-1)).toMatchObject({ kind: "output_transcript", text: "The bounded Ithaca reply." });
  });

  for (const encoding of ["ascii", "multibyte"] as const) {
    test(`Gemini oversized ${encoding} ${wire} JSON fails closed at the byte bound`, async () => {
      const f = await fixture(true, true, false, wire);
      const overhead = JSON.stringify({ usageMetadata: { padding: "" } }).length;
      const padding = encoding === "ascii" ? " ".repeat(262145 - overhead) : "\u03c0".repeat(131072);
      const frame = JSON.stringify({ usageMetadata: { padding } });
      expect(Buffer.byteLength(frame)).toBeGreaterThan(262144);
      if (encoding === "multibyte") expect(frame.length).toBeLessThan(262144);
      f.emitRaw(wire === "text" ? frame : Buffer.from(frame));
      f.emit({ serverContent: { outputTranscription: { text: "The rejected Ithaca reply." } } });
      await until(() => f.received.length > 1);
      expect(f.received.at(-1)).toEqual({ conversationId: "ithaca", epoch: 1, kind: "error", message: "Gemini Live returned an invalid or uncorrelatable frame." });
      expect(() => f.session.appendAudio({ utteranceId: "u1", sequence: 0, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("ended");
    });
  }
}

for (const [label, frame] of [
  ["malformed JSON", Buffer.from('{"error":"keyless-odyssey-placeholder"')],
  ["invalid UTF-8", Buffer.concat([Buffer.from('{"serverContent":{"outputTranscription":{"text":"'), Buffer.from([0xff]), Buffer.from('"}}}')])],
  ["invalid tool schema", Buffer.from(JSON.stringify({ toolCall: { functionCalls: [{ id: "x", name: "Bash" }] } }))],
] as const) {
  test(`Gemini binary ${label} fails without exposing remote payloads`, async () => {
    const f = await fixture();
    f.emitRaw(frame);
    await until(() => f.received.length > 1);
    expect(f.received.at(-1)).toEqual({ conversationId: "ithaca", epoch: 1, kind: "error", message: "Gemini Live returned an invalid or uncorrelatable frame." });
    expect(JSON.stringify(f.received)).not.toContain("keyless-odyssey-placeholder");
  });
}

test("Gemini binary provider errors redact authentication details", async () => {
  const f = await fixture(false);
  f.emitRaw(Buffer.from(JSON.stringify({ error: { message: f.url() } })));
  await expect(f.opening).rejects.toThrow("Gemini Live provider error.");
});

test("Gemini byte views decode only their visible range", async () => {
  const f = await fixture();
  const frame = Buffer.from(JSON.stringify({ serverContent: { outputTranscription: { text: "The Ithaca view." } } }));
  const backing = new Uint8Array(262145 + frame.length);
  backing.fill(0xff); backing.set(frame, 1);
  f.dispatch(backing.subarray(1, 1 + frame.length));
  await until(() => f.received.length > 1);
  expect(f.received.at(-1)).toMatchObject({ kind: "output_transcript", text: "The Ithaca view." });
});

for (const [label, data] of [
  ["Blob", new Blob([JSON.stringify({ usageMetadata: {} })])],
  ["DataView", new DataView(new ArrayBuffer(4))],
  ["object", { setupComplete: {} }],
  ["null", null],
] as const) {
  test(`Gemini unsupported ${label} message data fails closed`, async () => {
    const f = await fixture();
    f.dispatch(data);
    await until(() => f.received.length > 1);
    expect(f.received.at(-1)).toEqual({ conversationId: "ithaca", epoch: 1, kind: "error", message: "Gemini Live returned an invalid or uncorrelatable frame." });
  });
}

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


test.each(["text", "binary"] as const)("real %s adapter and host keep chat progress and a question interactive while async work awaits", async (wire) => {
  const f = await fixture(true, true, false, wire);
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
  expect(turns[0]!.noGrantSurface).toBeUndefined();
  send({ type: "conversation_audio", conversationId, epoch, utteranceId: "u2", sequence: 1, rate: 16000, pcm: "AAA=" });
  await until(() => f.sent.filter((m) => m.realtimeInput?.audio).length === 2);
  f.emit({ serverContent: { inputTranscription: { text: "Also check the harbour fees.", finished: true } } });
  await until(() => frames.some((m) => m.event?.kind === "input_fragment" && m.event.utteranceId === "u2"));
  const card = frames.find((m) => m.type === "ask_user_request");
  send({ type: "ask_user_response", submissionId: "answer-1", sessionId: "sess-ithaca", turnId: card.turnId, requestId: "q1", answers: { "Which watch?": "Morning" } });
  release();
  await until(() => frames.some((m) => m.type === "result"));
  // This older reviewed client supplied no contextual negotiation and Gemini
  // supplied no input identity: the advisory cannot borrow the manual result.
  expect(f.sent.some((m) => m.toolResponse)).toBe(false);
});


test.each(["text", "binary"] as const)("unconsumed %s event overflow closes capture and replaces stale audio with a visible error", async (wire) => {
  const f = await fixture(true, false, false, wire);
  for (let i = 0; i < 260; i++) f.emit({ serverContent: { outputTranscription: { text: "The Ithaca reply." } } });
  await until(f.remoteClosed);
  const events = f.session.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ kind: "error", message: "Gemini Live event queue overflow." });
  expect((await events.next()).done).toBe(true);
  expect(() => f.session.appendAudio({ utteranceId: "u1", sequence: 0, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("ended");
});


test("a transcription finish marker cannot cover later audio appended to the same utterance", async () => {
  const f = await fixture(); await f.audio();
  f.emit({ serverContent: { inputTranscription: { text: "Capture the Ithaca note.", finished: true } } });
  await until(() => f.received.some((e) => e.kind === "input_fragment"));
  f.session.appendAudio({ utteranceId: "u1", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) });
  f.session.markEndpoint("u1");
  expect(() => f.session.appendAudio({ utteranceId: "u2", sequence: 2, rate: 16000, pcm: new Uint8Array([0, 0]) })).toThrow("correlation");
});


test("a fresh finish after continued audio permits the next utterance", async () => {
  const f = await fixture(); await f.audio();
  f.emit({ serverContent: { inputTranscription: { text: "Capture the Ithaca note.", finished: true } } });
  await until(() => f.received.some((e) => e.kind === "input_fragment"));
  f.session.appendAudio({ utteranceId: "u1", sequence: 1, rate: 16000, pcm: new Uint8Array([0, 0]) });
  f.session.markEndpoint("u1");
  await until(() => f.sent.filter((m) => m.realtimeInput?.audio).length === 2);
  f.emit({ serverContent: { inputTranscription: { text: "Before the departure.", finished: true } } });
  await until(() => f.received.filter((e) => e.kind === "input_fragment").length === 2);
  expect(() => f.session.appendAudio({ utteranceId: "u2", sequence: 2, rate: 16000, pcm: new Uint8Array([0, 0]) })).not.toThrow();
  await until(() => f.sent.filter((m) => m.realtimeInput?.audio).length === 3);
});

for (const finished of [false, true]) test(`contextual Gemini never assigns late recognition across capture boundaries; finished=${finished}`, async () => {
  const f = await fixture(true, true, true, "text", true);
  await f.audio("first", 0);
  f.emit({ serverContent: { inputTranscription: { text: "Find the note.", finished } } });
  await until(() => f.received.some(e => e.kind === "unassigned_input_fragment"));
  await f.audio("first", 1); // finished evidence does not cover this PCM
  f.session.markEndpoint("first");
  await f.audio("second", 2);
  f.emit({ serverContent: { inputTranscription: { text: "Late first recognition.", finished: true } } });
  await until(() => f.received.filter(e => e.kind === "unassigned_input_fragment").length === 2);
  expect(f.received.filter(e => e.kind === "unassigned_input_fragment")).toMatchObject([
    { sequence: 0, timing: { kind: "unavailable" }, finalization: finished ? "final" : "unknown" },
    { sequence: 1, timing: { kind: "unavailable" }, text: "Late first recognition." },
  ]);
  expect(f.received.some(e => e.kind === "input_fragment" || e.kind === "error")).toBe(false);
});

test("contextual Gemini result requires the exact pre-dispatch binding and never borrows reviewed work", async () => {
  const f = await fixture(true, true, true, "text", true);
  f.emit({ toolCall: { functionCalls: [{ id: "context-native", name: "host_task" }] } });
  await until(() => f.received.some(e => e.kind === "work_requested"));
  f.session.bindContextualWork!({ nativeHandle: "context-native", taskId: "task-one", requestId: "request-one" });
  const contextual = { conversationId: "ithaca", epoch: 1, provenance: "contextual" as const, taskId: "task-one", requestId: "request-one", turnId: "turn-one", nativeHandle: "context-native" };
  const result = { outcome: "completed" as const, facts: "The signal is a bronze owl.", delivery: "quiet" as const };
  await expect(f.session.returnWork({ ...contextual, taskId: "task-two" }, result)).rejects.toThrow("binding");
  await expect(f.session.returnWork({ conversationId: "ithaca", epoch: 1, utteranceId: "manual", requestId: "manual", turnId: "manual", nativeHandle: "context-native" }, result)).rejects.toThrow("borrow");
  expect(await f.session.returnWork(contextual, result)).toEqual({ acceptance: "unknown" });
  await until(() => f.sent.some(m => m.toolResponse));
  expect(f.sent.find(m => m.toolResponse).toolResponse.functionResponses[0]).toMatchObject({ id: "context-native", name: "host_task", scheduling: "SILENT", willContinue: false });
  await expect(f.session.returnWork(contextual, result)).rejects.toThrow("binding");
});

for (const mode of ["missing", "duplicate", "queue", "aged", "no-audio", "storage", "request-identity", "binding", "submission", "authorization"] as const) test(`contextual refusals release native capacity: ${mode}`, async () => {
  const f = await fixture(true, true, false, "text", true);
  const oldCleanup = cleanup!;
  await contextualRefusals("gemini", mode, f, close => { cleanup = () => { close(); oldCleanup(); }; });
});


test("contextual refusal requires exact scope and binding and permanently consumes the handle", async () => {
  const f = await fixture(true, true, false, "text", true);
  f.emit({ toolCall: { functionCalls: [{ id: "refusal", name: "host_task" }] } });
  await until(() => f.received.some(e => e.kind === "work_requested" && e.handle === "refusal"));
  const binding = { taskId: "task", requestId: "request", nativeHandle: "refusal" };
  const ref = { conversationId: "ithaca", epoch: 1, ...binding };
  expect(() => f.session.refuseContextualWork!(ref, "No recognition.")).toThrow("binding");
  f.session.bindContextualWork!(binding);
  for (const mismatch of [{ epoch: 2 }, { conversationId: "other" }, { taskId: "other" }, { requestId: "other" }, { nativeHandle: "other" }]) {
    expect(() => f.session.refuseContextualWork!({ ...ref, ...mismatch }, "No recognition.")).toThrow("binding");
  }
  f.session.refuseContextualWork!(ref, "No recognition.");
  expect(() => f.session.refuseContextualWork!(ref, "No recognition.")).toThrow();
  expect(() => f.session.bindContextualWork!(binding)).toThrow();
  await expect(f.session.returnWork({ ...ref, provenance: "contextual", turnId: "unrelated" }, result)).rejects.toThrow();
});


test("replacement context carries exact host facts with identity fences and honest outcomes", async () => {
  const f = await fixture();
  await f.session.close();
  const fact = 'The departure signal is a bronze owl.\n"Keep the blue sail."';
  const receipt = { conversationId: "ithaca", epoch: 1, utteranceId: "u1", requestId: "r1", turnId: "t1", state: "completed" as const, delivery: "unknown" as const, recognized: "Find the signal.", submitted: "Find the signal." };
  const resync = { work: [receipt,
    { ...receipt, requestId: "r2", turnId: "t2", state: "error" as const, reason: "The read failed." },
    ...(["cancelled", "refused"] as const).map(state => ({ ...receipt, requestId: state, state, delivery: "discarded" as const })),
    { ...receipt, conversationId: "troy", requestId: "foreign", recognized: "Foreign request." },
    { ...receipt, epoch: 2, requestId: "future", recognized: "Future request." },
  ], results: [
    { conversationId: "ithaca", epoch: 1, requestId: "r1", turnId: "wrong-turn", facts: "Wrong turn facts." },
    { conversationId: "ithaca", epoch: 2, requestId: "r1", turnId: "t1", facts: "Wrong epoch facts." },
    { conversationId: "troy", epoch: 1, requestId: "r1", turnId: "t1", facts: "Foreign facts." },
    { conversationId: "ithaca", epoch: 1, requestId: "r1", turnId: "t1", facts: fact },
    { conversationId: "ithaca", epoch: 1, requestId: "r2", turnId: "t2", facts: "Partial output cannot imply success." },
  ] };
  const next = await f.provider.open({ conversationId: "ithaca", epoch: 2 }, { signal: f.abort.signal, resync });
  await until(() => f.sent.some(m => m.clientContent));
  const text = f.sent.filter(m => m.clientContent).at(-1).clientContent.turns[0].parts[0].text;
  expect(f.sent.some(m => m.toolResponse)).toBe(false);
  expect(text).toContain("bronze owl");
  const entries = JSON.parse(text.slice(text.indexOf("[")));
  expect(entries).toEqual([
    { request: "Find the signal.", outcome: "completed", delivery: "unknown", hostResult: fact },
    { request: "Find the signal.", outcome: "error", delivery: "unknown", reason: "The read failed." },
    { request: "Find the signal.", outcome: "cancelled", delivery: "discarded" },
    { request: "Find the signal.", outcome: "refused", delivery: "discarded" },
  ]);
  expect(text).not.toContain("nativeHandle");
  await expect(next.returnWork(ref(), result)).rejects.toThrow("correlation");
  await next.close();
});


test("replacement context enforces per-result and aggregate limits on the real socket", async () => {
  const f = await fixture(); await f.session.close();
  const work = Array.from({ length: 6 }, (_, i) => ({ conversationId: "ithaca", epoch: 1, utteranceId: `u${i}`, requestId: `r${i}`, turnId: `t${i}`, state: "completed" as const, delivery: "discarded" as const, recognized: `Find signal ${i}.`, submitted: `Find signal ${i}.` }));
  const results = work.map((w, i) => ({ conversationId: w.conversationId, epoch: w.epoch, requestId: w.requestId, turnId: w.turnId, facts: String(i).repeat(i === 5 ? 3900 : i < 2 ? 500 : 4100) }));
  const next = await f.provider.open({ conversationId: "ithaca", epoch: 2 }, { signal: f.abort.signal, resync: { work, results } });
  await until(() => f.sent.some(m => m.clientContent));
  const text = f.sent.filter(m => m.clientContent).at(-1).clientContent.turns[0].parts[0].text;
  const entries = JSON.parse(text.slice(text.indexOf("[")));
  expect(entries.flatMap((e: { hostResult?: string }) => e.hostResult ? [e.hostResult] : [])).toEqual([2, 3, 4, 5].map(i => String(i).repeat(i === 5 ? 3900 : 4000)));
  expect(entries.every((e: { delivery: string }) => e.delivery === "discarded")).toBe(true);
  await next.close();
});
