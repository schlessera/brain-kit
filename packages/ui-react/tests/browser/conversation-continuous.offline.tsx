/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, type TestContext } from "vitest";
import { commands, userEvent, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ConversationCapabilities, type ConversationWireEvent, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { hidePage } from "./offline/fake-microphone.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-ithaca";
const CAPS: ConversationCapabilities = { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" };
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: CAPS, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fixture voice API. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width = 390, shell = false, theme: "light" | "dark" = "dark") {
  if (shell) {
    const viewport = { width: innerWidth, height: innerHeight };
    const outer = await commands.formViewport(width, 568);
    await page.viewport(width, 568);
    ctx.onTestFinished(async () => { await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width, outer.height); });
  }
  const network = installFaultNetwork({ routes: (url) => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { askReceipts: true, liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true } }); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div"); host.style.cssText = `position:fixed;inset:0;width:${width}px;height:568px`; document.body.append(host);
  const renderer = createRoot(host);
  ui.stores.ui.getState().setTheme(theme);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}>{shell ? <AppShell><ChatPage /></AppShell> : <ChatPage />}</BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(() => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  const socket = network.socket()!;
  const deliver = (message: ServerMessage & { turnId?: string }) => socket.deliver(message);
  const client = ui.connection.conversation;
  const button = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="button"],button')].find((node) => (node.getAttribute("aria-label") ?? node.textContent) === name)!;
  const event = (event: ConversationWireEvent, epoch = client.state.getState().profile!.epoch) => socket.deliver({ type: "conversation_event", conversationId: PROFILE.conversationId, epoch, event });
  const opened = (epoch = 1, caps = CAPS) => { socket.deliver({ ...PROFILE, epoch, capabilities: caps, requestId: socket.frames("conversation_start").at(-1)?.requestId }); event({ kind: "ready", input: { encoding: "pcm16", channels: 1, sampleRate: 24000 }, output: { encoding: "pcm16", channels: 1, sampleRate: 24000 } }, epoch); };
  const enter = async () => { flushSync(() => client.enter()); opened(); await expect.poll(() => button("Start")).not.toBeUndefined(); };
  const start = async () => { await enter(); await userEvent.click(button("Start")); await expect.poll(() => client.state.getState().micOn).toBe(true); await expect.poll(() => socket.frames("conversation_audio").length, { timeout: 5000 }).toBeGreaterThan(0); };
  const input = (text: string, finalization: "final" | "unknown" | "interim" = "unknown", epoch?: number) => {
    const audio = socket.frames("conversation_audio").at(-1)!;
    event({ kind: "input_fragment", utteranceId: String(audio.utteranceId), sequence: 0, text, finalization, certainty: "unknown", origin: "unknown" }, epoch);
  };
  return { ui, client, host, socket, deliver, network, button, event, opened, enter, start, input };
}

function controlledMicrophone(ctx: TestContext) {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain(); gain.gain.value = 0.15;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain); gain.connect(destination); oscillator.start(); void context.resume();
  const media = navigator.mediaDevices;
  const descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia");
  const NativeWorklet = AudioWorkletNode;
  const workletDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode")!;
  const captured: { pcm: string; speaking: boolean }[] = [];
  const targetRate = { value: 24000 };
  Object.defineProperty(globalThis, "AudioWorkletNode", { ...workletDescriptor, value: class extends NativeWorklet {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      let cursor = 0;
      this.port.addEventListener("message", ({ data }: MessageEvent<Float32Array>) => {
        const values: number[] = [];
        let energy = 0;
        for (const value of data) energy += value * value;
        for (; cursor < data.length; cursor += context.sampleRate / targetRate.value) {
          const at = Math.floor(cursor);
          const value = data[at]! + ((data[Math.min(at + 1, data.length - 1)] ?? 0) - data[at]!) * (cursor - at);
          values.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
        }
        cursor -= data.length;
        const bytes = new Uint8Array(values.length * 2); const view = new DataView(bytes.buffer);
        values.forEach((value, index) => view.setInt16(index * 2, value, true));
        captured.push({ pcm: btoa(String.fromCharCode(...bytes)), speaking: Math.sqrt(energy / data.length) > 0.015 });
      });
      this.port.start();
    }
  } });
  let opens = 0;
  const streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: async () => { opens++; const stream = destination.stream.clone(); streams.push(stream); return stream; } });
  ctx.onTestFinished(() => { Object.defineProperty(globalThis, "AudioWorkletNode", workletDescriptor); if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor); else Reflect.deleteProperty(media, "getUserMedia"); oscillator.stop(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); destination.stream.getTracks().forEach(track => track.stop()); void context.close(); });
  return { captured, targetRate, opens: () => opens, quiet: () => { gain.gain.value = 0; }, speak: () => { gain.gain.value = 0.15; }, stream: destination.stream };
}

function outputPcm(seconds = 1, audibleSeconds = seconds) {
  const bytes = new Uint8Array(Math.round(48000 * seconds));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(bytes.length / 2, audibleSeconds * 24000); i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function contextualScene(ctx: TestContext, provider: "gemini" | "gpt", action: "permitted" | "confirm" | "deny" = "permitted", width = 390, newChat = false, delayedIdentity = false) {
  const mic = controlledMicrophone(ctx); mic.targetRate.value = provider === "gemini" ? 16000 : 24000;
  const s = await scene(ctx, width, true);
  if (newChat) { s.ui.stores.chat.getState().setActiveSession(null); s.ui.stores.chat.getState().setMessages(null, []); }
  const manualDraftId = s.ui.stores.drafts.getState().idFor(newChat ? null : SESSION);
  s.ui.stores.drafts.getState().edit(manualDraftId, newChat ? null : SESSION, { text: "Keep the separate typed raft draft." });
  const fixture = await commands.conversationServer({ op: "start", contextual: true, provider, action, delayedIdentity }) as { id: string };
  ctx.onTestFinished(async () => { await commands.conversationServer({ op: "stop", id: fixture.id }); });
  let cursor = 0;
  const upstream: any[] = [];
  const downstream: ServerMessage[] = [];
  let evidence: any;
  const pump = async (provider: unknown[] = [], release = false, identify = false) => {
    const client = s.socket.sent.slice(cursor).map(bytes => JSON.parse(String(bytes.data))); cursor = s.socket.sent.length;
    evidence = await commands.conversationServer({ op: "step", id: fixture.id, client, provider, release, identify });
    upstream.push(...evidence.sent); downstream.push(...evidence.frames);
    for (const frame of evidence.frames) s.deliver(frame);
    return evidence;
  };
  s.client.enter(); await pump();
  await expect.poll(async () => { await pump(); return s.client.state.getState().profile; }).not.toBe(null);
  await userEvent.click(s.button("Start"));
  await expect.poll(() => s.client.state.getState().micOn).toBe(true);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  await pump();
  return { ...s, mic, pump, upstream, downstream, manualDraftId, evidence: () => evidence };
}

// Native inference is scripted. Capture, PCM, both adapters, host policy and
// pending work are real; no acoustic or provider-quality claim follows.
for (const provider of ["gemini", "gpt"] as const) test(`${provider} audible interruption retains the exact initiating worklet PCM through adapter/host and resumes dialogue during held work`, async ctx => {
  const s = await contextualScene(ctx, provider);
  const native = (id: string) => provider === "gemini" ? { toolCall: { functionCalls: [{ id, name: "host_task" }] } }
    : { type: "session.delegation.created", event_id: `native-${id}`, offset_ms: 500, delegation: { id, type: "delegation", target: "client" } };
  const recognize = (index: number, text: string) => provider === "gemini" ? { serverContent: { inputTranscription: { text } } }
    : { type: "session.input_transcript.delta", event_id: `recognition-${index}`, delta: text, start_ms: index * 500 + 1, end_ms: index * 500 + 400 };
  const output = (pcm: string) => provider === "gemini" ? { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: "audio/pcm;rate=24000" } }] } } }
    : { type: "session.output_audio.delta", delta: pcm };
  const upstreamPcm = () => s.upstream.flatMap(frame => provider === "gemini" ? frame.realtimeInput?.audio?.data ? [frame.realtimeInput.audio.data] : [] : frame.type === "session.input_audio.append" ? [frame.audio] : []);
  await s.pump([recognize(0, "Find the departure signal note."), native("held-departure")]);
  await expect.poll(async () => { await s.pump(); return s.evidence().tasks[0]?.started; }).toBe(true);
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  await s.pump();
  await s.pump([output(outputPcm(0.8))]);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  const capturedAt = s.mic.captured.length;
  const framesAt = s.socket.frames("conversation_audio").length;
  s.mic.speak();
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(framesAt);
  const initiating = s.mic.captured.slice(capturedAt).find(chunk => chunk.speaking)!;
  expect(initiating, "actual first speaking AudioWorklet block witnessed before client callback").toBeDefined();
  const first = s.socket.frames("conversation_audio").slice(framesAt).find(frame => frame.pcm === initiating.pcm);
  expect(first, "INITIATING_PCM_RETAINED_BYTE_FOR_BYTE").toBeDefined();
  await s.pump([output(outputPcm(0.1)), native("queued-route")]);
  expect(upstreamPcm(), "INITIATING_PCM_REACHED_ACTUAL_ADAPTER").toContain(initiating.pcm);
  expect(s.client.state.getState().micOn).toBe(true);
  expect(s.client.state.getState().playing).toBe(false);
  expect(s.evidence().tasks).toHaveLength(1);
  expect(s.evidence().tasks[0].completed).toBe(false);
  expect(s.evidence().effect).toBe(false);
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  s.mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(2);
  await expect.poll(() => s.client.state.getState().outputRecovery).toBe("audible");
  // Same output identity on GPT; no invented per-answer cancellation boundary.
  await s.pump([output(outputPcm(0.2))]);
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  await expect.poll(() => s.client.state.getState().playing).toBe(false);
  expect(s.mic.opens()).toBe(1);
  const before = s.socket.frames("conversation_audio").length;
  s.mic.speak();
  await expect.poll(() => s.socket.frames("conversation_audio").length).toBeGreaterThan(before);
  await s.pump();
  expect(s.evidence().tasks).toHaveLength(1);
  // Contextual recognition is recent context, not a lifetime manual-review cap.
  for (let batch = 0; batch < 5; batch++) await s.pump(Array.from({ length: 40 }, (_, i) => recognize(1 + batch * 40 + i, "Odysseus discusses the harbour. ".repeat(4))));
  expect(s.client.state.getState().micOn, "CONTEXT_CAPACITY_RETAINS_CAPTURE").toBe(true);
  expect(s.downstream.filter(frame => frame.type === "conversation_closed")).toHaveLength(0);
  expect(s.client.state.getState().unassigned.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.maxFragmentsPerUtterance);
  expect(s.client.state.getState().unassigned.every(f => f.taskContext)).toBe(true);
  s.client.mute();
  const stoppedAt = s.socket.frames("conversation_audio").length;
  await s.pump([output(outputPcm(0.1))]);
  expect(s.client.state.getState().micOn, "manual Mute remains authoritative").toBe(false);
  expect(s.socket.frames("conversation_audio")).toHaveLength(stoppedAt);
  s.client.leave();
  await s.pump();
  expect(s.client.state.getState().active).toBe(false);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.evidence().tasks).toHaveLength(1);
  expect(s.evidence().effect).toBe(false);
});

for (const provider of ["gemini", "gpt"] as const) for (const ending of ["recover", "mute", "leave"] as const) test(`${provider} hidden actual replacement ${ending}: retained host conversation, no replay and truthful capture`, async ctx => {
  const s = await contextualScene(ctx, provider);
  const conversationId = s.client.state.getState().profile!.conversationId;
  const firstEpoch = s.client.state.getState().profile!.epoch;
  await s.pump([provider === "gemini" ? { goAway: {} } : { type: "session.closed", reason: "remote_hangup" }]);
  await expect.poll(async () => { if (s.socket.frames("conversation_start").length < 2) await s.pump(); return s.socket.frames("conversation_start").length; }).toBe(2);
  const hidden = hidePage(); ctx.onTestFinished(() => hidden.show());
  if (ending === "mute") s.client.mute();
  if (ending === "leave") s.client.leave();
  await s.pump();
  if (ending !== "leave") {
    expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true), "HIDDEN_OPENING_RETAINS_REAL_HOST_CONVERSATION").toHaveLength(0);
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().profile?.epoch; }).toBeGreaterThan(firstEpoch);
    await s.pump();
    expect(s.client.state.getState().profile?.conversationId).toBe(conversationId);
    expect(s.client.state.getState().micOn).toBe(false);
    expect(s.mic.opens()).toBe(1);
    expect(s.socket.frames("conversation_stop").filter(f => f.resumable !== true), "HIDDEN_OPENING_RETAINS_REAL_HOST_CONVERSATION").toHaveLength(0);
    expect(s.downstream.filter(f => f.type === "error" && f.code === "CONVERSATION_UNKNOWN")).toHaveLength(0);
  }
  hidden.show();
  if (ending === "recover") {
    await expect.poll(async () => { await s.pump(); return s.client.state.getState().micOn; }).toBe(true);
    s.mic.speak();
    await expect.poll(() => s.socket.frames("conversation_audio").some(f => Number(f.epoch) > firstEpoch)).toBe(true);
    await s.pump();
    expect(s.mic.opens()).toBe(2);
    expect(s.downstream.filter(f => f.type === "conversation_closed" && f.reason === "correlation")).toHaveLength(0);
  } else {
    await s.pump();
    expect(s.client.state.getState().micOn).toBe(false);
    expect(s.mic.opens()).toBe(1);
    expect(s.socket.frames("conversation_audio").some(f => Number(f.epoch) > firstEpoch)).toBe(false);
  }
  expect(s.socket.frames("conversation_commit")).toHaveLength(0);
  expect(s.evidence().tasks).toHaveLength(0);
  expect(s.evidence().effect).toBe(false);
});
